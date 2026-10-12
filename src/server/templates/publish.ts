import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getModel } from "@/server/ai/registry";
import { audit } from "@/server/audit";
import type { SessionUser } from "@/server/auth/session";
import { getDb } from "@/server/db";
import {
  creatorProfiles,
  generationJobs,
  generationOutputs,
  mediaAssets,
  moderationEvents,
  templateCategories,
  templates,
  templateVersions,
  users,
} from "@/server/db/schema";
import { HttpError, notFound } from "@/server/http";
import { checkPrompt } from "@/server/safety/policy";
import { newStorageKey, storage } from "@/server/storage";

export const publishSchema = z.object({
  jobId: z.string().uuid(),
  title: z.string().trim().min(2).max(60),
  description: z.string().trim().max(500).default(""),
  categorySlug: z.string().max(40).optional(),
  tags: z.array(z.string().trim().toLowerCase().min(1).max(24)).max(8).default([]),
  isVip: z.boolean().default(false),
});

function slugify(title: string) {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "template";
  return `${base}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Publishing is always an explicit act. The private output is copied to a new
 * public asset; the original stays private. Creations made from personal
 * uploads or character references cannot be published.
 */
export async function publishTemplate(user: SessionUser, input: z.infer<typeof publishSchema>) {
  const db = getDb();
  const [job] = await db
    .select()
    .from(generationJobs)
    .where(and(eq(generationJobs.id, input.jobId), eq(generationJobs.userId, user.id), isNull(generationJobs.deletedAt)));
  if (!job) throw notFound();
  if (job.status !== "completed") throw new HttpError(409, "not_ready", "Only finished creations can be published.");
  if (job.inputAssetIds.length || job.characterReferenceId) {
    throw new HttpError(
      403,
      "personal_media",
      "Creations made from your uploads or character references stay private, to protect the people in them. Publish one made from a prompt or template instead.",
    );
  }
  const verdict = checkPrompt(input.title, input.description, input.tags.join(" "), job.prompt);
  if (!verdict.allowed) {
    await db.insert(moderationEvents).values({ subjectType: "template", subjectId: job.id, action: "auto_block", status: "resolved", reason: verdict.category, details: { matched: verdict.matched }, resolvedAt: new Date() });
    throw new HttpError(422, "policy_blocked", verdict.message);
  }
  const [out] = await db
    .select({ asset: mediaAssets })
    .from(generationOutputs)
    .innerJoin(mediaAssets, eq(mediaAssets.id, generationOutputs.assetId))
    .where(and(eq(generationOutputs.jobId, job.id), isNull(generationOutputs.deletedAt)))
    .limit(1);
  if (!out) throw new HttpError(409, "no_output", "This creation has no output to publish.");

  const bytes = await storage().get(out.asset.storageKey);
  const ext = out.asset.mime === "video/mp4" ? "mp4" : "webp";
  const key = newStorageKey("templates", user.id, ext);
  await storage().put(key, bytes, out.asset.mime);

  const category = input.categorySlug
    ? (await db.select().from(templateCategories).where(eq(templateCategories.slug, input.categorySlug)))[0]
    : undefined;
  const model = getModel(job.modelKey);

  return db.transaction(async (tx) => {
    const [publicAsset] = await tx
      .insert(mediaAssets)
      .values({ ...out.asset, id: undefined, storageKey: key, visibility: "public", createdAt: new Date(), deletedAt: null })
      .returning();
    const isVideo = out.asset.kind === "video";
    const [t] = await tx
      .insert(templates)
      .values({
        slug: slugify(input.title),
        creatorId: user.id,
        categoryId: category?.id,
        title: input.title,
        description: input.description,
        mediaType: out.asset.kind,
        mode: job.mode,
        tags: input.tags,
        status: "published",
        isVip: input.isVip,
        quality: job.params.quality ?? "hd",
        durationS: isVideo ? (job.params.durationS ?? null) : null,
        posterAssetId: isVideo ? null : publicAsset!.id,
        previewAssetId: isVideo ? publicAsset!.id : null,
        remixedFromId: job.templateId,
        publishedAt: new Date(),
      })
      .returning();
    await tx.insert(templateVersions).values({
      templateId: t!.id,
      version: 1,
      prompt: job.prompt,
      negativePrompt: job.negativePrompt,
      modelKey: model?.key ?? job.modelKey,
      defaults: Object.fromEntries(Object.entries(job.params).filter(([k]) => k !== "seed")),
      changelog: "First version",
    });
    if (user.role === "member") await tx.update(users).set({ role: "creator" }).where(eq(users.id, user.id));
    await tx.insert(creatorProfiles).values({ userId: user.id }).onConflictDoNothing();
    await audit(user.id, "template.publish", "template", t!.id, { fromJob: job.id }, tx);
    return t!;
  });
}

export const updateTemplateSchema = z.object({
  title: z.string().trim().min(2).max(60).optional(),
  description: z.string().trim().max(500).optional(),
  tags: z.array(z.string().trim().toLowerCase().min(1).max(24)).max(8).optional(),
  categorySlug: z.string().max(40).optional(),
  isVip: z.boolean().optional(),
  status: z.enum(["published", "unpublished"]).optional(),
  prompt: z.string().trim().min(1).max(2000).optional(),
  changelog: z.string().trim().max(200).optional(),
});

/** Metadata edits apply in place; a prompt change creates a new template version. */
export async function updateTemplate(user: SessionUser, templateId: string, input: z.infer<typeof updateTemplateSchema>) {
  const db = getDb();
  const [t] = await db.select().from(templates).where(and(eq(templates.id, templateId), isNull(templates.deletedAt)));
  if (!t || (t.creatorId !== user.id && user.role !== "admin")) throw notFound();
  if (t.status === "removed") throw new HttpError(403, "removed", "This template was removed by moderation.");
  const verdict = checkPrompt(input.title ?? "", input.description ?? "", (input.tags ?? []).join(" "), input.prompt ?? "");
  if (!verdict.allowed) throw new HttpError(422, "policy_blocked", verdict.message);
  const category = input.categorySlug
    ? (await db.select().from(templateCategories).where(eq(templateCategories.slug, input.categorySlug)))[0]
    : undefined;

  return db.transaction(async (tx) => {
    let version = t.currentVersion;
    if (input.prompt) {
      const [current] = await tx
        .select()
        .from(templateVersions)
        .where(and(eq(templateVersions.templateId, t.id), eq(templateVersions.version, t.currentVersion)));
      if (current && current.prompt !== input.prompt) {
        version = t.currentVersion + 1;
        await tx.insert(templateVersions).values({
          templateId: t.id,
          version,
          prompt: input.prompt,
          negativePrompt: current.negativePrompt,
          modelKey: current.modelKey,
          defaults: current.defaults,
          changelog: input.changelog ?? "",
        });
      }
    }
    const [updated] = await tx
      .update(templates)
      .set({
        title: input.title ?? t.title,
        description: input.description ?? t.description,
        tags: input.tags ?? t.tags,
        categoryId: category?.id ?? t.categoryId,
        isVip: input.isVip ?? t.isVip,
        status: input.status ?? t.status,
        publishedAt: input.status === "published" && !t.publishedAt ? new Date() : t.publishedAt,
        currentVersion: version,
        updatedAt: new Date(),
      })
      .where(eq(templates.id, t.id))
      .returning();
    await audit(user.id, "template.update", "template", t.id, { fields: Object.keys(input) }, tx);
    return updated!;
  });
}

export async function rateTemplate(userId: string, templateId: string, score: number) {
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`
      insert into template_ratings (user_id, template_id, score) values (${userId}, ${templateId}, ${score})
      on conflict (user_id, template_id) do update set score = excluded.score
    `);
    // Recompute from the source rows so concurrent ratings can never drift the totals.
    await tx.execute(sql`
      update templates set
        rating_sum = coalesce((select sum(score) from template_ratings where template_id = ${templateId}), 0),
        rating_count = (select count(*) from template_ratings where template_id = ${templateId})
      where id = ${templateId}
    `);
  });
}
