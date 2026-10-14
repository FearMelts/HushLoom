import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { getModel } from "@/server/ai/registry";
import { audit } from "@/server/audit";
import type { SessionUser } from "@/server/auth/session";
import { getDb, type Tx } from "@/server/db";
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
import { checkPrompt, paramTexts } from "@/server/safety/policy";
import { isTakenDownOrHeld, lockContent } from "@/server/safety/takedowns";
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
  // The settings become the public recipe's defaults, so their free text is checked too (a job older than the closed lists may carry any).
  const verdict = checkPrompt(input.title, input.description, input.tags.join(" "), job.prompt, job.negativePrompt, ...paramTexts(job.params));
  if (!verdict.allowed) {
    await db.insert(moderationEvents).values({ subjectType: "template", subjectId: job.id, action: "auto_block", status: "resolved", reason: verdict.category, details: { matched: verdict.matched }, resolvedAt: new Date() });
    throw new HttpError(422, "policy_blocked", verdict.message);
  }
  const [out] = await db
    .select({ asset: mediaAssets, posterAssetId: generationOutputs.posterAssetId })
    .from(generationOutputs)
    .innerJoin(mediaAssets, eq(mediaAssets.id, generationOutputs.assetId))
    .where(and(eq(generationOutputs.jobId, job.id), isNull(generationOutputs.deletedAt)))
    .limit(1);
  if (!out) throw new HttpError(409, "no_output", "This creation has no output to publish.");
  // Nothing the abuse scanner has not cleared is ever made public (addendum §3).
  const [poster] = out.posterAssetId ? await db.select().from(mediaAssets).where(eq(mediaAssets.id, out.posterAssetId)) : [];
  const media = poster ? [out.asset, poster] : [out.asset];
  if (media.some((m) => m.scanStatus !== "clean" || m.legalHold)) throw notCleared();
  // A takedown reaches the copies that exist when it is actioned; the same file made again later
  // (the same prompt and seed, a retry, another account) is refused here, by its bytes.
  if (await isTakenDownOrHeld(db, media.map((m) => m.sha256))) {
    await db.insert(moderationEvents).values({ subjectType: "template", subjectId: job.id, action: "auto_block", status: "resolved", reason: "taken_down", details: { assetId: out.asset.id }, resolvedAt: new Date() });
    throw takenDown();
  }

  const bytes = await storage().get(out.asset.storageKey);
  const ext = out.asset.mime === "video/mp4" ? "mp4" : "webp";
  const key = newStorageKey("templates", user.id, ext);
  await storage().put(key, bytes, out.asset.mime);
  // A clip's poster frame becomes the template's cover, also as a separate public copy.
  const posterKey = poster ? newStorageKey("templates", user.id, "webp") : null;
  if (poster && posterKey) await storage().put(posterKey, await storage().get(poster.storageKey), poster.mime);

  const category = input.categorySlug
    ? (await db.select().from(templateCategories).where(eq(templateCategories.slug, input.categorySlug)))[0]
    : undefined;
  const model = getModel(job.modelKey);

  try {
    return await db.transaction(async (tx) => {
      // The checks above ran before the copy, which can take a while (up to 100 MB from S3); a
      // takedown, a hold or a deletion may have committed meanwhile. They run again on fresh rows
      // under the file's lock, which a takedown also takes before it looks for copies: one that
      // committed first is seen here, and one that comes later finds this copy and takes it down.
      await lockContent(tx, media.map((m) => m.sha256));
      await stillPublishable(tx, user.id, job.id, media.map((m) => m.id));
      // The public copies are the same bytes, so they carry the source's recorded clean verdict.
      const [publicAsset] = await tx
        .insert(mediaAssets)
        .values({ ...out.asset, id: undefined, storageKey: key, visibility: "public", scanStatus: "clean", legalHold: false, createdAt: new Date(), deletedAt: null })
        .returning();
      const isVideo = out.asset.kind === "video";
      const [publicPoster] =
        poster && posterKey
          ? await tx
              .insert(mediaAssets)
              .values({ ...poster, id: undefined, storageKey: posterKey, visibility: "public", scanStatus: "clean", legalHold: false, createdAt: new Date(), deletedAt: null })
              .returning()
          : [];
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
          posterAssetId: isVideo ? (publicPoster?.id ?? null) : publicAsset!.id,
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
      // A suspension signs the account out and unpublishes everything it has live, but a request
      // already past requireUser still gets here, and that unpublish cannot see this template until
      // it commits. So the account is read under a lock held to the commit: a suspension that came
      // first is seen here, and one that comes later waits, then unpublishes this template too.
      const [account] = await tx.select({ status: users.status }).from(users).where(eq(users.id, user.id)).for("no key update");
      if (account?.status !== "active") throw new HttpError(403, "creator_suspended", "This account is suspended, so it can't publish templates.");
      if (user.role === "member") await tx.update(users).set({ role: "creator" }).where(eq(users.id, user.id));
      await tx.insert(creatorProfiles).values({ userId: user.id }).onConflictDoNothing();
      await audit(user.id, "template.publish", "template", t!.id, { fromJob: job.id }, tx);
      return t!;
    });
  } catch (err) {
    // Nothing was published, so the public copies made above go too.
    for (const k of [key, posterKey]) if (k) await storage().delete(k).catch(() => undefined);
    throw err;
  }
}

