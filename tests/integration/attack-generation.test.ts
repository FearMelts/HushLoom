import { afterAll, afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";
import { and, desc, eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { deleteAccount, withdrawConsent } from "@/server/auth/account";
import { hashPassword, type SessionUser } from "@/server/auth/session";
import { demoProvider } from "@/server/ai/providers/demo";
import { getBalance } from "@/server/credits/ledger";
import { closeDb, getDb, getSql } from "@/server/db";
import { consentRecords, generationJobs, generationOutputs, mediaAssets, moderationEvents, uploads, users } from "@/server/db/schema";
import { confirmJob, createDraft } from "@/server/generation/service";
import { processJob } from "@/server/generation/processor";
import { acceptUpload, assetUrl, purgeAssetsNow, purgeDeletedMedia } from "@/server/media";
import { settingsFor } from "@/server/me";
import { closeRedis } from "@/server/redis";
import { scanAsset, setDevScanOverride } from "@/server/safety/scan";
import { devScanProvider } from "@/server/safety/scan/providers/dev";
import type { ScanVerdict } from "@/server/safety/scan/types";
import { storage } from "@/server/storage";
import { key, makeUser, resetDb } from "../helpers";

/**
 * Attack tests for the generation-cluster fixes (R12 above all: a matched output's evidence must
 * survive a failure to record the match). Tests that pass are regression tests for the fix.
 * Tests marked `test.fails` are holes: each one asserts the safe behaviour, fails today, and
 * names the hole in its comment, so the suite stays runnable until someone fixes it.
 */

const ctx = { country: null };
const PASSWORD = "attack-test-password";
const MATCH: ScanVerdict = { status: "matched", provider: "dev", category: "csam", ref: "attack:forced" };

const draftInput = (overrides: Record<string, unknown> = {}) => ({
  idempotencyKey: key(),
  mode: "text_to_image" as const,
  modelKey: "demo-still",
  prompt: "two adults sharing a candlelit toast, warm film grain",
  negativePrompt: "",
  params: { aspectRatio: "1:1" },
  inputAssetIds: [] as string[],
  ...overrides,
});

async function queuedJob(user: SessionUser, overrides: Record<string, unknown> = {}) {
  const draft = await createDraft(user, draftInput(overrides), ctx);
  await confirmJob(user, draft.id, draft.costCredits);
  return draft;
}

const png = () => sharp({ create: { width: 640, height: 640, channels: 3, background: "#553344" } }).png().toBuffer();
const jobRow = async (id: string) => (await getDb().select().from(generationJobs).where(eq(generationJobs.id, id)))[0]!;
const assetRow = async (id: string) => (await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, id)))[0]!;
const userRow = async (id: string) => (await getDb().select().from(users).where(eq(users.id, id)))[0]!;
const ownedAssets = (ownerId: string) => getDb().select().from(mediaAssets).where(eq(mediaAssets.ownerId, ownerId));
const escalationsFor = (assetId: string) =>
  getDb().select().from(moderationEvents).where(and(eq(moderationEvents.subjectId, assetId), eq(moderationEvents.action, "escalate")));
/** Bytes still in storage under the key the row had when it was written, or null when they are gone. */
const storedBytes = (storageKey: string) => storage().get(storageKey).then((b) => b, () => null);
/** The output assets of a user (anything not under uploads/). */
const outputAssetsOf = async (ownerId: string) => (await ownedAssets(ownerId)).filter((a) => !a.storageKey.startsWith("uploads/"));

async function withPassword(user: SessionUser) {
  await getDb().update(users).set({ passwordHash: await hashPassword(PASSWORD) }).where(eq(users.id, user.id));
}

/** Same trigger-based fault injection as generation-hardening.test.ts: the fault fires inside the real statement. */
let injected: { name: string; table: string }[] = [];
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
async function clearFaults() {
  for (const f of injected) {
    await getDb().execute(sql.raw(`drop trigger if exists ${f.name} on ${f.table}`));
    await getDb().execute(sql.raw(`drop function if exists ${f.name}()`));
    await getDb().execute(sql.raw(`drop sequence if exists ${f.name}_n`));
  }
  injected = [];
}

