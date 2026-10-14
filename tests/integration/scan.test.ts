import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";

// Route handlers read the session cookie through next/headers, which only works inside a Next
// request. The tests stand in for that request scope, as tests/integration/age.test.ts does.
const requestScope = vi.hoisted(() => ({ token: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "hl_session" && requestScope.token ? { name, value: requestScope.token } : undefined),
    set: () => undefined,
    delete: () => undefined,
  }),
  headers: async () => new Headers(),
}));

import { POST as reviewAction } from "@/app/api/admin/review/[id]/route";
import { GET as reviewList } from "@/app/api/admin/review/route";
import { POST as takedownAction } from "@/app/api/admin/takedowns/[id]/route";
import { GET as downloadRoute } from "@/app/api/generations/[id]/download/route";
import { GET as mediaRoute } from "@/app/api/media/route";
import { POST as takedownsRoute } from "@/app/api/takedowns/route";
import { POST as uploadsRoute } from "@/app/api/uploads/route";
import { moderationQueue, resolveReport } from "@/server/admin";
import { deleteAccount, registerUser, withdrawConsent } from "@/server/auth/account";
import { createSession, userForToken, type SessionUser } from "@/server/auth/session";
import { getBalance } from "@/server/credits/ledger";
import { closeDb, getDb } from "@/server/db";
import {
  accountFlags,
  auditLogs,
  consentRecords,
  generationJobs,
  generationOutputs,
  mediaAssets,
  moderationEvents,
  takedownRequests,
  templates,
  uploads,
  users,
} from "@/server/db/schema";
import { env } from "@/server/env";
import { confirmJob, createDraft } from "@/server/generation/service";
import { processJob } from "@/server/generation/processor";
import { getCreation } from "@/server/generation/views";
import { acceptUpload, assetUrl, purgeAssetsNow, purgeDeletedMedia } from "@/server/media";
import { clearFlag } from "@/server/payments/service";
import { closeRedis } from "@/server/redis";
import { DEV_SCAN_FIXTURE_SHA256, scanAsset, setDevScanOverride } from "@/server/safety/scan";
import { photoDnaJpeg } from "@/server/safety/scan/providers/photodna";
import { sha256, storage } from "@/server/storage";
import { publishTemplate } from "@/server/templates/publish";
import { key, makeUser, resetDb } from "../helpers";

const ctx = { country: null };
const FIXTURE = path.resolve(__dirname, "../fixtures/scan-drill-match.png");
const fixture = () => readFile(FIXTURE);
const png = (bg = "#553344") => sharp({ create: { width: 640, height: 640, channels: 3, background: bg } }).png().toBuffer();

async function signIn(user: SessionUser) {
  requestScope.token = (await createSession(user.id, null)).token;
}
function signOut() {
  requestScope.token = null;
}

function uploadRequest(bytes: Buffer, type = "image/png") {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], "upload.png", { type }));
  form.set("consent", "true");
  return uploadsRoute(new NextRequest("http://localhost/api/uploads", { method: "POST", body: form }), undefined as never);
}

const getMedia = (url: string) => mediaRoute(new NextRequest(new URL(url, "http://localhost")));
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

async function member(credits = 50) {
  const handle = `m${key().slice(5, 13)}`;
  const password = "long-enough-pass";
  const reg = await registerUser({ email: `${handle}@example.test`, password, handle, displayName: handle, dateOfBirth: "1990-05-05", acceptTerms: true, confirmAdult: true });
  const u = await makeUserRow(reg.id);
  if (credits) {
    const { applyMovement } = await import("@/server/credits/ledger");
    await getDb().transaction((tx) => applyMovement(tx, { userId: u.id, kind: "admin_adjust", availableDelta: credits, reservedDelta: 0, idempotencyKey: `grant:${u.id}` }));
  }
  return { user: u, password };
}

async function makeUserRow(id: string): Promise<SessionUser> {
  const { token } = await createSession(id, null);
  return (await userForToken(token))!;
}

async function makeJob(user: SessionUser, overrides: Record<string, unknown> = {}) {
  const draft = await createDraft(
    user,
    {
      idempotencyKey: key(),
      mode: "text_to_image",
      modelKey: "demo-still",
      prompt: "an adult couple sharing a toast by candlelight, warm film grain",
      negativePrompt: "",
      params: { aspectRatio: "1:1" },
      inputAssetIds: [],
      ...overrides,
    },
    ctx,
  );
  await confirmJob(user, draft.id, draft.costCredits);
  return draft;
}

