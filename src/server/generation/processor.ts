import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import sharp from "sharp";
import { getModel } from "@/server/ai/registry";
import { adapterFor } from "@/server/ai/providers";
import { ProviderError, USER_FACING_ERRORS, type ProviderInput, type ProviderOutput } from "@/server/ai/providers/types";
import { releaseJob, settleJob } from "@/server/credits/ledger";
import { getDb } from "@/server/db";
import { generationJobs, generationOutputs, mediaAssets, templates } from "@/server/db/schema";
import { env } from "@/server/env";
import { logger } from "@/server/log";
import { purgeAssetsNow } from "@/server/media";
import { newStorageKey, sha256, storage } from "@/server/storage";
import { recordDerivedScan, scanAsset, scanFailClosed } from "@/server/safety/scan";
import { notifyJobFinished } from "@/server/push/notify";
import { videoPoster } from "./poster";
import { enqueueGeneration } from "./queue";

const EXT: Record<string, string> = { "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg", "video/mp4": "mp4", "video/webm": "webm" };

type QualityReport = { ok: boolean; checks: Record<string, boolean | number | string> };

/** Cheap structural checks so an empty or corrupt file is never shown as a finished creation. */
export async function qualityCheck(out: ProviderOutput): Promise<QualityReport> {
  const checks: QualityReport["checks"] = { bytes: out.bytes.length, mime: out.mime };
  if (out.bytes.length < 1024) return { ok: false, checks: { ...checks, tooSmall: true } };
  if (out.mime.startsWith("image/")) {
    try {
      const meta = await sharp(out.bytes).metadata();
      checks.width = meta.width ?? 0;
      checks.height = meta.height ?? 0;
      return { ok: (meta.width ?? 0) >= 64 && (meta.height ?? 0) >= 64, checks };
    } catch {
      return { ok: false, checks: { ...checks, decodable: false } };
    }
  }
  if (out.mime.startsWith("video/")) {
    // MP4 files carry an "ftyp" box in their first bytes.
    const isMp4 = out.bytes.subarray(4, 8).toString("ascii") === "ftyp";
    return { ok: out.mime !== "video/mp4" || isMp4, checks: { ...checks, container: isMp4 ? "mp4" : "unknown" } };
  }
  return { ok: false, checks: { ...checks, unknownType: true } };
}

