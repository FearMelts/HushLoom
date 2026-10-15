import { randomInt } from "node:crypto";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  CAMERA_MOVEMENTS,
  FRAMINGS,
  LIGHTINGS,
  MODE_INPUTS,
  MODE_LABELS,
  PACINGS,
  estimateCost,
  getModel,
  validateAgainstModel,
  type GenerationMode,
} from "@/server/ai/registry";
import { listModelAvailability } from "@/server/ai/providers";
import { audit } from "@/server/audit";
import type { SessionUser } from "@/server/auth/session";
import { lockAccount, releaseJob, reserveForJob } from "@/server/credits/ledger";
import { getDb } from "@/server/db";
import {
  type GenerationParams,
  characterReferences,
  consentRecords,
  discoveryEvents,
  generationJobs,
  generationOutputs,
  mediaAssets,
  moderationEvents,
  projectScenes,
  projects,
  sceneVersions,
  subscriptions,
  templates,
  uploads,
} from "@/server/db/schema";
import { env } from "@/server/env";
import { HttpError, notFound } from "@/server/http";
import { logger } from "@/server/log";
import { checkPrompt, paramTexts } from "@/server/safety/policy";
import { assertAgeVerified } from "@/server/age/gate";
import { pricing } from "@/config/pricing";
import { enqueueGeneration } from "./queue";

export type Job = typeof generationJobs.$inferSelect;

const modes = [
  "text_to_image",
  "image_to_image",
  "text_to_video",
  "image_to_video",
  "video_to_video",
  "video_extension",
  "scene_continuation",
  "reference_guided",
] as const satisfies readonly GenerationMode[];

/**
 * Settings are closed lists wherever the UI offers a list, so nothing but the prompt and the
 * atmosphere line can carry free text; those go through the content policy (see createDraft).
 */
export const paramsSchema = z
  .object({
    aspectRatio: z.string().regex(/^\d{1,2}:\d{1,2}$/).optional(),
    durationS: z.number().int().min(1).max(60).optional(),
    quality: z.enum(["hd", "4k"]).optional(),
    motionIntensity: z.number().int().min(1).max(10).optional(),
    cameraMovement: z.enum(CAMERA_MOVEMENTS).optional(),
    pacing: z.enum(PACINGS).optional(),
    atmosphere: z.string().max(80).optional(),
    lighting: z.enum(LIGHTINGS).optional(),
    framing: z.enum(FRAMINGS).optional(),
    seed: z.number().int().min(0).max(2_147_483_647).optional(),
  })
  .strict();

export const draftSchema = z.object({
  idempotencyKey: z.string().min(8).max(100),
  mode: z.enum(modes),
  modelKey: z.string().min(1).max(60),
  prompt: z.string().trim().min(1, "Describe what you want to see.").max(2000),
  negativePrompt: z.string().max(1000).default(""),
  params: paramsSchema.default({}),
  inputAssetIds: z.array(z.string().uuid()).max(2).default([]),
  templateId: z.string().uuid().optional(),
  characterReferenceId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  sceneId: z.string().uuid().optional(),
  parentJobId: z.string().uuid().optional(),
  relation: z.enum(["retry", "variation", "remix", "continuation", "extension"]).optional(),
});

/** Route input is parsed by draftSchema; derived drafts pass stored settings, which createDraft re-checks against paramsSchema. */
export type DraftInput = Omit<z.infer<typeof draftSchema>, "params"> & { params: GenerationParams };

export type RequestContext = { country: string | null; region?: string | null };

const ACTIVE: Job["status"][] = ["queued", "processing"];

/**
 * The user's best active plan, if any. A plan counts while it is active, trialing or non_renewing (rebilling stopped,
 * paid through the period) and its period has not ended.
 */
export async function activePlan(userId: string) {
  const rows = await getDb()
    .select({ planKey: subscriptions.planKey })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        inArray(subscriptions.status, ["active", "trialing", "non_renewing"]),
        or(isNull(subscriptions.currentPeriodEnd), gt(subscriptions.currentPeriodEnd, new Date())),
      ),
    );
  const plans = rows.map((r) => pricing.plans.find((p) => p.key === r.planKey)).filter((p) => p !== undefined);
  return plans.sort((a, b) => b.maxActiveJobs - a.maxActiveJobs)[0] ?? null;
}

