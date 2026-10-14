import sharp from "sharp";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { MODELS, type ModelSpec } from "@/server/ai/registry";
import { registerAdapter } from "@/server/ai/providers";
import { ProviderError, type ProviderAdapter, type ProviderRequest } from "@/server/ai/providers/types";
import { createCharacter } from "@/server/characters";
import { getBalance } from "@/server/credits/ledger";
import { closeDb, getDb } from "@/server/db";
import { characterReferences, consentRecords, creditLedger, generationJobs, generationOutputs, mediaAssets, moderationEvents } from "@/server/db/schema";
import { cancelJob, confirmJob, createDraft, deriveDraft, deleteJob } from "@/server/generation/service";
import { DRAFT_TTL_MS, processJob, reconcile } from "@/server/generation/processor";
import { lineage } from "@/server/generation/views";
import { closeRedis } from "@/server/redis";
import { storage } from "@/server/storage";
import { key, makeUser, resetDb } from "../helpers";

const ctx = { country: null };

// A controllable provider for failure-path tests.
let fakeBehavior: "ok" | "retryable" | "fatal" | "hang" = "ok";
let fakeCalls = 0;
let fakeOutputs = 1;
let lastRequest: ProviderRequest | null = null;
const fakeAdapter: ProviderAdapter = {
  key: "fake",
  isDemo: false,
  isConfigured: () => true,
  async execute(req, c) {
    fakeCalls++;
    lastRequest = req;
    await c.onProviderJobId(`fake-${fakeCalls}`);
    if (fakeBehavior === "retryable") throw new ProviderError("rate_limited", "busy", true);
    if (fakeBehavior === "fatal") throw new ProviderError("content_rejected", "nope", false);
    if (fakeBehavior === "hang") {
      await new Promise((_, reject) => c.signal.addEventListener("abort", () => reject(new ProviderError("timeout", "aborted", true))));
    }
    // Noise, so the file is big enough to pass the output quality check.
    const bytes = await sharp({ create: { width: 256, height: 256, channels: 3, background: "#884466", noise: { type: "gaussian", mean: 128, sigma: 40 } } }).webp().toBuffer();
    return Array.from({ length: fakeOutputs }, () => ({ mime: "image/webp", bytes, width: 256, height: 256 }));
  },
};
const fakeModel: ModelSpec = { ...MODELS[0]!, key: "fake-model", providerKey: "fake", displayName: "Fake" };
MODELS.push(fakeModel);
registerAdapter(fakeAdapter);

const draftInput = (overrides: Record<string, unknown> = {}) => ({
  idempotencyKey: key(),
  mode: "text_to_image" as const,
  modelKey: "demo-still",
  prompt: "two adults sharing a candlelit toast, warm film grain",
  negativePrompt: "",
  params: { aspectRatio: "4:5" },
  inputAssetIds: [],
  ...overrides,
});