const jobRow = async (id: string) => (await getDb().select().from(generationJobs).where(eq(generationJobs.id, id)))[0]!;
const assetsOf = (ownerId: string) => getDb().select().from(mediaAssets).where(eq(mediaAssets.ownerId, ownerId));
const filesUnder = async (scope: string, ownerId: string) => {
  try {
    return await readdir(path.resolve(env().STORAGE_LOCAL_DIR, scope, ownerId));
  } catch {
    return [];
  }
};

beforeEach(async () => {
  await resetDb();
  setDevScanOverride(null);
  signOut();
});

afterEach(() => {
  setDevScanOverride(null);
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("dev scanner", () => {
  it("knows the drill fixture by its hash and is labeled as development only", async () => {
    expect(sha256(await fixture())).toBe(DEV_SCAN_FIXTURE_SHA256);
    const { scanSettings } = await import("@/server/safety/scan");
    expect(scanSettings()).toMatchObject({ provider: "dev", isDev: true, failClosed: true, preStorage: true });
  });

  it("an asset with no verdict yet is never served", async () => {
    const u = await makeUser();
    const key = `uploads/${u.id}/${crypto.randomUUID()}.webp`;
    const bytes = await sharp(await png()).webp().toBuffer();
    await storage().put(key, bytes, "image/webp");
    const [a] = await getDb().insert(mediaAssets).values({ ownerId: u.id, kind: "image", storageKey: key, mime: "image/webp", bytes: bytes.length, sha256: sha256(bytes) }).returning();
    expect(a!.scanStatus).toBe("pending");
    expect(await assetUrl(a!, u.id)).toBeNull();
    expect((await getMedia(await storage().signedUrl(key, 300))).status).toBe(404);
    await scanAsset({ assetId: a!.id, bytes, mime: "image/webp", kind: "image", sha256: sha256(bytes), ownerId: u.id, origin: "backfill" });
    const [after] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, a!.id));
    expect(after).toMatchObject({ scanStatus: "clean", scanProvider: "dev" });
    expect((await getMedia((await assetUrl(after!, u.id))!)).status).toBe(200);
  });
});