async function hasVip(userId: string): Promise<boolean> {
  return Boolean((await activePlan(userId))?.vip);
}

export { hasVip };

/** Inputs must be the user's own consented uploads or the user's own outputs. */
async function validateInputs(userId: string, mode: GenerationMode, assetIds: string[]) {
  const need = MODE_INPUTS[mode];
  const assets = assetIds.length
    ? await getDb()
        .select()
        .from(mediaAssets)
        // Inputs the abuse scanner has not cleared look missing, like deleted ones (addendum §3).
        .where(and(inArray(mediaAssets.id, assetIds), eq(mediaAssets.ownerId, userId), isNull(mediaAssets.deletedAt), eq(mediaAssets.scanStatus, "clean")))
    : [];
  if (assets.length !== assetIds.length) throw notFound();

  for (const asset of assets) {
    const [upload] = await getDb()
      .select({ consentId: uploads.consentRecordId, withdrawnAt: consentRecords.withdrawnAt })
      .from(uploads)
      .leftJoin(consentRecords, eq(consentRecords.id, uploads.consentRecordId))
      .where(and(eq(uploads.assetId, asset.id), eq(uploads.userId, userId)))
      .limit(1);
    const [output] = await getDb()
      .select({ id: generationOutputs.id })
      .from(generationOutputs)
      .where(and(eq(generationOutputs.assetId, asset.id), eq(generationOutputs.userId, userId), isNull(generationOutputs.deletedAt)))
      .limit(1);
    if (upload) {
      if (!upload.consentId || upload.withdrawnAt) {
        throw new HttpError(403, "consent_required", "This upload has no active consent record, so it cannot be used.");
      }
    } else if (!output) {
      throw notFound();
    }
  }

  const images = assets.filter((a) => a.kind === "image").length;
  const videos = assets.filter((a) => a.kind === "video").length;
  if (images < need.image) throw new HttpError(422, "input_required", "Add an image to start from.");
  if (videos < need.video) throw new HttpError(422, "input_required", "Pick the clip to continue from.");
  if (images > need.image || videos > need.video) {
    throw new HttpError(422, "input_unexpected", "This mode does not use the attached media. Remove it or switch mode.");
  }
  return assets;
}