async function finishFailed(jobId: string, err: ProviderError) {
  await getDb().transaction(async (tx) => {
    const [job] = await tx.select().from(generationJobs).where(eq(generationJobs.id, jobId)).for("update");
    if (!job || job.status !== "processing") return;
    const cancelled = err.code === "cancelled" || job.cancelRequested;
    await releaseJob(tx, job.userId, job.id, job.costCredits, cancelled ? "cancelled" : `failed: ${err.code}`);
    await tx
      .update(generationJobs)
      .set({
        status: cancelled ? "cancelled" : "failed",
        failureCode: cancelled ? "cancelled" : err.code,
        failureMessage: USER_FACING_ERRORS[cancelled ? "cancelled" : err.code],
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(generationJobs.id, job.id));
    void notifyJobFinished({ userId: job.userId, jobId: job.id, outcome: cancelled ? "cancelled" : "failed" });
  });
}

export type ProcessOptions = { timeoutMs?: number; cancelPollMs?: number; retryBaseDelayMs?: number };

type ClaimedJob = typeof generationJobs.$inferSelect;

/** A retryable error goes back to the queue with the reservation held, until attempts run out; then it fails and refunds. */
async function retryOrFail(job: ClaimedJob, err: ProviderError, opts: ProcessOptions) {
  if (err.retryable && job.attempts < job.maxAttempts) {
    // Back to queued with the reservation held; credits move only on a terminal state.
    await getDb()
      .update(generationJobs)
      .set({ status: "queued", failureCode: err.code, updatedAt: new Date() })
      .where(and(eq(generationJobs.id, job.id), eq(generationJobs.status, "processing")));
    const delay = (opts.retryBaseDelayMs ?? 5000) * 2 ** (job.attempts - 1);
    await enqueueGeneration(job.id, delay, job.attempts + 1);
    return;
  }
  await finishFailed(job.id, err);
}

/** Soft-deletes and purges files this attempt wrote. Held evidence is never touched. */
async function discardStored(assetIds: string[]) {
  if (!assetIds.length) return;
  await getDb()
    .update(mediaAssets)
    .set({ deletedAt: new Date() })
    .where(and(inArray(mediaAssets.id, assetIds), eq(mediaAssets.legalHold, false)));
  await purgeAssetsNow(assetIds);
}

/**
 * Runs one attempt of a queued job. Idempotent: a job that is not in `queued`
 * is left alone, so duplicate queue deliveries do nothing.
 */
export async function processJob(jobId: string, opts: ProcessOptions = {}): Promise<void> {
  const db = getDb();
  const timeoutMs = opts.timeoutMs ?? env().PROVIDER_TIMEOUT_S * 1000;

  const claimed = await db.transaction(async (tx) => {
    const [job] = await tx.select().from(generationJobs).where(eq(generationJobs.id, jobId)).for("update");
    if (!job || job.status !== "queued") return null;
    if (job.cancelRequested) {
      await releaseJob(tx, job.userId, job.id, job.costCredits, "cancelled before processing");
      await tx.update(generationJobs).set({ status: "cancelled", finishedAt: new Date(), updatedAt: new Date() }).where(eq(generationJobs.id, job.id));
      return null;
    }
    const [running] = await tx
      .update(generationJobs)
      .set({ status: "processing", startedAt: new Date(), attempts: job.attempts + 1, updatedAt: new Date() })
      .where(eq(generationJobs.id, job.id))
      .returning();
    return running!;
  });
  if (!claimed) return;
  const job = claimed;
  const log = { jobId: job.id, attempt: job.attempts, provider: job.providerKey, model: job.modelKey };

  const model = getModel(job.modelKey);
  const adapter = model && adapterFor(model);
  if (!model || !adapter || !adapter.isConfigured()) {
    await finishFailed(job.id, new ProviderError("provider_unavailable", "adapter missing or unconfigured", false));
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const cancelWatch = setInterval(async () => {
    const [row] = await db.select({ c: generationJobs.cancelRequested }).from(generationJobs).where(eq(generationJobs.id, job.id));
    if (row?.c) controller.abort();
  }, opts.cancelPollMs ?? 2000);

  let outputs: ProviderOutput[];
  try {
    // Only inputs the abuse scanner cleared ever reach a provider (addendum §3).
    const assets = job.inputAssetIds.length
      ? await db
          .select()
          .from(mediaAssets)
          .where(and(inArray(mediaAssets.id, job.inputAssetIds), isNull(mediaAssets.deletedAt), eq(mediaAssets.scanStatus, "clean")))
      : [];
    if (assets.length !== job.inputAssetIds.length) throw new ProviderError("invalid_input", "an input was deleted or is not cleared", false);
    const inputs: ProviderInput[] = await Promise.all(
      assets.map(async (a) => ({ kind: a.kind, mime: a.mime, bytes: await storage().get(a.storageKey), width: a.width, height: a.height })),
    );
    logger.info("generation.start", log);
    outputs = await adapter.execute(
      { jobId: job.id, model, mode: job.mode, prompt: job.prompt, negativePrompt: job.negativePrompt, params: job.params, inputs },
      {
        signal: controller.signal,
        onProviderJobId: async (providerJobId) => {
          await db.update(generationJobs).set({ providerJobId, updatedAt: new Date() }).where(eq(generationJobs.id, job.id));
        },
      },
    );
  } catch (e) {
    clearTimeout(timer);
    clearInterval(cancelWatch);
    const [row] = await db.select({ c: generationJobs.cancelRequested }).from(generationJobs).where(eq(generationJobs.id, job.id));
    let err = e instanceof ProviderError ? e : new ProviderError("internal", (e as Error).message ?? String(e), false);
    if (row?.c) err = new ProviderError("cancelled", "cancelled by user", false);
    logger.warn("generation.provider_error", { ...log, code: err.code, retryable: err.retryable, message: err.message });
    await retryOrFail(job, err, opts);
    return;
  }
  clearTimeout(timer);
  clearInterval(cancelWatch);

  // Store outputs before touching the job, then commit everything in one transaction.
  const stored: { assetId: string; posterAssetId: string | null; report: QualityReport }[] = [];
  const storedSoFar = () => stored.flatMap((s) => (s.posterAssetId ? [s.assetId, s.posterAssetId] : [s.assetId]));
  for (const out of outputs) {
    const report = await qualityCheck(out);
    if (!report.ok) {
      await discardStored(storedSoFar());
      await finishFailed(job.id, new ProviderError("internal", `output failed quality check: ${JSON.stringify(report.checks)}`, false));
      return;
    }
    const kind = out.mime.startsWith("video/") ? "video" : "image";
    const key = newStorageKey("outputs", job.userId, EXT[out.mime] ?? "bin");
    await storage().put(key, out.bytes, out.mime);
    const [asset] = await db
      .insert(mediaAssets)
      .values({
        ownerId: job.userId,
        kind,
        storageKey: key,
        mime: out.mime,
        bytes: out.bytes.length,
        width: out.width ?? (report.checks.width as number | undefined),
        height: out.height ?? (report.checks.height as number | undefined),
        durationMs: out.durationMs,
        sha256: sha256(out.bytes),
        visibility: "private",
      })
      .returning({ id: mediaAssets.id });
    // Abuse scan of every output before it can be shown (addendum §3). The private file is never
    // served while pending; a non-clean verdict means no output row is ever created for it.
    const verdict = await scanAsset({ assetId: asset!.id, bytes: out.bytes, mime: out.mime, kind, sha256: sha256(out.bytes), ownerId: job.userId, origin: "output", jobId: job.id });
    if (verdict === "matched") {
      // The matched file stays under legal hold as evidence; anything else this attempt wrote goes.
      await discardStored(storedSoFar());
      logger.warn("generation.blocked", log);
      await finishFailed(job.id, new ProviderError("content_blocked", "output matched the abuse scanner", false));
      return;
    }
    if (verdict === "unavailable" && scanFailClosed()) {
      // Fail closed: nothing unscanned is kept. Retry later with the reservation held; refund when attempts run out.
      await discardStored([...storedSoFar(), asset!.id]);
      await retryOrFail(job, new ProviderError("scan_unavailable", "abuse scanner unavailable", true), opts);
      return;
    }
    let posterAssetId: string | null = null;
    if (kind === "video") {
      const poster = await videoPoster(out.bytes);
      if (poster) {
        const posterKey = newStorageKey("outputs", job.userId, "webp");
        await storage().put(posterKey, poster.bytes, "image/webp");
        const [p] = await db
          .insert(mediaAssets)
          .values({ ownerId: job.userId, kind: "image", storageKey: posterKey, mime: "image/webp", bytes: poster.bytes.length, width: poster.width, height: poster.height, sha256: sha256(poster.bytes), visibility: "private" })
          .returning({ id: mediaAssets.id });
        posterAssetId = p!.id;
        // A frame of a clip whose keyframes were just checked: recorded with the clip's verdict, not scanned twice.
        await recordDerivedScan(posterAssetId, asset!.id);
      }
    }
    stored.push({ assetId: asset!.id, posterAssetId, report });
  }

  const storedIds = stored.flatMap((s) => (s.posterAssetId ? [s.assetId, s.posterAssetId] : [s.assetId]));
  const kept = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(generationJobs).where(eq(generationJobs.id, job.id)).for("update");
    const now = new Date();
    if (!current || current.status !== "processing") {
      // Someone else closed the job (reconciler timeout). The files we just wrote belong to nothing.
      await tx.update(mediaAssets).set({ deletedAt: now }).where(inArray(mediaAssets.id, storedIds));
      return false;
    }
    if (current.cancelRequested) {
      await tx.update(mediaAssets).set({ deletedAt: now }).where(inArray(mediaAssets.id, storedIds));
      await releaseJob(tx, current.userId, current.id, current.costCredits, "cancelled during processing");
      await tx
        .update(generationJobs)
        .set({ status: "cancelled", failureCode: "cancelled", failureMessage: USER_FACING_ERRORS.cancelled, finishedAt: now, updatedAt: now })
        .where(eq(generationJobs.id, current.id));
      return false;
    }
    for (const s of stored) {
      await tx.insert(generationOutputs).values({
        jobId: current.id,
        userId: current.userId,
        assetId: s.assetId,
        posterAssetId: s.posterAssetId,
        isDemo: current.isDemo,
        qualityReport: s.report.checks,
      });
    }
    await settleJob(tx, current.userId, current.id, current.costCredits);
    await tx
      .update(generationJobs)
      .set({ status: "completed", failureCode: null, finishedAt: now, updatedAt: now })
      .where(eq(generationJobs.id, current.id));
    if (current.templateId) {
      await tx
        .update(templates)
        .set({ generationCount: sql`${templates.generationCount} + 1` })
        .where(eq(templates.id, current.templateId));
    }
    return true;
  });
  if (!kept) {
    await purgeAssetsNow(storedIds);
    logger.info("generation.discarded", log);
    return;
  }
  logger.info("generation.done", log);
  void notifyJobFinished({ userId: job.userId, jobId: job.id, outcome: "completed" });
}

/**
 * Recovers jobs a crashed worker or a lost queue message left behind:
 * queued jobs with no live queue entry are re-enqueued, and processing jobs
 * past the timeout are failed and refunded.
 */
export async function reconcile(opts: { staleQueuedMs?: number; staleProcessingMs?: number } = {}) {
  const db = getDb();
  const staleQueued = new Date(Date.now() - (opts.staleQueuedMs ?? 120_000));
  const staleProcessing = new Date(Date.now() - (opts.staleProcessingMs ?? env().PROVIDER_TIMEOUT_S * 1000 + 120_000));
  const queued = await db
    .select({ id: generationJobs.id, attempts: generationJobs.attempts })
    .from(generationJobs)
    .where(and(eq(generationJobs.status, "queued"), lt(generationJobs.updatedAt, staleQueued)));
  for (const j of queued) await enqueueGeneration(j.id, 0, j.attempts + 1);
  const stuck = await db
    .select({ id: generationJobs.id })
    .from(generationJobs)
    .where(and(eq(generationJobs.status, "processing"), lt(generationJobs.startedAt, staleProcessing)));
  for (const j of stuck) await finishFailed(j.id, new ProviderError("timeout", "worker lost the job", false));
  return { requeued: queued.length, failed: stuck.length };
}