beforeEach(async () => {
  await resetDb();
  fakeBehavior = "ok";
  fakeCalls = 0;
  fakeOutputs = 1;
  lastRequest = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const photo = () => sharp({ create: { width: 640, height: 640, channels: 3, background: "#553344" } }).png().toBuffer();
const jobRow = async (id: string) => (await getDb().select().from(generationJobs).where(eq(generationJobs.id, id)))[0]!;

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("generation pipeline", () => {
  it("runs draft → confirm → process → completed and charges exactly once", async () => {
    const user = await makeUser({ credits: 50 });
    const draft = await createDraft(user, draftInput(), ctx);
    expect(draft.status).toBe("awaiting_confirmation");
    expect(draft.isDemo).toBe(true);
    expect(draft.costCredits).toBe(4);

    const queued = await confirmJob(user, draft.id, draft.costCredits);
    expect(queued.status).toBe("queued");
    expect(await getBalance(user.id)).toEqual({ available: 46, reserved: 4 });

    await processJob(draft.id);
    const [done] = await getDb().select().from(generationJobs).where(eq(generationJobs.id, draft.id));
    expect(done!.status).toBe("completed");
    const outs = await getDb().select().from(generationOutputs).where(eq(generationOutputs.jobId, draft.id));
    expect(outs).toHaveLength(1);
    expect(outs[0]!.isDemo).toBe(true);
    expect(await getBalance(user.id)).toEqual({ available: 46, reserved: 0 });

    // Duplicate queue delivery and repeated confirms change nothing.
    await processJob(draft.id);
    await confirmJob(user, draft.id, draft.costCredits);
    expect(await getBalance(user.id)).toEqual({ available: 46, reserved: 0 });
    const ledger = await getDb().select().from(creditLedger).where(eq(creditLedger.jobId, draft.id));
    expect(ledger.map((l) => l.kind).sort()).toEqual(["reserve", "settle"]);
  });

  it("returns the same job for a repeated idempotency key", async () => {
    const user = await makeUser({ credits: 50 });
    const input = draftInput();
    const [a, b] = await Promise.all([createDraft(user, input, ctx), createDraft(user, input, ctx)]);
    expect(a.id).toBe(b.id);
    await Promise.all([confirmJob(user, a.id, a.costCredits), confirmJob(user, a.id, a.costCredits)]);
    expect(await getBalance(user.id)).toEqual({ available: 46, reserved: 4 });
  });

  it("refuses to confirm without enough credits and leaves the job unqueued", async () => {
    const user = await makeUser({ credits: 2 });
    const draft = await createDraft(user, draftInput(), ctx);
    await expect(confirmJob(user, draft.id, draft.costCredits)).rejects.toThrow(/needs 4 credits/);
    const [job] = await getDb().select().from(generationJobs).where(eq(generationJobs.id, draft.id));
    expect(job!.status).toBe("awaiting_confirmation");
    expect(await getBalance(user.id)).toEqual({ available: 2, reserved: 0 });
  });

  it("rejects a confirm whose cost does not match the estimate", async () => {
    const user = await makeUser({ credits: 50 });
    const draft = await createDraft(user, draftInput(), ctx);
    await expect(confirmJob(user, draft.id, 1)).rejects.toMatchObject({ code: "cost_changed" });
  });

  it("refunds a cancelled queued job and makes the cancel stick", async () => {
    const user = await makeUser({ credits: 50 });
    const draft = await createDraft(user, draftInput(), ctx);
    await confirmJob(user, draft.id, draft.costCredits);
    const cancelled = await cancelJob(user, draft.id);
    expect(cancelled.status).toBe("cancelled");
    await processJob(draft.id);
    const [job] = await getDb().select().from(generationJobs).where(eq(generationJobs.id, draft.id));
    expect(job!.status).toBe("cancelled");
    expect(await getBalance(user.id)).toEqual({ available: 50, reserved: 0 });
  });

  it("aborts a processing job when cancel is requested, and refunds", async () => {
    const user = await makeUser({ credits: 50 });
    fakeBehavior = "hang";
    const draft = await createDraft(user, draftInput({ modelKey: "fake-model" }), ctx);
    await confirmJob(user, draft.id, draft.costCredits);
    const running = processJob(draft.id, { cancelPollMs: 50, timeoutMs: 10_000 });
    await new Promise((r) => setTimeout(r, 200));
    const flagged = await cancelJob(user, draft.id);
    expect(flagged.cancelRequested).toBe(true);
    await running;
    const [job] = await getDb().select().from(generationJobs).where(eq(generationJobs.id, draft.id));
    expect(job!.status).toBe("cancelled");
    expect(await getBalance(user.id)).toEqual({ available: 50, reserved: 0 });
  });

  it("retries retryable provider errors, then fails and refunds once attempts run out", async () => {
    const user = await makeUser({ credits: 50 });
    fakeBehavior = "retryable";
    const draft = await createDraft(user, draftInput({ modelKey: "fake-model" }), ctx);
    await confirmJob(user, draft.id, draft.costCredits);
    for (let i = 0; i < 3; i++) await processJob(draft.id, { retryBaseDelayMs: 1 });
    const [job] = await getDb().select().from(generationJobs).where(eq(generationJobs.id, draft.id));
    expect(fakeCalls).toBe(3);
    expect(job!.status).toBe("failed");
    expect(job!.failureCode).toBe("rate_limited");
    expect(job!.failureMessage).toMatch(/credits were returned/);
    expect(await getBalance(user.id)).toEqual({ available: 50, reserved: 0 });
  });

  it("fails fast on a non-retryable error and refunds", async () => {
    const user = await makeUser({ credits: 50 });
    fakeBehavior = "fatal";
    const draft = await createDraft(user, draftInput({ modelKey: "fake-model" }), ctx);
    await confirmJob(user, draft.id, draft.costCredits);
    await processJob(draft.id);
    const [job] = await getDb().select().from(generationJobs).where(eq(generationJobs.id, draft.id));
    expect(job!.status).toBe("failed");
    expect(job!.failureCode).toBe("content_rejected");
    expect(await getBalance(user.id)).toEqual({ available: 50, reserved: 0 });
  });

  it("times out a hung provider", async () => {
    const user = await makeUser({ credits: 50 });
    fakeBehavior = "hang";
    const draft = await createDraft(user, draftInput({ modelKey: "fake-model" }), ctx);
    await confirmJob(user, draft.id, draft.costCredits);
    // Timeout errors are retryable; exhaust the attempts.
    for (let i = 0; i < 3; i++) await processJob(draft.id, { timeoutMs: 50, retryBaseDelayMs: 1 });
    const [job] = await getDb().select().from(generationJobs).where(eq(generationJobs.id, draft.id));
    expect(job!.status).toBe("failed");
    expect(job!.failureCode).toBe("timeout");
    expect(await getBalance(user.id)).toEqual({ available: 50, reserved: 0 });
  });

  it("fails and refunds jobs a dead worker left in processing", async () => {
    const user = await makeUser({ credits: 50 });
    const draft = await createDraft(user, draftInput(), ctx);
    await confirmJob(user, draft.id, draft.costCredits);
    await getDb()
      .update(generationJobs)
      .set({ status: "processing", startedAt: new Date(Date.now() - 3_600_000) })
      .where(eq(generationJobs.id, draft.id));
    const r = await reconcile({ staleProcessingMs: 60_000 });
    expect(r.failed).toBe(1);
    expect(await getBalance(user.id)).toEqual({ available: 50, reserved: 0 });
  });

  it("blocks prohibited prompts server-side and records a moderation event", async () => {
    const user = await makeUser({ credits: 50 });
    await expect(createDraft(user, draftInput({ prompt: "a 16 yo in a bedroom" }), ctx)).rejects.toMatchObject({ code: "policy_blocked" });
    await expect(createDraft(user, draftInput({ prompt: "s c h o o l g i r l outfit" }), ctx)).rejects.toMatchObject({ code: "policy_blocked" });
    await expect(createDraft(user, draftInput({ prompt: "she is passed out" }), ctx)).rejects.toMatchObject({ code: "policy_blocked" });
    const events = await getDb().select().from(moderationEvents);
    expect(events.map((e) => e.reason).sort()).toEqual(["minors", "minors", "non_consent"]);
  });

  it("validates settings against model capabilities", async () => {
    const user = await makeUser({ credits: 50 });
    await expect(createDraft(user, draftInput({ params: { aspectRatio: "21:9" } }), ctx)).rejects.toMatchObject({ code: "unsupported_settings" });
    await expect(createDraft(user, draftInput({ params: { durationS: 5 } }), ctx)).rejects.toMatchObject({ code: "unsupported_settings" });
    await expect(createDraft(user, draftInput({ mode: "image_to_image" }), ctx)).rejects.toMatchObject({ code: "input_required" });
    await expect(createDraft(user, draftInput({ modelKey: "replicate-flux-schnell" }), ctx)).rejects.toMatchObject({ code: "model_unavailable" });
  });

  it("enforces the per-user concurrency limit", async () => {
    const user = await makeUser({ credits: 100 });
    for (let i = 0; i < 3; i++) {
      const d = await createDraft(user, draftInput(), ctx);
      await confirmJob(user, d.id, d.costCredits);
    }
    const fourth = await createDraft(user, draftInput(), ctx);
    await expect(confirmJob(user, fourth.id, fourth.costCredits)).rejects.toMatchObject({ code: "too_many_active" });
  });

  it("never lets one user see, confirm, cancel or derive from another user's job", async () => {
    const owner = await makeUser({ credits: 50 });
    const other = await makeUser({ credits: 50 });
    const draft = await createDraft(owner, draftInput(), ctx);
    await expect(confirmJob(other, draft.id, draft.costCredits)).rejects.toMatchObject({ status: 404 });
    await expect(cancelJob(other, draft.id)).rejects.toMatchObject({ status: 404 });
    await expect(deriveDraft(other, draft.id, "variation", key(), ctx)).rejects.toMatchObject({ status: 404 });
    await expect(deleteJob(other, draft.id)).rejects.toMatchObject({ status: 404 });
    await expect(createDraft(other, draftInput({ parentJobId: draft.id }), ctx)).rejects.toMatchObject({ status: 404 });
  });

  it("makes variations with a new seed and records lineage", async () => {
    const user = await makeUser({ credits: 50 });
    const draft = await createDraft(user, draftInput(), ctx);
    await confirmJob(user, draft.id, draft.costCredits);
    await processJob(draft.id);
    const variation = await deriveDraft(user, draft.id, "variation", key(), ctx);
    expect(variation.parentJobId).toBe(draft.id);
    expect(variation.relation).toBe("variation");
    expect(variation.params.seed).not.toBe(draft.params.seed);
    expect(variation.prompt).toBe(draft.prompt);
  });

  it("produces a real demo video clip through ffmpeg", async () => {
    const user = await makeUser({ credits: 50 });
    const draft = await createDraft(
      user,
      draftInput({ mode: "text_to_video", modelKey: "demo-motion", params: { aspectRatio: "9:16", durationS: 3, cameraMovement: "slow push in", motionIntensity: 4 } }),
      ctx,
    );
    expect(draft.costCredits).toBe(9);
    await confirmJob(user, draft.id, draft.costCredits);
    await processJob(draft.id);
    const [job] = await getDb().select().from(generationJobs).where(eq(generationJobs.id, draft.id));
    expect(job!.status).toBe("completed");
    const outs = await getDb().select().from(generationOutputs).where(eq(generationOutputs.jobId, draft.id));
    expect(outs[0]!.qualityReport).toMatchObject({ container: "mp4" });
  });
});

describe("settings are closed lists, and free text is checked", () => {
  it("refuses a value no list offers, before anything else", async () => {
    const user = await makeUser({ credits: 50 });
    await expect(createDraft(user, draftInput({ params: { aspectRatio: "4:5", lighting: "strobe" } }), ctx)).rejects.toMatchObject({ status: 422, code: "invalid_input" });
    await expect(createDraft(user, draftInput({ params: { aspectRatio: "4:5", framing: "anything at all" } }), ctx)).rejects.toMatchObject({ code: "invalid_input" });
    const ok = await createDraft(user, draftInput({ params: { aspectRatio: "4:5", lighting: "golden hour", framing: "close-up" } }), ctx);
    expect(ok.params).toMatchObject({ lighting: "golden hour", framing: "close-up" });
  });

  it("runs the content policy over the atmosphere line and records the block", async () => {
    const user = await makeUser({ credits: 50 });
    await expect(createDraft(user, draftInput({ params: { aspectRatio: "4:5", atmosphere: "a 16 yo vibe" } }), ctx)).rejects.toMatchObject({ code: "policy_blocked" });
    expect((await getDb().select().from(moderationEvents)).map((e) => e.reason)).toEqual(["minors"]);
  });

  it("re-checks stored settings when deriving from an older job", async () => {
    const user = await makeUser({ credits: 50 });
    const draft = await createDraft(user, draftInput(), ctx);
    // A job stored before the closed lists could carry any text.
    await getDb().update(generationJobs).set({ params: { ...draft.params, lighting: "strobe" } }).where(eq(generationJobs.id, draft.id));
    await expect(deriveDraft(user, draft.id, "retry", key(), ctx)).rejects.toMatchObject({ code: "invalid_input" });
    await getDb().update(generationJobs).set({ params: { ...draft.params, atmosphere: "a 16 yo vibe" } }).where(eq(generationJobs.id, draft.id));
    await expect(deriveDraft(user, draft.id, "retry", key(), ctx)).rejects.toMatchObject({ code: "policy_blocked" });
  });
});

describe("idempotency keys", () => {
  it("answers a reused key with the first draft whatever the new body says, which is why the panel changes key on every edit", async () => {
    const user = await makeUser({ credits: 50 });
    const k = key();
    const first = await createDraft(user, draftInput({ idempotencyKey: k }), ctx);
    const second = await createDraft(user, draftInput({ idempotencyKey: k, prompt: "a different idea entirely, two adults on a balcony", params: { aspectRatio: "16:9" } }), ctx);
    expect(second.id).toBe(first.id);
    expect(second.prompt).toBe(first.prompt);
    const fresh = await createDraft(user, draftInput({ prompt: "a different idea entirely, two adults on a balcony", params: { aspectRatio: "16:9" } }), ctx);
    expect(fresh.id).not.toBe(first.id);
    expect(fresh.params.aspectRatio).toBe("16:9");
  });
});

describe("remix lineage", () => {
  it("records a remix against its source so it shows in the source's versions", async () => {
    const user = await makeUser({ credits: 50 });
    const source = await createDraft(user, draftInput(), ctx);
    await confirmJob(user, source.id, source.costCredits);
    await processJob(source.id);
    const remix = await createDraft(user, draftInput({ parentJobId: source.id, relation: "remix", prompt: "two adults sharing a candlelit toast, now by a rainy window" }), ctx);
    expect(remix).toMatchObject({ parentJobId: source.id, relation: "remix" });
    await confirmJob(user, remix.id, remix.costCredits);
    await processJob(remix.id);
    const versions = await lineage(user.id, source.id);
    expect(versions.map((v) => v.id)).toEqual([source.id, remix.id]);
  });
});

describe("character references", () => {
  it("sends the reference photo to the model with the reference role", async () => {
    const user = await makeUser({ credits: 50 });
    const ch = await createCharacter(user.id, { bytes: await photo(), declaredMime: "image/png" }, "Ari", null);
    const draft = await createDraft(user, draftInput({ modelKey: "fake-model", mode: "reference_guided", characterReferenceId: ch.id }), ctx);
    await confirmJob(user, draft.id, draft.costCredits);
    await processJob(draft.id);
    expect((await jobRow(draft.id)).status).toBe("completed");
    expect(lastRequest!.inputs).toHaveLength(1);
    expect(lastRequest!.inputs[0]).toMatchObject({ kind: "image", role: "reference", width: 640, height: 640 });
    expect(lastRequest!.inputs[0]!.bytes.length).toBeGreaterThan(0);
  });

  it("fails and refunds, without calling the model, when the likeness consent was withdrawn after confirming", async () => {
    const user = await makeUser({ credits: 50 });
    const ch = await createCharacter(user.id, { bytes: await photo(), declaredMime: "image/png" }, "Ari", null);
    const draft = await createDraft(user, draftInput({ modelKey: "fake-model", mode: "reference_guided", characterReferenceId: ch.id }), ctx);
    await confirmJob(user, draft.id, draft.costCredits);
    const [ref] = await getDb().select().from(characterReferences).where(eq(characterReferences.id, ch.id));
    await getDb().update(consentRecords).set({ withdrawnAt: new Date() }).where(eq(consentRecords.id, ref!.consentRecordId));
    await processJob(draft.id);
    const job = await jobRow(draft.id);
    expect(job.status).toBe("failed");
    expect(job.failureCode).toBe("invalid_input");
    expect(fakeCalls).toBe(0);
    expect(await getBalance(user.id)).toEqual({ available: 50, reserved: 0 });
  });

  it("refuses a character on a mode that would not send it", async () => {
    const user = await makeUser({ credits: 50 });
    const ch = await createCharacter(user.id, { bytes: await photo(), declaredMime: "image/png" }, "Ari", null);
    await expect(createDraft(user, draftInput({ characterReferenceId: ch.id }), ctx)).rejects.toMatchObject({ status: 422, code: "input_unexpected" });
  });
});

describe("faults after the model answered", () => {
  it("fails the job, refunds it and removes what was written when storing an output breaks", async () => {
    const user = await makeUser({ credits: 50 });
    fakeOutputs = 2;
    const original = storage().put.bind(storage());
    const written: string[] = [];
    let calls = 0;
    // The first output stores fine; the second is written and then the store reports a failure.
    vi.spyOn(storage(), "put").mockImplementation(async (k: string, body: Buffer, mime: string) => {
      written.push(k);
      await original(k, body, mime);
      if (++calls === 2) throw new Error("disk full");
    });
    const draft = await createDraft(user, draftInput({ modelKey: "fake-model" }), ctx);
    await confirmJob(user, draft.id, draft.costCredits);
    await processJob(draft.id);

    const job = await jobRow(draft.id);
    expect(job).toMatchObject({ status: "failed", failureCode: "internal" });
    expect(await getBalance(user.id)).toEqual({ available: 50, reserved: 0 });
    expect(await getDb().select().from(generationOutputs).where(eq(generationOutputs.jobId, draft.id))).toHaveLength(0);
    const assets = await getDb().select().from(mediaAssets).where(eq(mediaAssets.ownerId, user.id));
    expect(assets).toHaveLength(1);
    expect(assets[0]!.deletedAt).not.toBeNull();
    expect(assets[0]!.storageKey).toMatch(/^purged\//);
    expect(written).toHaveLength(2);
    for (const k of written) await expect(storage().get(k)).rejects.toThrow();
    const ledger = await getDb().select().from(creditLedger).where(eq(creditLedger.jobId, draft.id));
    expect(ledger.map((l) => l.kind).sort()).toEqual(["release", "reserve"]);
  });
});

describe("deleted and closed drafts", () => {
  it("never confirms or cancels a deleted draft", async () => {
    const user = await makeUser({ credits: 50 });
    const draft = await createDraft(user, draftInput(), ctx);
    await deleteJob(user, draft.id);
    await expect(confirmJob(user, draft.id, draft.costCredits)).rejects.toMatchObject({ status: 404 });
    await expect(cancelJob(user, draft.id)).rejects.toMatchObject({ status: 404 });
    expect(await getBalance(user.id)).toEqual({ available: 50, reserved: 0 });
  });

  it("refuses to start a draft that was closed before it started", async () => {
    const user = await makeUser({ credits: 50 });
    const draft = await createDraft(user, draftInput(), ctx);
    await cancelJob(user, draft.id);
    await expect(confirmJob(user, draft.id, draft.costCredits)).rejects.toMatchObject({ status: 409, code: "draft_closed" });
    expect(await getBalance(user.id)).toEqual({ available: 50, reserved: 0 });
  });

  it("closes drafts nobody confirmed within 24 hours and leaves newer ones alone", async () => {
    const user = await makeUser({ credits: 50 });
    const old = await createDraft(user, draftInput(), ctx);
    const recent = await createDraft(user, draftInput(), ctx);
    const queued = await createDraft(user, draftInput(), ctx);
    await confirmJob(user, queued.id, queued.costCredits);
    const longAgo = new Date(Date.now() - DRAFT_TTL_MS - 60_000);
    await getDb().update(generationJobs).set({ createdAt: longAgo }).where(eq(generationJobs.id, old.id));
    await getDb().update(generationJobs).set({ createdAt: longAgo }).where(eq(generationJobs.id, queued.id));

    const r = await reconcile();
    expect(r.expiredDrafts).toBe(1);
    const closed = await jobRow(old.id);
    expect(closed).toMatchObject({ status: "cancelled", failureCode: "draft_expired" });
    expect(closed.deletedAt).not.toBeNull();
    expect((await jobRow(recent.id)).status).toBe("awaiting_confirmation");
    expect((await jobRow(queued.id)).status).toBe("queued");
    await expect(confirmJob(user, old.id, old.costCredits)).rejects.toMatchObject({ status: 404 });
    // The same key now answers with the closed draft; the panel sees that and starts a new one.
    expect((await createDraft(user, draftInput({ idempotencyKey: old.idempotencyKey }), ctx)).status).toBe("cancelled");
    expect((await reconcile()).expiredDrafts).toBe(0);
  });
});