describe("a matched upload", () => {
  it("is rejected without saying why, never served, held as evidence, and suspends, flags and escalates", async () => {
    const { user: u, password } = await member();
    await signIn(u);
    const sessionToken = requestScope.token!;
    const res = await uploadRequest(await fixture());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({ error: { code: "upload_rejected", message: "This upload was rejected." } });
    expect(JSON.stringify(body)).not.toMatch(/scan|match|csam|abuse/i);

    const [asset] = await assetsOf(u.id);
    expect(asset).toMatchObject({ scanStatus: "matched", legalHold: true, scanProvider: "dev", deletedAt: null });
    // Never served: no signed URL, and even a correctly signed link is a 404.
    expect(await assetUrl(asset!, u.id)).toBeNull();
    expect((await getMedia(await storage().signedUrl(asset!.storageKey, 300))).status).toBe(404);
    expect(await storage().get(asset!.storageKey)).toBeInstanceOf(Buffer);

    // The account is suspended and signed out everywhere, and flagged.
    const [row] = await getDb().select().from(users).where(eq(users.id, u.id));
    expect(row!.status).toBe("suspended");
    expect(await userForToken(sessionToken)).toBeNull();
    const flags = await getDb().select().from(accountFlags).where(eq(accountFlags.userId, u.id));
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ kind: "csam_match", clearedAt: null });

    // The human review queue entry, and an audit row for the block and the suspension.
    const [esc] = await getDb().select().from(moderationEvents).where(eq(moderationEvents.action, "escalate"));
    expect(esc).toMatchObject({ subjectType: "upload", subjectId: asset!.id, status: "open", reason: "csam_match" });
    expect(esc!.details).toMatchObject({ assetId: asset!.id, sha256: asset!.sha256, sourceSha256: DEV_SCAN_FIXTURE_SHA256, provider: "dev", origin: "upload" });
    const audits = await getDb().select().from(auditLogs);
    expect(audits.find((a) => a.action === "scan.block" && a.targetId === asset!.id)).toBeTruthy();
    expect(audits.find((a) => a.action === "user.suspend" && a.targetId === u.id)).toBeTruthy();
    // Nothing about the file's contents goes into the audit trail.
    expect(JSON.stringify(audits)).not.toContain(asset!.storageKey);
    // Escalations stay out of the generic report queue and its actions.
    expect(await moderationQueue()).toHaveLength(0);
    const admin = await makeUser({ role: "admin" });
    await expect(resolveReport(admin.id, esc!.id, { action: "dismiss", note: "" })).rejects.toMatchObject({ status: 409, code: "use_review_queue" });
    await expect(clearFlag(admin.id, flags[0]!.id, "nope")).rejects.toMatchObject({ status: 409, code: "use_review_queue" });

    // Held evidence survives consent withdrawal, account deletion and every purge.
    const [up] = await getDb().select().from(uploads).where(eq(uploads.assetId, asset!.id));
    await withdrawConsent(u.id, up!.consentRecordId!);
    await deleteAccount(u.id, password);
    let [held] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, asset!.id));
    expect(held).toMatchObject({ deletedAt: null, legalHold: true, storageKey: asset!.storageKey });
    await getDb().update(mediaAssets).set({ deletedAt: new Date(Date.now() - 90 * 86_400_000) }).where(eq(mediaAssets.id, asset!.id));
    expect(await purgeDeletedMedia(30)).toBe(0);
    expect(await purgeAssetsNow([asset!.id])).toBe(0);
    [held] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, asset!.id));
    expect(held!.storageKey).toBe(asset!.storageKey);
    expect((await storage().get(asset!.storageKey)).length).toBe(asset!.bytes);
  });

  it("a repeat scan of a matched asset does not open a second case", async () => {
    const u = await makeUser();
    await expect(acceptUpload(u.id, { bytes: await fixture(), declaredMime: "image/png" }, { statement: "x", subjectLabel: null }, "source")).rejects.toMatchObject({ status: 403 });
    const [a] = await assetsOf(u.id);
    const bytes = await storage().get(a!.storageKey);
    expect(await scanAsset({ assetId: a!.id, bytes, mime: a!.mime, kind: "image", sha256: a!.sha256, sourceSha256: DEV_SCAN_FIXTURE_SHA256, ownerId: u.id, origin: "backfill" })).toBe("matched");
    expect(await getDb().select().from(moderationEvents).where(eq(moderationEvents.action, "escalate"))).toHaveLength(1);
    expect(await getDb().select().from(accountFlags)).toHaveLength(1);
  });
});

describe("a matched output", () => {
  it("fails the job with credits returned, keeps no output row, and holds the file", async () => {
    const u = await makeUser({ credits: 50 });
    setDevScanOverride((input) => (input.mime === "image/webp" ? "matched" : null));
    const draft = await makeJob(u);
    await processJob(draft.id);

    const job = await jobRow(draft.id);
    expect(job).toMatchObject({ status: "failed", failureCode: "content_blocked" });
    expect(job.failureMessage).toMatch(/credits were returned/);
    expect(await getBalance(u.id)).toEqual({ available: 50, reserved: 0 });
    expect(await getDb().select().from(generationOutputs).where(eq(generationOutputs.jobId, draft.id))).toHaveLength(0);
    expect((await getCreation(u.id, draft.id))!.output).toBeNull();

    const [held] = await getDb().select().from(mediaAssets).where(and(eq(mediaAssets.ownerId, u.id), like(mediaAssets.storageKey, "outputs/%")));
    expect(held).toMatchObject({ scanStatus: "matched", legalHold: true, deletedAt: null });
    expect(await assetUrl(held!, u.id)).toBeNull();
    const [esc] = await getDb().select().from(moderationEvents).where(eq(moderationEvents.action, "escalate"));
    expect(esc).toMatchObject({ subjectType: "output", subjectId: held!.id });
    expect(esc!.details).toMatchObject({ jobId: draft.id, origin: "output", provider: "dev" });
    const [row] = await getDb().select().from(users).where(eq(users.id, u.id));
    expect(row!.status).toBe("suspended");
  });

  it("scans video outputs frame by frame and blocks a match in a keyframe", async () => {
    const u = await makeUser({ credits: 50 });
    // The clip as a whole passes; one of its keyframes (PNG) matches.
    setDevScanOverride((input) => (input.mime === "image/png" ? "matched" : null));
    const draft = await makeJob(u, { mode: "text_to_video", modelKey: "demo-motion", params: { aspectRatio: "9:16", durationS: 3 } });
    await processJob(draft.id);
    expect(await jobRow(draft.id)).toMatchObject({ status: "failed", failureCode: "content_blocked" });
    const all = await assetsOf(u.id);
    expect(all.filter((a) => a.scanStatus === "matched" && a.kind === "video")).toHaveLength(1);
    // No poster was made from a blocked clip.
    expect(all.filter((a) => a.kind === "image")).toHaveLength(0);
  });
});

