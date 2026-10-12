import { randomInt } from "node:crypto";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { MODE_INPUTS, estimateCost, getModel, validateAgainstModel, type GenerationMode } from "@/server/ai/registry";
import { listModelAvailability } from "@/server/ai/providers";
import { audit } from "@/server/audit";
import type { SessionUser } from "@/server/auth/session";
import { releaseJob, reserveForJob } from "@/server/credits/ledger";
import { getDb } from "@/server/db";
import {
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
import { ageAssuranceBlocksRegion, checkPrompt } from "@/server/safety/policy";
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

export const paramsSchema = z
  .object({
    aspectRatio: z.string().regex(/^\d{1,2}:\d{1,2}$/).optional(),
    durationS: z.number().int().min(1).max(60).optional(),
    quality: z.enum(["hd", "4k"]).optional(),
    motionIntensity: z.number().int().min(1).max(10).optional(),
    cameraMovement: z.string().max(40).optional(),
    pacing: z.string().max(40).optional(),
    atmosphere: z.string().max(80).optional(),
    lighting: z.string().max(40).optional(),
    framing: z.string().max(40).optional(),
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

export type DraftInput = z.infer<typeof draftSchema>;

type RequestContext = { country: string | null };

const ACTIVE: Job["status"][] = ["queued", "processing"];

async function hasVip(userId: string): Promise<boolean> {
  const vipPlans = pricing.plans.filter((p) => p.vip).map((p) => p.key);
  const [row] = await getDb()
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        inArray(subscriptions.planKey, vipPlans),
        inArray(subscriptions.status, ["active", "trialing"]),
        or(isNull(subscriptions.currentPeriodEnd), gt(subscriptions.currentPeriodEnd, new Date())),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export { hasVip };

/** Inputs must be the user's own consented uploads or the user's own outputs. */
async function validateInputs(userId: string, mode: GenerationMode, assetIds: string[]) {
  const need = MODE_INPUTS[mode];
  const assets = assetIds.length
    ? await getDb()
        .select()
        .from(mediaAssets)
        .where(and(inArray(mediaAssets.id, assetIds), eq(mediaAssets.ownerId, userId), isNull(mediaAssets.deletedAt)))
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

  if (ageAssuranceBlocksRegion(user.ageAssuranceMethod, ctx.country, env().AGE_ASSURANCE_STRICT_REGIONS)) {
    throw new HttpError(
      451,
      "age_assurance_required",
      "Your region requires verified age assurance before creating. Verification is not available yet in this build.",
    );
  }

  const availability = await listModelAvailability();
  const model = availability.find((m) => m.key === input.modelKey);
  if (!model || !getModel(input.modelKey)) throw new HttpError(422, "unknown_model", "That model does not exist.");
  if (!model.available) throw new HttpError(503, "model_unavailable", `${model.displayName} is unavailable: ${model.reason}.`);

  const issues = validateAgainstModel(model, input.mode, input.params, input.negativePrompt);
  if (issues.length) throw new HttpError(422, "unsupported_settings", issues[0]!.message, { issues });

  const verdict = checkPrompt(input.prompt, input.negativePrompt, input.params.atmosphere ?? "");
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
  const maxActive = env().USER_MAX_ACTIVE_JOBS;
  const result = await getDb().transaction(async (tx) => {
    const [job] = await tx
      .select()
      .from(generationJobs)
      .where(and(eq(generationJobs.id, jobId), eq(generationJobs.userId, user.id)))
      .for("update");
    if (!job) throw notFound();
    if (job.status !== "awaiting_confirmation") return { job, enqueue: false };
    if (job.costCredits !== expectedCost) {
      throw new HttpError(409, "cost_changed", `The cost is now ${job.costCredits} credits. Review and confirm again.`, { cost: job.costCredits });
    }
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
  if (result.enqueue) await enqueueGeneration(result.job.id, 0, 1);
  return result.job;
}

export async function cancelJob(user: SessionUser, jobId: string): Promise<Job> {
  return getDb().transaction(async (tx) => {
    const [job] = await tx
      .select()
      .from(generationJobs)
      .where(and(eq(generationJobs.id, jobId), eq(generationJobs.userId, user.id)))
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
  const job = await getOwnedJob(user.id, jobId);
  if (job.status === "queued" || job.status === "processing") {
    throw new HttpError(409, "job_active", "Cancel this creation before deleting it.");
  }
  const now = new Date();
  await getDb().transaction(async (tx) => {
    const outs = await tx.select({ assetId: generationOutputs.assetId }).from(generationOutputs).where(eq(generationOutputs.jobId, job.id));
    await tx.update(generationOutputs).set({ deletedAt: now }).where(eq(generationOutputs.jobId, job.id));
    if (outs.length) await tx.update(mediaAssets).set({ deletedAt: now }).where(inArray(mediaAssets.id, outs.map((o) => o.assetId)));
    await tx.update(generationJobs).set({ deletedAt: now, updatedAt: now }).where(eq(generationJobs.id, job.id));
    await audit(user.id, "creation.delete", "generation_job", job.id, {}, tx);
  });
}