const notCleared = () => new HttpError(409, "not_cleared", "This creation hasn't cleared our safety checks, so it can't be published.");
const takenDown = () => new HttpError(409, "taken_down", "This creation matches content that was removed after a takedown request, so it can't be published.");

/** publishTemplate's checks on the creation and its media, made again on fresh rows inside its transaction. */
async function stillPublishable(tx: Tx, userId: string, jobId: string, assetIds: string[]) {
  const [job] = await tx
    .select({ id: generationJobs.id })
    .from(generationJobs)
    .where(and(eq(generationJobs.id, jobId), eq(generationJobs.userId, userId), isNull(generationJobs.deletedAt)));
  const [out] = await tx
    .select({ id: generationOutputs.id })
    .from(generationOutputs)
    .where(and(eq(generationOutputs.jobId, jobId), eq(generationOutputs.assetId, assetIds[0]!), isNull(generationOutputs.deletedAt)));
  const media = await tx.select().from(mediaAssets).where(inArray(mediaAssets.id, assetIds));
  if (!job || !out || media.length !== assetIds.length || media.some((m) => m.deletedAt)) throw notFound();
  if (media.some((m) => m.scanStatus !== "clean" || m.legalHold)) throw notCleared();
  if (await isTakenDownOrHeld(tx, media.map((m) => m.sha256))) throw takenDown();
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

/**
 * Metadata edits apply in place; a prompt change creates a new template version. The row is read
 * and locked inside the transaction and only the fields the request supplied are written, so an
 * edit in flight never writes back a status, version or field that moderation, a suspension or
 * another edit changed meanwhile.
 */
export async function updateTemplate(user: SessionUser, templateId: string, input: z.infer<typeof updateTemplateSchema>) {
  return getDb().transaction(async (tx) => {
    const [t] = await tx.select().from(templates).where(and(eq(templates.id, templateId), isNull(templates.deletedAt))).for("update");
    if (!t || (t.creatorId !== user.id && user.role !== "admin")) throw notFound();
    if (t.status === "removed") throw new HttpError(403, "removed", "This template was removed by moderation.");
    const verdict = checkPrompt(input.title ?? "", input.description ?? "", (input.tags ?? []).join(" "), input.prompt ?? "");
    if (!verdict.allowed) throw new HttpError(422, "policy_blocked", verdict.message);
    const category = input.categorySlug
      ? (await tx.select().from(templateCategories).where(eq(templateCategories.slug, input.categorySlug)))[0]
      : undefined;
    if (input.status === "published") {
      // A suspension unpublishes everything the account had live; nothing goes back up until it is
      // lifted. Its unpublish skips a template that is not live yet, so the account is read last,
      // under a share lock held to the write: a suspension either committed first and is seen here,
      // or waits for this edit and then takes the template down. A template already live needs no
      // lock: that unpublish waits on this row's lock instead (and locking both could deadlock).
      const account = tx.select({ status: users.status }).from(users).where(eq(users.id, t.creatorId));
      const [creator] = t.status === "published" ? await account : await account.for("share");
      if (creator?.status !== "active") throw new HttpError(403, "creator_suspended", "This account is suspended, so its templates stay unpublished.");
    }

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
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(category ? { categoryId: category.id } : {}),
        ...(input.isVip !== undefined ? { isVip: input.isVip } : {}),
        // Only an explicit request changes the status.
        ...(input.status ? { status: input.status, publishedAt: input.status === "published" && !t.publishedAt ? new Date() : t.publishedAt } : {}),
        currentVersion: version,
        updatedAt: new Date(),
      })
      .where(and(eq(templates.id, t.id), ne(templates.status, "removed")))
      .returning();
    if (!updated) throw new HttpError(403, "removed", "This template was removed by moderation.");
    await audit(user.id, "template.update", "template", t.id, { fields: Object.keys(input) }, tx);
    return updated;
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