describe("scanner outage, fail closed", () => {
  it("refuses an upload with a 503 and deletes what was stored", async () => {
    const u = await makeUser();
    await signIn(u);
    setDevScanOverride(() => "unavailable");
    const res = await uploadRequest(await png());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "scan_unavailable", message: "We couldn't check this file right now. Try again in a few minutes." } });
    expect(await getDb().select().from(uploads).where(eq(uploads.userId, u.id))).toHaveLength(0);
    expect(await getDb().select().from(consentRecords).where(and(eq(consentRecords.userId, u.id), eq(consentRecords.kind, "upload_subject")))).toHaveLength(0);
    const [a] = await assetsOf(u.id);
    expect(a!.deletedAt).not.toBeNull();
    expect(a!.storageKey.startsWith("purged/")).toBe(true);
    expect(await filesUnder("uploads", u.id)).toHaveLength(0);
  });

  it("holds an output job in the queue with credits reserved, then fails and refunds when attempts run out", async () => {
    const u = await makeUser({ credits: 50 });
    setDevScanOverride(() => "unavailable");
    const draft = await makeJob(u);
    await processJob(draft.id, { retryBaseDelayMs: 1 });

    let job = await jobRow(draft.id);
    expect(job).toMatchObject({ status: "queued", failureCode: "scan_unavailable", attempts: 1 });
    expect(await getBalance(u.id)).toEqual({ available: 50 - draft.costCredits, reserved: draft.costCredits });
    expect(await getDb().select().from(generationOutputs).where(eq(generationOutputs.jobId, draft.id))).toHaveLength(0);
    expect(await filesUnder("outputs", u.id)).toHaveLength(0);
    expect((await assetsOf(u.id)).every((a) => a.deletedAt && a.storageKey.startsWith("purged/"))).toBe(true);
    expect((await getCreation(u.id, draft.id))!.output).toBeNull();

    await processJob(draft.id, { retryBaseDelayMs: 1 });
    await processJob(draft.id, { retryBaseDelayMs: 1 });
    job = await jobRow(draft.id);
    expect(job).toMatchObject({ status: "failed", failureCode: "scan_unavailable", attempts: 3 });
    expect(await getBalance(u.id)).toEqual({ available: 50, reserved: 0 });
    expect(await filesUnder("outputs", u.id)).toHaveLength(0);
  });

  it("recovers once the scanner is back: the retry completes normally", async () => {
    const u = await makeUser({ credits: 50 });
    setDevScanOverride(() => "unavailable");
    const draft = await makeJob(u);
    await processJob(draft.id, { retryBaseDelayMs: 1 });
    setDevScanOverride(null);
    await processJob(draft.id, { retryBaseDelayMs: 1 });
    expect(await jobRow(draft.id)).toMatchObject({ status: "completed", attempts: 2 });
    expect((await getCreation(u.id, draft.id))!.output!.url).toContain("/api/media?");
  });
});

