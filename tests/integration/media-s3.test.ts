import { randomUUID } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { GET as mediaRoute } from "@/app/api/media/route";
import { closeDb, getDb } from "@/server/db";
import { mediaAssets } from "@/server/db/schema";
import { assetUrl } from "@/server/media";
import { closeRedis } from "@/server/redis";
import { sha256, storage } from "@/server/storage";
import { makeUser, resetDb } from "../helpers";

// This file runs the app with STORAGE_DRIVER=s3. env() reads process.env lazily, the first time it
// is called, and each test file gets its own module registry, so these stubs apply before it is read.
vi.stubEnv("STORAGE_DRIVER", "s3");
vi.stubEnv("S3_BUCKET", "hl-test-bucket");
vi.stubEnv("S3_REGION", "us-east-1");
vi.stubEnv("S3_ENDPOINT", "http://s3.invalid");
vi.stubEnv("S3_ACCESS_KEY_ID", "test-access-key");
vi.stubEnv("S3_SECRET_ACCESS_KEY", "test-secret-key");

/** An in-memory bucket in place of S3: nothing leaves the process. */
const bucket = new Map<string, Buffer>();
const sent: string[] = [];
vi.spyOn(S3Client.prototype, "send").mockImplementation((async (cmd: unknown) => {
  if (cmd instanceof PutObjectCommand) {
    sent.push(`put ${cmd.input.Key}`);
    bucket.set(cmd.input.Key!, Buffer.from(cmd.input.Body as Buffer));
    return {};
  }
  if (cmd instanceof GetObjectCommand) {
    sent.push(`get ${cmd.input.Key}${cmd.input.Range ? ` ${cmd.input.Range}` : ""}`);
    const all = bucket.get(cmd.input.Key!);
    if (!all) throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey" });
    const m = cmd.input.Range?.match(/^bytes=(\d+)-(\d+)$/);
    const body = m ? all.subarray(Number(m[1]), Math.min(Number(m[2]), all.length - 1) + 1) : all;
    return {
      ContentLength: body.length,
      ...(m ? { ContentRange: `bytes ${m[1]}-${Number(m[1]) + body.length - 1}/${all.length}` } : {}),
      Body: { transformToByteArray: async () => new Uint8Array(body), transformToWebStream: () => new Response(new Uint8Array(body)).body },
    };
  }
  if (cmd instanceof HeadObjectCommand) {
    sent.push(`head ${cmd.input.Key}`);
    const all = bucket.get(cmd.input.Key!);
    if (!all) throw Object.assign(new Error("Not Found"), { name: "NotFound" });
    return { ContentLength: all.length };
  }
  if (cmd instanceof DeleteObjectCommand) {
    sent.push(`delete ${cmd.input.Key}`);
    bucket.delete(cmd.input.Key!);
    return {};
  }
  throw new Error(`unexpected S3 command ${(cmd as object).constructor.name}`);
}) as never);

const getMedia = (url: string) => mediaRoute(new NextRequest(new URL(url, "http://localhost")));

async function publicAsset(ownerId: string) {
  const bytes = Buffer.from(`public template preview ${randomUUID()}`.repeat(64));
  const key = `templates/${ownerId}/${randomUUID()}.webp`;
  await storage().put(key, bytes, "image/webp");
  const [a] = await getDb()
    .insert(mediaAssets)
    .values({ ownerId, kind: "image", storageKey: key, mime: "image/webp", bytes: bytes.length, sha256: sha256(bytes), visibility: "public", scanStatus: "clean" })
    .returning();
  return { asset: a!, bytes };
}

beforeEach(async () => {
  await resetDb();
  bucket.clear();
  sent.length = 0;
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("S3 media links stop working when the asset is removed (R13)", () => {
  it("serves S3 media through /api/media, which re-checks the asset on every request", async () => {
    const u = await makeUser();
    const { asset, bytes } = await publicAsset(u.id);
    expect(sent).toEqual([`put ${asset.storageKey}`]);

    // A visitor is handed a link while the template is live.
    const url = await assetUrl(asset, null);
    expect(url).toMatch(/^\/api\/media\?/);
    const live = await getMedia(url!);
    expect(live.status).toBe(200);
    expect(Buffer.from(await live.arrayBuffer()).equals(bytes)).toBe(true);

    // A CSAM takedown keeps the object as evidence (legal hold) and soft-deletes the row.
    await getDb().update(mediaAssets).set({ deletedAt: new Date(), legalHold: true }).where(eq(mediaAssets.id, asset.id));
    expect(bucket.has(asset.storageKey)).toBe(true);
    // The same link, still inside its TTL, no longer serves the bytes.
    expect((await getMedia(url!)).status).toBe(404);
  });

  it("a link issued before a later scan match stops serving at once", async () => {
    const u = await makeUser();
    const { asset } = await publicAsset(u.id);
    const url = await assetUrl(asset, null);
    expect((await getMedia(url!)).status).toBe(200);
    await getDb().update(mediaAssets).set({ scanStatus: "matched", legalHold: true }).where(eq(mediaAssets.id, asset.id));
    expect((await getMedia(url!)).status).toBe(404);
  });

  it("never hands out a direct bucket URL", async () => {
    const u = await makeUser();
    const { asset } = await publicAsset(u.id);
    const own = await assetUrl({ ...asset, visibility: "private" }, u.id);
    for (const url of [await assetUrl(asset, null), own, await storage().signedUrl(asset.storageKey, 300, { download: "x.webp" })]) {
      expect(url).not.toMatch(/s3\.invalid|X-Amz-/i);
      expect(url).toMatch(/^\/api\/media\?/);
    }
  });
});

describe("S3 media range requests fetch only the range (R29)", () => {
  it("asks the bucket for one byte when the browser asks for one byte", async () => {
    const u = await makeUser();
    const { asset, bytes } = await publicAsset(u.id);
    const url = await assetUrl(asset, null);
    sent.length = 0;
    const res = await mediaRoute(new NextRequest(new URL(url!, "http://localhost"), { headers: { range: "bytes=0-0" } }));
    expect(res.status).toBe(206);
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes.subarray(0, 1))).toBe(true);
    expect(sent).toContain(`get ${asset.storageKey} bytes=0-0`);
    expect(sent).not.toContain(`get ${asset.storageKey}`);
  });
});
