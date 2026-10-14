import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { closeDb, getDb } from "@/server/db";
import { mediaAssets } from "@/server/db/schema";
import { purgeDeletedMedia } from "@/server/media";
import { closeRedis } from "@/server/redis";
import { recordVerdict } from "@/server/safety/scan";
import type { ScanVerdict } from "@/server/safety/scan/types";
import { sha256, storage } from "@/server/storage";
import { makeUser, resetDb } from "../helpers";

async function storedAsset(ownerId: string, values: Partial<typeof mediaAssets.$inferInsert> = {}) {
  const bytes = Buffer.from(`asset ${randomUUID()}`);
  const key = `outputs/${ownerId}/${randomUUID()}.webp`;
  await storage().put(key, bytes, "image/webp");
  const [a] = await getDb()
    .insert(mediaAssets)
    .values({ ownerId, kind: "image", storageKey: key, mime: "image/webp", bytes: bytes.length, sha256: sha256(bytes), ...values })
    .returning();
  return a!;
}

beforeEach(async () => {
  await resetDb();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("verdict and purge writes keep evidence (R42)", () => {
  it("a later non-match verdict never overwrites a match", async () => {
    const u = await makeUser();
    const a = await storedAsset(u.id);
    const subject = { assetId: a.id, mime: a.mime, kind: "image" as const, sha256: a.sha256, ownerId: u.id };
    // The backfill finds a match first; the live scan then comes back unavailable (or clean).
    expect(await recordVerdict({ ...subject, origin: "backfill" }, { status: "matched", provider: "dev", category: "csam", ref: "test" })).toBe("matched");
    const later: ScanVerdict[] = [
      { status: "unavailable", provider: "dev", detail: "scanner timed out" },
      { status: "clean", provider: "dev", ref: "dev:no-match" },
    ];
    for (const verdict of later) {
      // The caller learns the asset is matched, so the upload path never discards the evidence as unscanned.
      expect(await recordVerdict({ ...subject, origin: "upload" }, verdict)).toBe("matched");
      const [row] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, a.id));
      expect(row).toMatchObject({ scanStatus: "matched", legalHold: true, scanRef: "test" });
    }
  });

  it("the purge re-checks the hold on each asset just before it deletes the file", async () => {
    const u = await makeUser();
    const old = new Date(Date.now() - 40 * 86_400_000);
    const assets = [await storedAsset(u.id, { deletedAt: old }), await storedAsset(u.id, { deletedAt: old })];
    // While the hourly purge works through its batch, an admin puts the not-yet-purged asset on hold.
    const del = storage().delete.bind(storage());
    let held: string[] = [];
    vi.spyOn(storage(), "delete").mockImplementation(async (key: string) => {
      if (!held.length) {
        held = assets.filter((a) => a.storageKey !== key).map((a) => a.id);
        await getDb().update(mediaAssets).set({ legalHold: true }).where(inArray(mediaAssets.id, held));
      }
      return del(key);
    });
    expect(await purgeDeletedMedia(30)).toBe(1);
    const [kept] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, held[0]!));
    expect(kept).toMatchObject({ legalHold: true, storageKey: assets.find((a) => a.id === held[0])!.storageKey });
    expect((await storage().get(kept!.storageKey)).length).toBe(kept!.bytes);
  });
});