describe("scanner outage, fail-closed turned off", () => {
  const withFailOpen = async (fn: () => Promise<void>) => {
    const e = env();
    e.SCAN_FAIL_CLOSED = "false";
    try {
      await fn();
    } finally {
      e.SCAN_FAIL_CLOSED = "true";
    }
  };

  it("keeps the content recorded as unavailable but never serves, downloads or uses it", async () => {
    await withFailOpen(async () => {
      const u = await makeUser({ credits: 50 });
      await signIn(u);
      setDevScanOverride(() => "unavailable");
      const up = await uploadRequest(await png());
      expect(up.status).toBe(201);
      const { assetId, warnings } = await up.json();
      expect(warnings).toContain("scan_pending");
      const [ua] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
      expect(ua).toMatchObject({ scanStatus: "unavailable", deletedAt: null });
      expect(await assetUrl(ua!, u.id)).toBeNull();
      // An uncleared upload cannot be sent to a model either.
      await expect(makeJob(u, { mode: "image_to_image", inputAssetIds: [assetId] })).rejects.toMatchObject({ status: 404 });

      const draft = await makeJob(u);
      await processJob(draft.id);
      expect(await jobRow(draft.id)).toMatchObject({ status: "completed" });
      const creation = await getCreation(u.id, draft.id);
      expect(creation!.output!.url).toBeNull();
      const [out] = await getDb().select().from(generationOutputs).where(eq(generationOutputs.jobId, draft.id));
      const [oa] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, out!.assetId));
      expect(oa!.scanStatus).toBe("unavailable");
      expect((await getMedia(await storage().signedUrl(oa!.storageKey, 300))).status).toBe(404);
      const dl = await downloadRoute(new NextRequest(`http://localhost/api/generations/${draft.id}/download`), params({ id: draft.id }));
      expect(dl.status).toBe(404);
      await expect(publishTemplate(u, { jobId: draft.id, title: "Unchecked", description: "", tags: [], isVip: false })).rejects.toMatchObject({ status: 409, code: "not_cleared" });
    });
  });
});

describe("clean content", () => {
  it("uploads, serves, generates from, downloads and publishes as before, with recorded verdicts", async () => {
    const u = await makeUser({ credits: 50 });
    const other = await makeUser();
    await signIn(u);
    const up = await uploadRequest(await png("#335544"));
    expect(up.status).toBe(201);
    const { assetId } = await up.json();
    const [ua] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
    expect(ua).toMatchObject({ scanStatus: "clean", scanProvider: "dev", legalHold: false });
    expect(ua!.scannedAt).not.toBeNull();
    expect((await getMedia((await assetUrl(ua!, u.id))!)).status).toBe(200);

    const fromUpload = await makeJob(u, { mode: "image_to_image", inputAssetIds: [assetId] });
    await processJob(fromUpload.id);
    expect(await jobRow(fromUpload.id)).toMatchObject({ status: "completed" });

    const plain = await makeJob(u);
    await processJob(plain.id);
    const dl = await downloadRoute(new NextRequest(`http://localhost/api/generations/${plain.id}/download`), params({ id: plain.id }));
    expect(dl.status).toBe(302);
    const t = await publishTemplate(u, { jobId: plain.id, title: "Candle Toast", description: "", tags: [], isVip: false });
    const [cover] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, t.posterAssetId!));
    expect(cover).toMatchObject({ visibility: "public", scanStatus: "clean", scanProvider: "dev", legalHold: false });
    expect(await assetUrl(cover!, other.id)).not.toBeNull();
  });

  it("redirects a download to the public origin, not the server's bind address (R44)", async () => {
    const u = await makeUser({ credits: 50 });
    await signIn(u);
    const job = await makeJob(u);
    await processJob(job.id);
    // Behind a proxy, Next builds the request URL from the address the server binds to.
    const dl = await downloadRoute(new NextRequest(`http://0.0.0.0:3000/api/generations/${job.id}/download`), params({ id: job.id }));
    expect(dl.status).toBe(302);
    const location = new URL(dl.headers.get("location")!);
    expect(location.origin).toBe(new URL(env().APP_URL).origin);
    expect(location.pathname).toBe("/api/media");
  });

  it("scans clip keyframes and records the poster frame with the clip's verdict", async () => {
    const u = await makeUser({ credits: 50 });
    const draft = await makeJob(u, { mode: "text_to_video", modelKey: "demo-motion", params: { aspectRatio: "9:16", durationS: 3 } });
    await processJob(draft.id);
    expect(await jobRow(draft.id)).toMatchObject({ status: "completed" });
    const [out] = await getDb().select().from(generationOutputs).where(eq(generationOutputs.jobId, draft.id));
    const [clip] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, out!.assetId));
    const [poster] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, out!.posterAssetId!));
    expect(clip!.scanStatus).toBe("clean");
    // Three once-a-second frames, plus the opening frame, which the change picker always scans (R06-fade).
    expect(clip!.scanRef).toMatch(/^keyframes:4;/);
    expect(poster).toMatchObject({ scanStatus: "clean", scanRef: `derived:${clip!.id}` });
  });

  it("publishing refuses a source that is not cleared, including its poster", async () => {
    const u = await makeUser({ credits: 50 });
    const a = await makeJob(u);
    await processJob(a.id);
    const [out] = await getDb().select().from(generationOutputs).where(eq(generationOutputs.jobId, a.id));
    for (const status of ["pending", "unavailable", "matched"] as const) {
      await getDb().update(mediaAssets).set({ scanStatus: status }).where(eq(mediaAssets.id, out!.assetId));
      await expect(publishTemplate(u, { jobId: a.id, title: "Not yet", description: "", tags: [], isVip: false })).rejects.toMatchObject({ status: 409, code: "not_cleared" });
    }
    const clip = await makeJob(u, { mode: "text_to_video", modelKey: "demo-motion", params: { aspectRatio: "9:16", durationS: 3 } });
    await processJob(clip.id);
    const [cout] = await getDb().select().from(generationOutputs).where(eq(generationOutputs.jobId, clip.id));
    await getDb().update(mediaAssets).set({ scanStatus: "unavailable" }).where(eq(mediaAssets.id, cout!.posterAssetId!));
    await expect(publishTemplate(u, { jobId: clip.id, title: "Poster pending", description: "", tags: [], isVip: false })).rejects.toMatchObject({ status: 409 });
    expect(await getDb().select().from(templates)).toHaveLength(0);
  });
});

