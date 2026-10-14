import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { SessionUser } from "@/server/auth/session";
import { getBalance } from "@/server/credits/ledger";
import { closeDb, getDb, getSql } from "@/server/db";
import { generationJobs, generationOutputs, mediaAssets, moderationEvents, users } from "@/server/db/schema";
import { confirmJob, createDraft } from "@/server/generation/service";
import { processJob } from "@/server/generation/processor";
import { getCreation } from "@/server/generation/views";
import { assetUrl, purgeAssetsNow } from "@/server/media";
import { closeRedis } from "@/server/redis";
import { recordVerdict, scanAsset, setDevScanOverride } from "@/server/safety/scan";
import { sha256, storage } from "@/server/storage";
import { key, makeUser, resetDb } from "../helpers";

const ctx = { country: null };

const draftInput = (overrides: Record<string, unknown> = {}) => ({
  idempotencyKey: key(),
  mode: "text_to_image" as const,
  modelKey: "demo-still",
  prompt: "two adults sharing a candlelit toast, warm film grain",
  negativePrompt: "",
  params: { aspectRatio: "1:1" },
  inputAssetIds: [],
  ...overrides,
});

async function queuedJob(user: SessionUser, overrides: Record<string, unknown> = {}) {
  const draft = await createDraft(user, draftInput(overrides), ctx);
  await confirmJob(user, draft.id, draft.costCredits);
  return draft;
}

const jobRow = async (id: string) => (await getDb().select().from(generationJobs).where(eq(generationJobs.id, id)))[0]!;
/** Every asset the user owns: these tests make one output and nothing else, so a purged one still shows. */
const outputAssets = (ownerId: string) => getDb().select().from(mediaAssets).where(eq(mediaAssets.ownerId, ownerId));

/**
 * Database faults injected with a trigger, so they happen inside the real statements the code runs
 * (as a connection reset, a statement timeout or a deadlock would). The sequence is not
 * transactional, so "the first N times" survives the rollback the fault causes.
 */
async function injectFault(name: string, table: string, when: string, times = 1_000_000) {
  await getDb().execute(sql.raw(`create sequence ${name}_n`));
  await getDb().execute(
    sql.raw(`create function ${name}() returns trigger language plpgsql as $$
      begin
        if nextval('${name}_n') <= ${times} then raise exception 'injected fault: ${name}'; end if;
        return new;
      end $$`),
  );
  await getDb().execute(sql.raw(`create trigger ${name} before insert or update on ${table} for each row when (${when}) execute function ${name}()`));
  injected.push({ name, table });
}
let injected: { name: string; table: string }[] = [];
async function clearFaults() {
  for (const f of injected) {
    await getDb().execute(sql.raw(`drop trigger if exists ${f.name} on ${f.table}`));
    await getDb().execute(sql.raw(`drop function if exists ${f.name}()`));
    await getDb().execute(sql.raw(`drop sequence if exists ${f.name}_n`));
  }
  injected = [];
}

beforeEach(async () => {
  await resetDb();
  setDevScanOverride(null);
});

