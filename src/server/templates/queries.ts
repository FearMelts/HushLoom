import { and, eq, isNull, or, desc } from "drizzle-orm";
import { getDb } from "@/server/db";
import { follows, templateCategories, templateRatings, templateVersions, templates, userProfiles } from "@/server/db/schema";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A template visible to the viewer: published, or the viewer's own (any status but removed for others). */
export async function templateForViewer(idOrSlug: string, viewerId: string | null) {
  const db = getDb();
  const [row] = await db
    .select({ t: templates, handle: userProfiles.handle, displayName: userProfiles.displayName, bio: userProfiles.bio, category: templateCategories })
    .from(templates)
    .innerJoin(userProfiles, eq(userProfiles.userId, templates.creatorId))
    .leftJoin(templateCategories, eq(templateCategories.id, templates.categoryId))
    .where(and(UUID.test(idOrSlug) ? or(eq(templates.id, idOrSlug), eq(templates.slug, idOrSlug)) : eq(templates.slug, idOrSlug), isNull(templates.deletedAt)));
  if (!row) return null;
  const own = viewerId === row.t.creatorId;
  if (row.t.status !== "published" && !own) return null;
  const [version] = await db
    .select()
    .from(templateVersions)
    .where(and(eq(templateVersions.templateId, row.t.id), eq(templateVersions.version, row.t.currentVersion)));
  const versions = await db
    .select({ version: templateVersions.version, changelog: templateVersions.changelog, createdAt: templateVersions.createdAt })
    .from(templateVersions)
    .where(eq(templateVersions.templateId, row.t.id))
    .orderBy(desc(templateVersions.version));
  const [rating] = viewerId
    ? await db.select().from(templateRatings).where(and(eq(templateRatings.templateId, row.t.id), eq(templateRatings.userId, viewerId)))
    : [];
  const [follow] = viewerId
    ? await db.select().from(follows).where(and(eq(follows.followerId, viewerId), eq(follows.creatorId, row.t.creatorId)))
    : [];
  const [remixedFrom] = row.t.remixedFromId
    ? await db.select({ slug: templates.slug, title: templates.title }).from(templates).where(eq(templates.id, row.t.remixedFromId))
    : [];
  return { ...row, version: version!, versions, myRating: rating?.score ?? null, following: Boolean(follow), own, remixedFrom: remixedFrom ?? null };
}