describe("human review", () => {
  async function matchedUpload() {
    const { user } = await member(0);
    await expect(acceptUpload(user.id, { bytes: await fixture(), declaredMime: "image/png" }, { statement: "x", subjectLabel: null }, "source")).rejects.toMatchObject({ status: 403 });
    const [asset] = await assetsOf(user.id);
    const [esc] = await getDb().select().from(moderationEvents).where(and(eq(moderationEvents.action, "escalate"), eq(moderationEvents.subjectId, asset!.id)));
    return { user, asset: asset!, esc: esc! };
  }

  it("an admin clears a false positive: the file is servable again and the account is reinstated", async () => {
    const { user, asset, esc } = await matchedUpload();
    const admin = await makeUser({ role: "admin" });

    await signIn(await makeUser());
    expect((await reviewList(new NextRequest("http://localhost/api/admin/review"), undefined as never)).status).toBe(404);
    await signIn(admin);
    const list = await (await reviewList(new NextRequest("http://localhost/api/admin/review"), undefined as never)).json();
    expect(list.scanner).toMatchObject({ provider: "dev", isDev: true });
    expect(list.escalations.map((e: { id: string }) => e.id)).toEqual([esc.id]);

    const bad = await reviewAction(post(`/api/admin/review/${esc.id}`, { action: "clear", note: "" }), params({ id: esc.id }));
    expect(bad.status).toBe(422);
    const ok = await reviewAction(post(`/api/admin/review/${esc.id}`, { action: "clear", note: "Drill fixture, not real material" }), params({ id: esc.id }));
    expect(ok.status).toBe(200);

    const [after] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, asset.id));
    expect(after).toMatchObject({ scanStatus: "clean", legalHold: false });
    expect((await getMedia((await assetUrl(after!, user.id))!)).status).toBe(200);
    const [row] = await getDb().select().from(users).where(eq(users.id, user.id));
    expect(row!.status).toBe("active");
    const [flag] = await getDb().select().from(accountFlags).where(eq(accountFlags.userId, user.id));
    expect(flag!.clearedAt).not.toBeNull();
    const [closed] = await getDb().select().from(moderationEvents).where(eq(moderationEvents.id, esc.id));
    expect(closed).toMatchObject({ status: "resolved", actorId: admin.id });
    const actions = (await getDb().select().from(auditLogs)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["scan.false_positive_cleared", "user.reinstate"]));
    const again = await reviewAction(post(`/api/admin/review/${esc.id}`, { action: "clear", note: "twice" }), params({ id: esc.id }));
    expect(again.status).toBe(409);
  });

  it("confirming records the report reference and keeps the hold and the suspension", async () => {
    const { user, asset, esc } = await matchedUpload();
    const admin = await makeUser({ role: "admin" });
    await signIn(admin);
    const res = await reviewAction(post(`/api/admin/review/${esc.id}`, { action: "confirm", reportRef: "CT-2026-000123", reportedTo: "ncmec_cybertipline" }), params({ id: esc.id }));
    expect(res.status).toBe(200);
    const [closed] = await getDb().select().from(moderationEvents).where(eq(moderationEvents.id, esc.id));
    expect(closed!.status).toBe("resolved");
    expect(closed!.details).toMatchObject({ resolution: "confirmed", reportRef: "CT-2026-000123", reportedTo: "ncmec_cybertipline" });
    const [hold] = await getDb().select().from(moderationEvents).where(and(eq(moderationEvents.action, "hold"), eq(moderationEvents.subjectId, asset.id)));
    expect(hold).toBeTruthy();
    const [after] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, asset.id));
    expect(after).toMatchObject({ scanStatus: "matched", legalHold: true });
    const [row] = await getDb().select().from(users).where(eq(users.id, user.id));
    expect(row!.status).toBe("suspended");
    const [flag] = await getDb().select().from(accountFlags).where(eq(accountFlags.userId, user.id));
    expect(flag).toMatchObject({ clearedAt: null });
    expect(flag!.details).toMatchObject({ reportRef: "CT-2026-000123" });
    const audit = await getDb().select().from(auditLogs).where(eq(auditLogs.action, "scan.match_confirmed"));
    expect(audit).toHaveLength(1);
  });
});

