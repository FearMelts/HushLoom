import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { getDb } from "@/server/db";
import { creatorProfiles, discoveryEvents, follows, mediaAssets, templateCollectionItems, templateCollections, templates } from "@/server/db/schema";
import { browseTemplates, cardsByIds } from "@/server/discovery/templates";
import { assetUrl } from "@/server/media";
import { profileByHandle } from "@/server/social";

export async function creatorPage(handle: string, viewerId: string | null) {
  const profile = await profileByHandle(handle);
  if (!profile) return null;
  const db = getDb();
  const [[creator], [followers], [following], viewerFollows, published, collections] = await Promise.all([
    db.select().from(creatorProfiles).where(eq(creatorProfiles.userId, profile.userId)),
    db.select({ n: sql<number>`count(*)::int` }).from(follows).where(eq(follows.creatorId, profile.userId)),
    db.select({ n: sql<number>`count(*)::int` }).from(follows).where(eq(follows.followerId, profile.userId)),
    viewerId ? db.select().from(follows).where(and(eq(follows.followerId, viewerId), eq(follows.creatorId, profile.userId))) : Promise.resolve([]),
    browseTemplates({ creatorId: profile.userId, sort: "new", limit: 60 }, viewerId),
    db
      .select()
      .from(templateCollections)
      .where(and(eq(templateCollections.creatorId, profile.userId), viewerId === profile.userId ? undefined : eq(templateCollections.isPublic, true)))
      .orderBy(desc(templateCollections.createdAt)),
  ]);
  const items = collections.length
    ? await db
        .select()
        .from(templateCollectionItems)
        .where(inArray(templateCollectionItems.collectionId, collections.map((c) => c.id)))
        .orderBy(asc(templateCollectionItems.position))
    : [];
  const collectionCards = await Promise.all(
    collections.map(async (c) => ({
      id: c.id,
      title: c.title,
      isPublic: c.isPublic,
      cards: await cardsByIds(items.filter((i) => i.collectionId === c.id).map((i) => i.templateId), viewerId),
    })),
  );
  const totals = published.items.reduce((acc, t) => ({ generations: acc.generations + t.generationCount, favorites: acc.favorites + t.favoriteCount }), { generations: 0, favorites: 0 });
  return {
    profile: { ...profile, createdAt: profile.createdAt.toISOString(), headline: creator?.headline ?? "" },
    followers: followers?.n ?? 0,
    following: following?.n ?? 0,
    isFollowing: viewerFollows.length > 0,
    isOwner: viewerId === profile.userId,
    templates: published.items,
    collections: collectionCards.filter((c) => c.cards.length || viewerId === profile.userId),
    totals,
  };
}

/** Owner-only view of every template the creator has, with 30-day activity counted from real events. */
export async function creatorAnalytics(creatorId: string) {
  const db = getDb();
  const rows = await db
    .select({
      t: templates,
      poster: mediaAssets,
      views30: sql<number>`(select count(*)::int from ${discoveryEvents} de where de.template_id = ${templates.id} and de.event = 'view' and de.created_at > now() - interval '30 days')`,
      generations30: sql<number>`(select count(*)::int from ${discoveryEvents} de where de.template_id = ${templates.id} and de.event = 'generate' and de.created_at > now() - interval '30 days')`,
    })
    .from(templates)
    .leftJoin(mediaAssets, eq(mediaAssets.id, templates.posterAssetId))
    .where(and(eq(templates.creatorId, creatorId), isNull(templates.deletedAt), ne(templates.status, "removed")))
    .orderBy(desc(templates.createdAt));
  return Promise.all(
    rows.map(async (r) => ({
      id: r.t.id,
      slug: r.t.slug,
      title: r.t.title,
      description: r.t.description,
      status: r.t.status,
      isVip: r.t.isVip,
      mediaType: r.t.mediaType,
      version: r.t.currentVersion,
      posterUrl: r.poster ? await assetUrl(r.poster, creatorId) : null,
      favorites: r.t.favoriteCount,
      generations: r.t.generationCount,
      rating: r.t.ratingCount ? Math.round((r.t.ratingSum / r.t.ratingCount) * 10) / 10 : null,
      ratingCount: r.t.ratingCount,
      views30: r.views30,
      generations30: r.generations30,
    })),
  );
}