export async function createDraft(user: SessionUser, input: DraftInput, ctx: RequestContext): Promise<Job> {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(generationJobs)
    .where(and(eq(generationJobs.userId, user.id), eq(generationJobs.idempotencyKey, input.idempotencyKey)));
  if (existing) return existing;

  // Provider-backed verification for jurisdictions that require it (addendum §2). The older
  // AGE_ASSURANCE_STRICT_REGIONS list is folded into the same rule set (src/server/age/rules.ts).
  await assertAgeVerified(user, ctx);

  const availability = await listModelAvailability();
  const model = availability.find((m) => m.key === input.modelKey);
  if (!model || !getModel(input.modelKey)) throw new HttpError(422, "unknown_model", "That model does not exist.");
  if (!model.available) throw new HttpError(503, "model_unavailable", `${model.displayName} is unavailable: ${model.reason}.`);

  // Routes already parse with draftSchema; a derived draft copies settings from a stored job, which
  // may predate the closed lists, so the settings are checked here for every caller.
  const parsed = paramsSchema.safeParse(input.params);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join(".") || "settings";
    throw new HttpError(422, "invalid_input", `One of these settings isn't offered (${field}). Pick it again and retry.`, { issues: parsed.error.flatten() });
  }

  const issues = validateAgainstModel(model, input.mode, input.params, input.negativePrompt);
  if (issues.length) throw new HttpError(422, "unsupported_settings", issues[0]!.message, { issues });

  const verdict = checkPrompt(input.prompt, input.negativePrompt, ...paramTexts(input.params));
  if (!verdict.allowed) {
    await db.insert(moderationEvents).values({
      subjectType: "prompt",
      subjectId: user.id,
      action: "auto_block",
      status: "resolved",
      actorId: null,
      reason: verdict.category,
      details: { matched: verdict.matched },
      resolvedAt: new Date(),
    });
    throw new HttpError(422, "policy_blocked", verdict.message, { category: verdict.category });
  }

  await validateInputs(user.id, input.mode, input.inputAssetIds);

  let characterReferenceId: string | undefined;
  if (input.characterReferenceId) {
    // A reference is only ever recorded on a job that sends it to the model (the worker loads it for these modes).
    if (!MODE_INPUTS[input.mode].characterRef) {
      throw new HttpError(422, "input_unexpected", `${MODE_LABELS[input.mode]} doesn't use a character reference. Remove it or pick Reference guided.`);
    }
    const [ref] = await db
      .select({ id: characterReferences.id, withdrawnAt: consentRecords.withdrawnAt })
      .from(characterReferences)
      .innerJoin(consentRecords, eq(consentRecords.id, characterReferences.consentRecordId))
      .where(and(eq(characterReferences.id, input.characterReferenceId), eq(characterReferences.userId, user.id), isNull(characterReferences.deletedAt)));
    if (!ref) throw notFound();
    if (ref.withdrawnAt) throw new HttpError(403, "consent_withdrawn", "Consent for this character was withdrawn, so it cannot be used.");
    characterReferenceId = ref.id;
  } else if (MODE_INPUTS[input.mode].characterRef) {
    throw new HttpError(422, "input_required", "Pick a character reference from Train.");
  }

  let templateVersion: number | undefined;
  if (input.templateId) {
    const [t] = await db
      .select()
      .from(templates)
      .where(and(eq(templates.id, input.templateId), isNull(templates.deletedAt)));
    if (!t || (t.status !== "published" && t.creatorId !== user.id)) throw notFound();
    if (t.isVip && t.creatorId !== user.id && !(await hasVip(user.id))) {
      throw new HttpError(403, "vip_required", "This is a VIP template. A pass unlocks it.");
    }
    templateVersion = t.currentVersion;
  }

  if (input.projectId) {
    const [p] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, input.projectId), eq(projects.userId, user.id), isNull(projects.deletedAt)));
    if (!p) throw notFound();
  }
  if (input.sceneId) {
    if (!input.projectId) throw new HttpError(422, "invalid_input", "A scene needs its project.");
    const [s] = await db
      .select({ id: projectScenes.id })
      .from(projectScenes)
      .where(and(eq(projectScenes.id, input.sceneId), eq(projectScenes.projectId, input.projectId)));
    if (!s) throw notFound();
  }
  if (input.parentJobId) {
    const [parent] = await db
      .select({ id: generationJobs.id })
      .from(generationJobs)
      .where(and(eq(generationJobs.id, input.parentJobId), eq(generationJobs.userId, user.id)));
    if (!parent) throw notFound();
  }

  const params = { ...input.params };
  if (model.supports.seed && params.seed === undefined) params.seed = randomInt(0, 2_147_483_647);
  const cost = estimateCost(model, params, model.priceMultiplierPct);

  const inserted = await db
    .insert(generationJobs)
    .values({
      userId: user.id,
      idempotencyKey: input.idempotencyKey,
      status: "awaiting_confirmation",
      mode: input.mode,
      modelKey: model.key,
      providerKey: model.providerKey,
      isDemo: model.isDemo,
      templateId: input.templateId,
      templateVersion,
      projectId: input.projectId,
      sceneId: input.sceneId,
      parentJobId: input.parentJobId,
      relation: input.relation,
      prompt: input.prompt,
      negativePrompt: input.negativePrompt,
      params,
      inputAssetIds: input.inputAssetIds,
      characterReferenceId,
      costCredits: cost,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return inserted[0];
  // Lost a race with the same idempotency key: return the winner.
  const [winner] = await db
    .select()
    .from(generationJobs)
    .where(and(eq(generationJobs.userId, user.id), eq(generationJobs.idempotencyKey, input.idempotencyKey)));
  if (!winner) throw new Error("idempotent insert lost and winner missing");
  return winner;
}

/** Reserves credits and queues the job. Safe to call repeatedly. */
export async function confirmJob(user: SessionUser, jobId: string, expectedCost: number): Promise<Job> {
  const maxActive = Math.max(env().USER_MAX_ACTIVE_JOBS, (await activePlan(user.id))?.maxActiveJobs ?? 0);
  const result = await getDb().transaction(async (tx) => {
    // A deleted draft (Library delete, consent withdrawal, account deletion, the 24 h draft sweep) can never be charged.
    const [job] = await tx
      .select()
      .from(generationJobs)
      .where(and(eq(generationJobs.id, jobId), eq(generationJobs.userId, user.id), isNull(generationJobs.deletedAt)))
      .for("update");
    if (!job) throw notFound();
    if (job.status === "cancelled" && !job.queuedAt) {
      throw new HttpError(409, "draft_closed", "This draft was closed before it started. Make it again to see the current cost.");
    }
    if (job.status !== "awaiting_confirmation") return { job, enqueue: false };
    if (job.costCredits !== expectedCost) {
      throw new HttpError(409, "cost_changed", `The cost is now ${job.costCredits} credits. Review and confirm again.`, { cost: job.costCredits });
    }
    // Serialize this user's confirms on the account lock before counting: otherwise parallel confirms
    // each count the same active jobs and all queue past the cap (a paid perk).
    await lockAccount(tx, user.id);
    const [{ active }] = (await tx
      .select({ active: sql<number>`count(*)::int` })
      .from(generationJobs)
      .where(and(eq(generationJobs.userId, user.id), inArray(generationJobs.status, ACTIVE)))) as [{ active: number }];
    if (active >= maxActive) {
      throw new HttpError(429, "too_many_active", `You already have ${active} creations running. Wait for one to finish.`);
    }
    await reserveForJob(tx, user.id, job.id, job.costCredits);
    const [queued] = await tx
      .update(generationJobs)
      .set({ status: "queued", queuedAt: new Date(), updatedAt: new Date() })
      .where(eq(generationJobs.id, job.id))
      .returning();
    if (job.sceneId) {
      const [parentVersion] = job.parentJobId
        ? await tx.select({ id: sceneVersions.id }).from(sceneVersions).where(eq(sceneVersions.jobId, job.parentJobId))
        : [];
      await tx
        .insert(sceneVersions)
        .values({
          sceneId: job.sceneId,
          jobId: job.id,
          parentVersionId: parentVersion?.id,
          branchLabel: job.relation === "variation" ? "alternate" : "main",
        })
        .onConflictDoNothing();
    }
    if (job.templateId) {
      await tx.insert(discoveryEvents).values({ userId: user.id, templateId: job.templateId, event: "generate" });
    }
    return { job: queued!, enqueue: true };
  });
  if (result.enqueue) {
    try {
      await enqueueGeneration(result.job.id, 0, 1);
    } catch (err) {
      // The job is committed as queued with its credits held. The reconciler re-enqueues queued jobs
      // with no live queue entry (processor.ts reconcile), so this is a delay, not a failure to report.
      logger.error("generation.enqueue_failed", { jobId: result.job.id, err: (err as Error).message ?? String(err) });
    }
  }
  return result.job;
}

export async function cancelJob(user: SessionUser, jobId: string): Promise<Job> {
  return getDb().transaction(async (tx) => {
    const [job] = await tx
      .select()
      .from(generationJobs)
      .where(and(eq(generationJobs.id, jobId), eq(generationJobs.userId, user.id), isNull(generationJobs.deletedAt)))
      .for("update");
    if (!job) throw notFound();
    const now = new Date();
    if (job.status === "draft" || job.status === "awaiting_confirmation") {
      const [j] = await tx.update(generationJobs).set({ status: "cancelled", finishedAt: now, updatedAt: now }).where(eq(generationJobs.id, job.id)).returning();
      return j!;
    }
    if (job.status === "queued") {
      await releaseJob(tx, user.id, job.id, job.costCredits, "cancelled before processing");
      const [j] = await tx
        .update(generationJobs)
        .set({ status: "cancelled", cancelRequested: true, finishedAt: now, updatedAt: now, failureCode: "cancelled" })
        .where(eq(generationJobs.id, job.id))
        .returning();
      return j!;
    }
    if (job.status === "processing") {
      // The worker sees the flag, aborts the provider call, and releases the credits.
      const [j] = await tx.update(generationJobs).set({ cancelRequested: true, updatedAt: now }).where(eq(generationJobs.id, job.id)).returning();
      return j!;
    }
    return job;
  });
}

/** Retry, variation, remix, continuation: a new draft built from an earlier job. */
export async function deriveDraft(
  user: SessionUser,
  sourceJobId: string,
  relation: "retry" | "variation" | "continuation" | "extension",
  idempotencyKey: string,
  ctx: RequestContext,
): Promise<Job> {
  const [src] = await getDb()
    .select()
    .from(generationJobs)
    .where(and(eq(generationJobs.id, sourceJobId), eq(generationJobs.userId, user.id), isNull(generationJobs.deletedAt)));
  if (!src) throw notFound();
  const params = { ...src.params };
  if (relation === "variation") params.seed = randomInt(0, 2_147_483_647);
  let mode = src.mode;
  let inputAssetIds = src.inputAssetIds;
  if (relation === "continuation" || relation === "extension") {
    const [out] = await getDb()
      .select({ assetId: generationOutputs.assetId, kind: mediaAssets.kind })
      .from(generationOutputs)
      .innerJoin(mediaAssets, eq(mediaAssets.id, generationOutputs.assetId))
      .where(and(eq(generationOutputs.jobId, src.id), isNull(generationOutputs.deletedAt)))
      .limit(1);
    if (!out || out.kind !== "video") throw new HttpError(422, "unsupported", "Only finished video clips can be continued or extended.");
    mode = relation === "extension" ? "video_extension" : "scene_continuation";
    inputAssetIds = [out.assetId];
  }
  return createDraft(
    user,
    {
      idempotencyKey,
      mode,
      modelKey: src.modelKey,
      prompt: src.prompt,
      negativePrompt: src.negativePrompt,
      params,
      inputAssetIds,
      templateId: src.templateId ?? undefined,
      characterReferenceId: src.characterReferenceId ?? undefined,
      projectId: src.projectId ?? undefined,
      sceneId: src.sceneId ?? undefined,
      parentJobId: src.id,
      relation,
    },
    ctx,
  );
}

export async function getOwnedJob(userId: string, jobId: string): Promise<Job> {
  const [job] = await getDb()
    .select()
    .from(generationJobs)
    .where(and(eq(generationJobs.id, jobId), eq(generationJobs.userId, userId), isNull(generationJobs.deletedAt)));
  if (!job) throw notFound();
  return job;
}

/** Soft-deletes a creation and its media. Running jobs must be cancelled first. */
export async function deleteJob(user: SessionUser, jobId: string) {
  const now = new Date();
  await getDb().transaction(async (tx) => {
    // Locked and checked here, not before the transaction: a confirm committing in between would
    // otherwise leave a hidden job that still runs and charges.
    const [job] = await tx
      .select()
      .from(generationJobs)
      .where(and(eq(generationJobs.id, jobId), eq(generationJobs.userId, user.id), isNull(generationJobs.deletedAt)))
      .for("update");
    if (!job) throw notFound();
    if (job.status === "queued" || job.status === "processing") {
      throw new HttpError(409, "job_active", "Cancel this creation before deleting it.");
    }
    const outs = await tx
      .select({ assetId: generationOutputs.assetId, posterAssetId: generationOutputs.posterAssetId })
      .from(generationOutputs)
      .where(eq(generationOutputs.jobId, job.id));
    await tx.update(generationOutputs).set({ deletedAt: now }).where(eq(generationOutputs.jobId, job.id));
    const ids = outs.flatMap((o) => (o.posterAssetId ? [o.assetId, o.posterAssetId] : [o.assetId]));
    if (ids.length) await tx.update(mediaAssets).set({ deletedAt: now }).where(inArray(mediaAssets.id, ids));
    await tx.update(generationJobs).set({ deletedAt: now, updatedAt: now }).where(eq(generationJobs.id, job.id));
    await audit(user.id, "creation.delete", "generation_job", job.id, {}, tx);
  });
}