async function lockWaiters(n: number) {
  for (let i = 0; i < 250; i++) {
    const [row] = await getDb().execute<{ n: number }>(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
    if (row!.n >= n) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`fewer than ${n} sessions ever waited on a lock`);
}

/**
 * Makes the dev scanner stop inside its scan until released, then return `verdict`, so a test can
 * act while a scan is in flight (as a slow PhotoDNA call or a long keyframe pass would allow).
 */
function pausedScanner(verdict: ScanVerdict) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const scanning = new Promise<void>((r) => (started = r));
  vi.spyOn(devScanProvider, "scan").mockImplementation(async () => {
    started();
    await gate;
    return verdict;
  });
  return { scanning, release };
}

async function consentOfUpload(assetId: string) {
  const [row] = await getDb().select().from(uploads).where(eq(uploads.assetId, assetId));
  return row!.consentRecordId!;
}

async function newestUpload(userId: string) {
  for (let i = 0; i < 100; i++) {
    const [a] = await getDb()
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.ownerId, userId))
      .orderBy(desc(mediaAssets.createdAt))
      .limit(1);
    if (a) return a;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("upload row never appeared");
}

beforeEach(async () => {
  await resetDb();
  setDevScanOverride(null);
});

afterEach(async () => {
  vi.restoreAllMocks();
  setDevScanOverride(null);
  await clearFaults();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("attack R12 (output path): a matched output survives every way recording can fail", () => {
  it("two outputs, the first clean and the second matched with recording failing: the clean one is discarded, the matched one is kept and held", async () => {
    const u = await makeUser({ credits: 50 });
    // The provider returns two images; the scanner clears the first and matches the second.
    const original = demoProvider.execute.bind(demoProvider);
    vi.spyOn(demoProvider, "execute").mockImplementation(async (req, c) => [
      ...(await original(req, c)),
      ...(await original({ ...req, params: { ...req.params, seed: 99 } }, c)),
    ]);
    let n = 0;
    setDevScanOverride((input) => (input.mime === "image/webp" ? (++n === 1 ? "clean" : "matched") : null));
    await injectFault("atk_two_escalate", "moderation_events", "new.action = 'escalate'");
    const draft = await queuedJob(u);
    await processJob(draft.id);

    expect(n).toBe(2);
    expect(await jobRow(draft.id)).toMatchObject({ status: "failed", failureCode: "content_blocked" });
    expect(await getBalance(u.id)).toEqual({ available: 50, reserved: 0 });
    const assets = await outputAssetsOf(u.id);
    expect(assets).toHaveLength(2);
    const held = assets.filter((a) => a.legalHold);
    const gone = assets.filter((a) => !a.legalHold);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ deletedAt: null, scanStatus: "pending" });
    expect(await storedBytes(held[0]!.storageKey)).not.toBeNull();
    expect(gone).toHaveLength(1);
    expect(gone[0]!.scanStatus).toBe("clean");
    expect(gone[0]!.storageKey).toMatch(/^purged\//);
  });

  it("a matched video output with recording failing is kept and held, and no poster frame is made from it", async () => {
    const u = await makeUser({ credits: 200 });
    setDevScanOverride((input) => (input.mime === "video/mp4" ? "matched" : null));
    await injectFault("atk_video_escalate", "moderation_events", "new.action = 'escalate'");
    const draft = await queuedJob(u, {
      mode: "text_to_video",
      modelKey: "demo-motion",
      params: { aspectRatio: "9:16", durationS: 3, cameraMovement: "slow push in", motionIntensity: 4 },
    });
    await processJob(draft.id);

    expect(await jobRow(draft.id)).toMatchObject({ status: "failed", failureCode: "content_blocked" });
    const assets = await outputAssetsOf(u.id);
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({ kind: "video", legalHold: true, deletedAt: null, scanStatus: "pending" });
    expect(await storedBytes(assets[0]!.storageKey)).not.toBeNull();
    expect(await assetUrl(assets[0]!, u.id)).toBeNull();
  });

  it("a fault on the suspension or on the account flag (not the escalation) is handled the same way", async () => {
    for (const [name, table, when] of [
      ["atk_suspend", "users", "new.status = 'suspended'"],
      ["atk_flag", "account_flags", "true"],
    ] as const) {
      const u = await makeUser({ credits: 50 });
      setDevScanOverride((input) => (input.mime === "image/webp" ? "matched" : null));
      await injectFault(name, table, when);
      const draft = await queuedJob(u);
      await processJob(draft.id);
      await clearFaults();

      expect(await jobRow(draft.id)).toMatchObject({ status: "failed", failureCode: "content_blocked" });
      const [asset] = await outputAssetsOf(u.id);
      expect(asset).toMatchObject({ legalHold: true, deletedAt: null, scanStatus: "pending" });
      expect(await storedBytes(asset!.storageKey)).not.toBeNull();
      // The rolled-back attempts left nothing half-written.
      expect(await escalationsFor(asset!.id)).toHaveLength(0);
      expect((await userRow(u.id)).status).toBe("active");
    }
  });

  it("retry boundary: two failures are recovered on the third attempt; three failures fall back to the hold", async () => {
    const recovered = await makeUser({ credits: 50 });
    setDevScanOverride((input) => (input.mime === "image/webp" ? "matched" : null));
    await injectFault("atk_twice", "moderation_events", "new.action = 'escalate'", 2);
    const d1 = await queuedJob(recovered);
    await processJob(d1.id);
    await clearFaults();
    const [a1] = await outputAssetsOf(recovered.id);
    expect(a1).toMatchObject({ scanStatus: "matched", legalHold: true, deletedAt: null });
    expect(await escalationsFor(a1!.id)).toHaveLength(1);
    expect((await userRow(recovered.id)).status).toBe("suspended");

    const fallback = await makeUser({ credits: 50 });
    await injectFault("atk_thrice", "moderation_events", "new.action = 'escalate'", 3);
    const d2 = await queuedJob(fallback);
    await processJob(d2.id);
    await clearFaults();
    const [a2] = await outputAssetsOf(fallback.id);
    expect(a2).toMatchObject({ scanStatus: "pending", legalHold: true, deletedAt: null });
    expect(await storedBytes(a2!.storageKey)).not.toBeNull();
    expect(await jobRow(d2.id)).toMatchObject({ status: "failed", failureCode: "content_blocked" });
  });

  it("the owner deletes the account while the output is being scanned: the match is still recorded and no purge removes it", async () => {
    const u = await makeUser({ credits: 50 });
    await withPassword(u);
    vi.spyOn(devScanProvider, "scan").mockImplementation(async () => {
      await deleteAccount(u.id, PASSWORD);
      return MATCH;
    });
    const draft = await queuedJob(u);
    await processJob(draft.id);

    const [asset] = await outputAssetsOf(u.id);
    expect(asset).toMatchObject({ scanStatus: "matched", legalHold: true });
    // Account deletion soft-deleted it before the hold landed; the hold still keeps every purge away.
    expect(await purgeAssetsNow([asset!.id])).toBe(0);
    expect(await purgeDeletedMedia(0)).toBe(0);
    expect(await storedBytes(asset!.storageKey)).not.toBeNull();
    expect(await escalationsFor(asset!.id)).toHaveLength(1);
    expect((await jobRow(draft.id)).status).toBe("cancelled");
    expect(await getBalance(u.id)).toEqual({ available: 50, reserved: 0 });
  });

  it("the owner withdraws the input upload's consent while the output is being scanned: the matched output is kept", async () => {
    const u = await makeUser({ credits: 50 });
    const up = await acceptUpload(u.id, { bytes: await png(), declaredMime: "image/png" }, { statement: "x", subjectLabel: null }, "source");
    const consentId = await consentOfUpload(up.assetId);
    const draft = await queuedJob(u, { mode: "image_to_image", inputAssetIds: [up.assetId] });
    vi.spyOn(devScanProvider, "scan").mockImplementation(async () => {
      await withdrawConsent(u.id, consentId);
      return MATCH;
    });
    await processJob(draft.id);

    // The source upload itself is purged by the withdrawal, as it should be; the output is what matters.
    expect((await assetRow(up.assetId)).storageKey).toMatch(/^purged\//);
    const [out] = (await outputAssetsOf(u.id)).filter((a) => a.id !== up.assetId);
    expect(out).toMatchObject({ scanStatus: "matched", legalHold: true, deletedAt: null });
    expect(await storedBytes(out!.storageKey)).not.toBeNull();
    expect(await escalationsFor(out!.id)).toHaveLength(1);
    expect(await getDb().select().from(generationOutputs).where(eq(generationOutputs.jobId, draft.id))).toHaveLength(0);
    expect(await getBalance(u.id)).toEqual({ available: 50, reserved: 0 });
    expect((await jobRow(draft.id)).status).toBe("cancelled");
  });

  it("an output held by the fallback stays held through a backfill rescan while the scanner is down, account deletion and every purge", async () => {
    const u = await makeUser({ credits: 50 });
    await withPassword(u);
    setDevScanOverride((input) => (input.mime === "image/webp" ? "matched" : null));
    await injectFault("atk_backfill_escalate", "moderation_events", "new.action = 'escalate'");
    const draft = await queuedJob(u);
    await processJob(draft.id);
    await clearFaults();
    const [asset] = await outputAssetsOf(u.id);
    expect(asset).toMatchObject({ scanStatus: "pending", legalHold: true });

    // scripts/scan-backfill.ts runs while the scanner is out.
    setDevScanOverride(() => "unavailable");
    const bytes = (await storedBytes(asset!.storageKey))!;
    expect(await scanAsset({ assetId: asset!.id, bytes, mime: asset!.mime, kind: asset!.kind, sha256: asset!.sha256, ownerId: asset!.ownerId, origin: "backfill" })).toBe("unavailable");
    await deleteAccount(u.id, PASSWORD);
    expect(await purgeAssetsNow([asset!.id])).toBe(0);
    expect(await purgeDeletedMedia(0)).toBe(0);
    const after = await assetRow(asset!.id);
    expect(after).toMatchObject({ legalHold: true, deletedAt: null, scanStatus: "unavailable" });
    expect(await storedBytes(after.storageKey)).not.toBeNull();
    expect(await assetUrl(after, u.id)).toBeNull();
  });

  // HOLE (residual, low likelihood): when both the match transaction and the fallback hold fail
  // (generation.match_hold_failed), the output is left pending with legal_hold=false. Nothing marks
  // it as evidence in the database, so the owner's account deletion soft-deletes it and the 30-day
  // retention purge (worker: purgeDeletedMedia(30)) deletes the bytes unless an operator ran
  // scripts/scan-backfill.ts within the window. Shown here with a zero-day window.
  test.fails("HOLE: after a double fault, account deletion plus the retention purge deletes the unrecorded evidence", async () => {
    const u = await makeUser({ credits: 50 });
    await withPassword(u);
    setDevScanOverride((input) => (input.mime === "image/webp" ? "matched" : null));
    await injectFault("atk_double", "media_assets", "new.legal_hold");
    const draft = await queuedJob(u);
    await processJob(draft.id);
    await clearFaults();
    const [asset] = await outputAssetsOf(u.id);
    expect(asset).toMatchObject({ scanStatus: "pending", legalHold: false, deletedAt: null });

    await deleteAccount(u.id, PASSWORD);
    await purgeDeletedMedia(0);
    expect(await storedBytes(asset!.storageKey)).not.toBeNull();
  });
});

describe("attack R12 (upload entry point): the same evidence on the upload path", () => {
  // HOLE: acceptUpload calls scanAsset once, with no retry and no fallback hold (media.ts:105). When
  // recording the match fails, the upload is left pending with legal_hold=false and the request
  // fails with a 500. The uploader can then withdraw the upload's consent
  // (DELETE /api/me/consents/:id), which soft-deletes it and purges the bytes at once: no hold,
  // no escalation, no suspension. The fix covered only the generation worker.
  test.fails("HOLE: a fault while recording an upload's match, then a consent withdrawal, purges the matched upload", async () => {
    const u = await makeUser({ credits: 50 });
    setDevScanOverride((input) => (input.mime === "image/webp" ? "matched" : null));
    await injectFault("atk_upload_escalate", "moderation_events", "new.action = 'escalate'");
    const attempt = await acceptUpload(u.id, { bytes: await png(), declaredMime: "image/png" }, { statement: "x", subjectLabel: null }, "source").then(
      () => "accepted",
      (err: { code?: string }) => err.code ?? "error",
    );
    expect(attempt).not.toBe("accepted");
    await clearFaults();
    const asset = await newestUpload(u.id);

    await withdrawConsent(u.id, await consentOfUpload(asset.id));
    expect(await storedBytes(asset.storageKey)).not.toBeNull();
    expect((await assetRow(asset.id)).storageKey).toBe(asset.storageKey);
  });

  // HOLE: an upload is committed (asset + uploads + consent rows) before it is scanned, and its
  // consent can be withdrawn while the scan is still running. withdrawConsent soft-deletes the
  // still-pending asset (legal_hold=false) and purgeAssetsNow deletes the bytes immediately; the
  // match is recorded a moment later on a row whose file is already gone (storage_key 'purged/…').
  // No fault is needed: the uploader alone controls both requests (GET /api/me lists the new
  // consent id while POST /api/uploads is still scanning). Present before and after the R12 fix.
  test.fails("HOLE: withdrawing an upload's consent while its scan is in flight destroys the matched bytes", async () => {
    const u = await makeUser({ credits: 50 });
    const scan = pausedScanner(MATCH);
    const upload = acceptUpload(u.id, { bytes: await png(), declaredMime: "image/png" }, { statement: "x", subjectLabel: null }, "source").then(
      () => "accepted",
      (err: { code?: string }) => err.code ?? "error",
    );
    await scan.scanning;
    const asset = await newestUpload(u.id);
    // What GET /api/me (settingsFor) shows the uploader while POST /api/uploads is still scanning.
    const [listed] = (await settingsFor(u.id)).consents;
    expect(listed!.id).toBe(await consentOfUpload(asset.id));
    await withdrawConsent(u.id, listed!.id);
    scan.release();
    expect(await upload).toBe("upload_rejected");

    const after = await assetRow(asset.id);
    expect(after).toMatchObject({ scanStatus: "matched", legalHold: true });
    expect(await escalationsFor(asset.id)).toHaveLength(1);
    // The evidence itself:
    expect(after.storageKey).toBe(asset.storageKey);
    expect(await storedBytes(asset.storageKey)).not.toBeNull();
  });

  // HOLE (regression introduced by the R12 fix): recordVerdict now takes SELECT ... FOR UPDATE on
  // the owner's users row before the asset row (scan/index.ts:162). withdrawConsent locks the
  // upload's asset row (UPDATE media_assets) and then inserts its audit row, whose actor_id foreign
  // key takes FOR KEY SHARE on the same users row, which conflicts with FOR UPDATE. The two now
  // deadlock, and Postgres aborts the match transaction: the upload request fails with a 500, no
  // escalation is opened, the owner is not suspended, and the withdrawal then purges the bytes.
  // With the pre-fix order (asset first) the match waited for the withdrawal and was recorded.
  test.fails("HOLE: the new users-first lock deadlocks the upload's match with a concurrent consent withdrawal", async () => {
    const u = await makeUser({ credits: 50 });
    const scan = pausedScanner(MATCH);
    const upload = acceptUpload(u.id, { bytes: await png(), declaredMime: "image/png" }, { statement: "x", subjectLabel: null }, "source").then(
      () => "accepted",
      (err: { code?: string; message?: string }) => err.code ?? err.message ?? "error",
    );
    await scan.scanning;
    const asset = await newestUpload(u.id);
    const consentId = await consentOfUpload(asset.id);
    let withdrawal: Promise<string> = Promise.resolve("not started");
    // Another session holds audit_logs so the withdrawal stops right after locking the asset row,
    // then the scan finishes and the match transaction starts.
    await getSql().begin(async (a) => {
      await a`lock table audit_logs in share mode`;
      withdrawal = withdrawConsent(u.id, consentId).then(
        () => "withdrawn",
        (err: Error) => err.message,
      );
      await lockWaiters(1);
      scan.release();
      await lockWaiters(2);
    });
    const [uploadOutcome] = await Promise.all([upload, withdrawal]);

    expect(uploadOutcome).toBe("upload_rejected");
    expect(await escalationsFor(asset.id)).toHaveLength(1);
    expect((await userRow(u.id)).status).toBe("suspended");
  });
});

describe("attack R12: what an uploader can see while a scan runs", () => {
  it("GET /api/me (settingsFor) lists the new upload's consent id before the scan returns", async () => {
    const u = await makeUser({ credits: 50 });
    const scan = pausedScanner({ status: "clean", provider: "dev", ref: "attack:clean" });
    const upload = acceptUpload(u.id, { bytes: await png(), declaredMime: "image/png" }, { statement: "x", subjectLabel: null }, "source");
    await scan.scanning;
    const asset = await newestUpload(u.id);
    const listed = (await settingsFor(u.id)).consents;
    const [row] = await getDb().select().from(consentRecords).where(eq(consentRecords.userId, u.id));
    expect(listed.map((c) => c.id)).toEqual([row!.id]);
    expect(row!.id).toBe(await consentOfUpload(asset.id));
    scan.release();
    await upload;
  });
});