afterEach(async () => {
  setDevScanOverride(null);
  await clearFaults();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("R12: a fault while recording an output's scanner match", () => {
  const matchOutputs = () => setDevScanOverride((input) => (input.mime === "image/webp" ? "matched" : null));

  it("keeps the matched file, holds it unserved, fails the job, and a rescan opens the case", async () => {
    const u = await makeUser({ credits: 50 });
    matchOutputs();
    // Every attempt to open the review case fails, so the match transaction rolls back each time.
    await injectFault("r12_escalate", "moderation_events", "new.action = 'escalate'");
    const draft = await queuedJob(u);
    await processJob(draft.id);

    // The evidence is still there: not deleted, not purged, bytes intact, held, never served.
    const [asset] = await outputAssets(u.id);
    expect(asset).toBeDefined();
    expect(asset).toMatchObject({ deletedAt: null, legalHold: true });
    expect(asset!.storageKey).toMatch(/^outputs\//);
    expect((await storage().get(asset!.storageKey)).length).toBe(asset!.bytes);
    expect(asset!.scanStatus).not.toBe("clean");
    expect(await assetUrl(asset!, u.id)).toBeNull();
    expect(await purgeAssetsNow([asset!.id])).toBe(0);

    // The job fails as a block, refunded like any matched output, with nothing to show.
    const job = await jobRow(draft.id);
    expect(job.status).toBe("failed");
    expect(job.failureCode).toBe("content_blocked");
    expect(await getBalance(u.id)).toEqual({ available: 50, reserved: 0 });
    expect(await getDb().select().from(generationOutputs).where(eq(generationOutputs.jobId, draft.id))).toHaveLength(0);
    expect((await getCreation(u.id, draft.id))!.output).toBeNull();

    // Left pending, so the scan backfill (scripts/scan-backfill.ts) rescans it and opens the case.
    expect(asset!.scanStatus).toBe("pending");
    await clearFaults();
    const bytes = await storage().get(asset!.storageKey);
    expect(await scanAsset({ assetId: asset!.id, bytes, mime: asset!.mime, kind: asset!.kind, sha256: asset!.sha256, ownerId: asset!.ownerId, origin: "backfill" })).toBe("matched");
    const [esc] = await getDb().select().from(moderationEvents).where(eq(moderationEvents.action, "escalate"));
    expect(esc).toMatchObject({ subjectId: asset!.id, status: "open" });
    expect((await getDb().select().from(users).where(eq(users.id, u.id)))[0]!.status).toBe("suspended");
  });

  it("retries a transient fault (such as a deadlock) and opens the case in the same run", async () => {
    const u = await makeUser({ credits: 50 });
    matchOutputs();
    await injectFault("r12_escalate_once", "moderation_events", "new.action = 'escalate'", 1);
    const draft = await queuedJob(u);
    await processJob(draft.id);

    expect(await jobRow(draft.id)).toMatchObject({ status: "failed", failureCode: "content_blocked" });
    const [asset] = await outputAssets(u.id);
    expect(asset).toMatchObject({ scanStatus: "matched", legalHold: true, deletedAt: null });
    expect((await storage().get(asset!.storageKey)).length).toBe(asset!.bytes);
    const escalations = await getDb().select().from(moderationEvents).where(eq(moderationEvents.action, "escalate"));
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({ subjectId: asset!.id, reason: "csam_match" });
    expect((await getDb().select().from(users).where(eq(users.id, u.id)))[0]!.status).toBe("suspended");
  });

  it("does not deadlock with an account deletion that already holds the owner's row", async () => {
    const u = await makeUser({ credits: 50 });
    const bytes = Buffer.from("matched-output-bytes");
    const [asset] = await getDb()
      .insert(mediaAssets)
      .values({ ownerId: u.id, kind: "image", storageKey: `outputs/${u.id}/${key()}.webp`, mime: "image/webp", bytes: bytes.length, sha256: sha256(bytes) })
      .returning();
    const waitingOnLocks = async () => {
      for (let i = 0; i < 100; i++) {
        const [row] = await getDb().execute<{ n: number }>(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
        if (row!.n > 0) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error("the match transaction never waited on the owner's row");
    };
    let outcome: Promise<unknown> = Promise.resolve();
    // The statements deleteAccount runs, in its order: the users row first, then the owner's media.
    await getSql().begin(async (a) => {
      await a`update users set status = 'deleted', updated_at = now() where id = ${u.id}`;
      outcome = recordVerdict(
        { assetId: asset!.id, mime: asset!.mime, kind: "image", sha256: asset!.sha256, ownerId: u.id, origin: "output" },
        { status: "matched", provider: "dev", ref: "r12", category: "csam" },
      ).then(
        (status) => status,
        (err: Error) => err,
      );
      await waitingOnLocks();
      await a`update media_assets set deleted_at = now() where owner_id = ${u.id} and legal_hold = false`;
    });
    expect(await outcome).toBe("matched");
    const [held] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, asset!.id));
    expect(held).toMatchObject({ scanStatus: "matched", legalHold: true });
    expect(await getDb().select().from(moderationEvents).where(eq(moderationEvents.subjectId, asset!.id))).toHaveLength(1);
  });

  it("never deletes the matched bytes even when nothing about the match can be written", async () => {
    const u = await makeUser({ credits: 50 });
    matchOutputs();
    // Neither the match transaction nor a fallback hold can set legal_hold.
    await injectFault("r12_hold", "media_assets", "new.legal_hold");
    const draft = await queuedJob(u);
    await processJob(draft.id);

    expect((await jobRow(draft.id)).status).toBe("failed");
    expect(await getDb().select().from(generationOutputs).where(eq(generationOutputs.jobId, draft.id))).toHaveLength(0);
    const [asset] = await outputAssets(u.id);
    expect(asset).toBeDefined();
    expect(asset).toMatchObject({ deletedAt: null, scanStatus: "pending" });
    expect(asset!.storageKey).toMatch(/^outputs\//);
    expect((await storage().get(asset!.storageKey)).length).toBe(asset!.bytes);
    expect(await assetUrl(asset!, u.id)).toBeNull();
  });
});
