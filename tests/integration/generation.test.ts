import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { MODELS, type ModelSpec } from "@/server/ai/registry";
import { registerAdapter } from "@/server/ai/providers";
import { ProviderError, type ProviderAdapter } from "@/server/ai/providers/types";
import { getBalance } from "@/server/credits/ledger";
import { closeDb, getDb } from "@/server/db";
import { creditLedger, generationJobs, generationOutputs, moderationEvents } from "@/server/db/schema";
import { cancelJob, confirmJob, createDraft, deriveDraft, deleteJob } from "@/server/generation/service";
import { processJob, reconcile } from "@/server/generation/processor";
import { closeRedis } from "@/server/redis";
import { key, makeUser, resetDb } from "../helpers";

const ctx = { country: null };

// A controllable provider for failure-path tests.
let fakeBehavior: "ok" | "retryable" | "fatal" | "hang" = "ok";
let fakeCalls = 0;
const fakeAdapter: ProviderAdapter = {
  key: "fake",
  isDemo: false,
  isConfigured: () => true,
  async execute(_req, c) {
    fakeCalls++;
    await c.onProviderJobId(`fake-${fakeCalls}`);
    if (fakeBehavior === "retryable") throw new ProviderError("rate_limited", "busy", true);
    if (fakeBehavior === "fatal") throw new ProviderError("content_rejected", "nope", false);
    if (fakeBehavior === "hang") {
      await new Promise((_, reject) => c.signal.addEventListener("abort", () => reject(new ProviderError("timeout", "aborted", true))));
    }
    const { default: sharp } = await import("sharp");
    const bytes = await sharp({ create: { width: 256, height: 256, channels: 3, background: "#884466" } }).webp().toBuffer();
    return [{ mime: "image/webp", bytes, width: 256, height: 256 }];
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
});

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