describe("takedown requests", () => {
  async function publishedTemplate() {
    const creator = await makeUser({ credits: 50 });
    const job = await makeJob(creator);
    await processJob(job.id);
    const t = await publishTemplate(creator, { jobId: job.id, title: "Reported Look", description: "", tags: [], isVip: false });
    return { creator, t, job };
  }

  it("can be sent signed out with an email, and signed in without one", async () => {
    const { t, job } = await publishedTemplate();
    const ip = { "x-forwarded-for": "203.0.113.7" };
    const noEmail = await takedownsRoute(post("/api/takedowns", { category: "ncii", target: `https://hushloom.example/templates/${t.slug}`, goodFaith: true }, ip), undefined as never);
    expect(noEmail.status).toBe(422);
    const noStatement = await takedownsRoute(post("/api/takedowns", { category: "ncii", target: `/templates/${t.slug}`, email: "me@example.test" }, ip), undefined as never);
    expect(noStatement.status).toBe(422);
    const anon = await takedownsRoute(
      post("/api/takedowns", { category: "ncii", target: `https://hushloom.example/templates/${t.slug}`, email: "me@example.test", name: "A. Person", details: "This is me.", goodFaith: true }, ip),
      undefined as never,
    );
    expect(anon.status).toBe(201);

    const member = await makeUser();
    await signIn(member);
    const signedIn = await takedownsRoute(post("/api/takedowns", { category: "likeness", target: job.id, goodFaith: true }), undefined as never);
    expect(signedIn.status).toBe(201);

    const rows = await getDb().select().from(takedownRequests).orderBy(takedownRequests.createdAt);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ requesterId: null, requesterEmail: "me@example.test", targetType: "template", targetRef: t.slug, category: "ncii", status: "open" });
    expect(rows[0]!.details).toContain("Signed: A. Person");
    expect(rows[1]).toMatchObject({ requesterId: member.id, requesterEmail: null, targetType: "output", targetRef: job.id, category: "likeness" });
    // The audit trail keeps ids and the category, never the requester's email or words.
    const audits = await getDb().select().from(auditLogs).where(eq(auditLogs.action, "takedown.create"));
    expect(audits).toHaveLength(2);
    expect(JSON.stringify(audits)).not.toContain("me@example.test");

    signOut();
    for (let i = 0; i < 9; i++) {
      await takedownsRoute(post("/api/takedowns", { category: "other", target: "https://elsewhere.example/x", email: "me@example.test", goodFaith: true }, ip), undefined as never);
    }
    const limited = await takedownsRoute(post("/api/takedowns", { category: "other", target: "https://elsewhere.example/x", email: "me@example.test", goodFaith: true }, ip), undefined as never);
    expect(limited.status).toBe(429);
  });

  it("an admin actions one (the template comes down and its files go) and dismisses another with a note", async () => {
    const { t } = await publishedTemplate();
    const admin = await makeUser({ role: "admin" });
    const [req1] = await getDb().insert(takedownRequests).values({ requesterEmail: "me@example.test", targetType: "template", targetRef: t.slug, category: "ncii" }).returning();
    const [req2] = await getDb().insert(takedownRequests).values({ requesterEmail: "x@example.test", targetType: "url", targetRef: "https://elsewhere.example/x", category: "other" }).returning();

    const someone = await makeUser();
    await signIn(someone);
    expect((await takedownAction(post(`/api/admin/takedowns/${req1!.id}`, { action: "action" }), params({ id: req1!.id }))).status).toBe(404);

    await signIn(admin);
    const res = await takedownAction(post(`/api/admin/takedowns/${req1!.id}`, { action: "action", note: "Confirmed with requester" }), params({ id: req1!.id }));
    expect(res.status).toBe(200);
    const [tt] = await getDb().select().from(templates).where(eq(templates.id, t.id));
    expect(tt!.status).toBe("removed");
    const [cover] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, t.posterAssetId!));
    expect(cover!.deletedAt).not.toBeNull();
    expect(cover!.storageKey.startsWith("purged/")).toBe(true);
    const [r1] = await getDb().select().from(takedownRequests).where(eq(takedownRequests.id, req1!.id));
    expect(r1).toMatchObject({ status: "actioned", resolvedBy: admin.id });

    const noNote = await takedownAction(post(`/api/admin/takedowns/${req2!.id}`, { action: "dismiss" }), params({ id: req2!.id }));
    expect(noNote.status).toBe(422);
    const dismissed = await takedownAction(post(`/api/admin/takedowns/${req2!.id}`, { action: "dismiss", note: "Not on this site" }), params({ id: req2!.id }));
    expect(dismissed.status).toBe(200);
    const actions = (await getDb().select().from(auditLogs).where(inArray(auditLogs.action, ["takedown.action", "takedown.dismiss"]))).map((a) => a.action);
    expect(actions.sort()).toEqual(["takedown.action", "takedown.dismiss"]);
  });

  it("a CSAM request puts the files on legal hold and sends them to the review queue instead of purging", async () => {
    const { t } = await publishedTemplate();
    const admin = await makeUser({ role: "admin" });
    const [req] = await getDb().insert(takedownRequests).values({ requesterEmail: "tips@example.test", targetType: "template", targetRef: t.id, category: "csam" }).returning();
    await signIn(admin);
    expect((await takedownAction(post(`/api/admin/takedowns/${req!.id}`, { action: "action" }), params({ id: req!.id }))).status).toBe(200);
    const [cover] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, t.posterAssetId!));
    expect(cover).toMatchObject({ legalHold: true });
    expect(cover!.deletedAt).not.toBeNull();
    expect(cover!.storageKey.startsWith("purged/")).toBe(false);
    const [esc] = await getDb().select().from(moderationEvents).where(and(eq(moderationEvents.action, "escalate"), eq(moderationEvents.subjectId, cover!.id)));
    expect(esc).toMatchObject({ status: "open", reason: "csam_report" });
  });
});

describe("PhotoDNA adapter (unverified against the live service)", () => {
  it("sends a JPEG under the size cap, and fails closed when unconfigured", async () => {
    const jpeg = await photoDnaJpeg(await sharp(await png()).webp().toBuffer());
    expect(jpeg.subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(jpeg.length).toBeLessThan(4 * 1024 * 1024);
    const { photoDnaProvider } = await import("@/server/safety/scan/providers/photodna");
    expect(photoDnaProvider.isConfigured()).toBe(false);
    expect(await photoDnaProvider.scan({ bytes: await png(), mime: "image/png", kind: "image", sha256: "x" })).toMatchObject({ status: "unavailable", provider: "photodna" });
    const { cloudflareEdgeProvider } = await import("@/server/safety/scan/providers/cloudflare");
    expect(await cloudflareEdgeProvider.scan({ bytes: await png(), mime: "image/png", kind: "image", sha256: "x" })).toMatchObject({ status: "unavailable", provider: "cloudflare" });
  });
});
