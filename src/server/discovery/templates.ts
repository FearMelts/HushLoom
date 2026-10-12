import { and, desc, eq, ilike, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/server/db";
import {
  discoveryEvents,
  favorites,
  follows,
  mediaAssets,
  templateCategories,
  templates,
  userPreferences,
  userProfiles,
} from "@/server/db/schema";
import { assetUrl } from "@/server/media";

export type SortKey = "trending" | "new" | "top_rated" | "most_favorited";

export type TemplateCard = {
  id: string;
  slug: string;
  title: string;
  creator: { id: string; handle: string; displayName: string };
  category: string | null;
  mediaType: "image" | "video";
  mode: string;
  durationS: number | null;
  isVip: boolean;
  quality: string;
  isNew: boolean;
  posterUrl: string | null;
  previewUrl: string | null;
  posterWidth: number | null;
  posterHeight: number | null;
  favoriteCount: number;
  generationCount: number;
  rating: number | null;
  isFavorited: boolean;
  tags: string[];
};

const NEW_DAYS = 7;

const trendingScore = sql<number>`(
  coalesce((select count(*) from ${discoveryEvents} de where de.template_id = ${templates.id} and de.event = 'generate' and de.created_at > now() - interval '7 days'), 0) * 3
  + ${templates.favoriteCount} * 2 + ${templates.generationCount}
)`;
// Bayesian average with a prior of 3 ratings at 3 stars, so one 5-star vote does not top the chart.
const ratingScore = sql<number>`((${templates.ratingSum} + 9)::float / (${templates.ratingCount} + 3))`;

function sortExpr(sort: SortKey): SQL[] {
  switch (sort) {
    case "new":
      return [desc(templates.publishedAt)];
    case "top_rated":
      return [desc(ratingScore), desc(templates.ratingCount)];
    case "most_favorited":
      return [desc(templates.favoriteCount), desc(templates.publishedAt)];
    default:
      return [desc(trendingScore), desc(templates.publishedAt)];
  }
}

const baseSelect = {
  t: templates,
  handle: userProfiles.handle,
  displayName: userProfiles.displayName,
  category: templateCategories.slug,
  poster: mediaAssets,
};

type Row = {
  t: typeof templates.$inferSelect;
  handle: string;
  displayName: string;
  category: string | null;
  poster: typeof mediaAssets.$inferSelect | null;
};

async function toCards(rows: Row[], viewerId: string | null): Promise<TemplateCard[]> {
  const ids = rows.map((r) => r.t.id);
  const favs =
    viewerId && ids.length
      ? await getDb()
          .select({ id: favorites.targetId })
          .from(favorites)
          .where(and(eq(favorites.userId, viewerId), eq(favorites.targetType, "template"), inArray(favorites.targetId, ids)))
      : [];
  const favSet = new Set(favs.map((f) => f.id));
  const previewIds = rows.map((r) => r.t.previewAssetId).filter((x): x is string => Boolean(x));
  const previews = previewIds.length ? await getDb().select().from(mediaAssets).where(inArray(mediaAssets.id, previewIds)) : [];
  return Promise.all(
    rows.map(async (r) => {
      const preview = previews.find((p) => p.id === r.t.previewAssetId);
      return {
        id: r.t.id,
        slug: r.t.slug,
        title: r.t.title,
        creator: { id: r.t.creatorId, handle: r.handle, displayName: r.displayName },
        category: r.category,
        mediaType: r.t.mediaType,
        mode: r.t.mode,
        durationS: r.t.durationS,
        isVip: r.t.isVip,
        quality: r.t.quality,
        isNew: Boolean(r.t.publishedAt && Date.now() - r.t.publishedAt.getTime() < NEW_DAYS * 86_400_000),
        posterUrl: r.poster ? await assetUrl(r.poster, viewerId) : null,
        previewUrl: preview ? await assetUrl(preview, viewerId) : null,
        posterWidth: r.poster?.width ?? null,
        posterHeight: r.poster?.height ?? null,
        favoriteCount: r.t.favoriteCount,
        generationCount: r.t.generationCount,
        rating: r.t.ratingCount ? Math.round(((r.t.ratingSum / r.t.ratingCount) * 10)) / 10 : null,
        isFavorited: favSet.has(r.t.id),
        tags: r.t.tags,
      };
    }),
  );
}

function selectCards() {
  return getDb()
    .select(baseSelect)
    .from(templates)
    .innerJoin(userProfiles, eq(userProfiles.userId, templates.creatorId))
    .leftJoin(templateCategories, eq(templateCategories.id, templates.categoryId))
    .leftJoin(mediaAssets, eq(mediaAssets.id, templates.posterAssetId));
}

const published = and(eq(templates.status, "published"), isNull(templates.deletedAt));

export type BrowseQuery = {
  q?: string;
  category?: string;
  media?: "image" | "video";
  sort?: SortKey;
  creatorId?: string;
  vipOnly?: boolean;
  limit?: number;
  offset?: number;
};

export async function browseTemplates(query: BrowseQuery, viewerId: string | null) {
  const conds: (SQL | undefined)[] = [published];
  if (query.q?.trim()) {
    const like = `%${query.q.trim().replace(/[%_]/g, "\\$&")}%`;
    conds.push(
      or(
        ilike(templates.title, like),
        ilike(templates.description, like),
        ilike(userProfiles.handle, like),
        sql`exists (select 1 from unnest(${templates.tags}) tag where tag ilike ${like})`,
      ),
    );
  }
  if (query.category) conds.push(eq(templateCategories.slug, query.category));
  if (query.media) conds.push(eq(templates.mediaType, query.media));
  if (query.creatorId) conds.push(eq(templates.creatorId, query.creatorId));
  if (query.vipOnly) conds.push(eq(templates.isVip, true));
  const limit = Math.min(query.limit ?? 24, 60);
  const rows = await selectCards()
    .where(and(...conds))
    .orderBy(...sortExpr(query.sort ?? "trending"), desc(templates.id))
    .limit(limit + 1)
    .offset(query.offset ?? 0);
  return { items: await toCards(rows.slice(0, limit), viewerId), hasMore: rows.length > limit };
}

export async function cardsByIds(ids: string[], viewerId: string | null): Promise<TemplateCard[]> {
  if (!ids.length) return [];
  const rows = await selectCards().where(and(published, inArray(templates.id, ids)));
  const cards = await toCards(rows, viewerId);
  return ids.map((id) => cards.find((c) => c.id === id)).filter((c): c is TemplateCard => Boolean(c));
}

export async function similarTemplates(templateId: string, viewerId: string | null, limit = 8) {
  const [t] = await getDb().select().from(templates).where(eq(templates.id, templateId));
  if (!t) return [];
  const overlap = sql<number>`(
    (case when ${templates.categoryId} = ${t.categoryId} then 2 else 0 end)
    + coalesce(array_length(array(select unnest(${templates.tags}) intersect select unnest(${t.tags}::text[])), 1), 0)
  )`;
  const rows = await selectCards()
    .where(and(published, ne(templates.id, templateId), sql`${overlap} > 0`))
    .orderBy(desc(overlap), desc(templates.favoriteCount))
    .limit(limit);
  return toCards(rows, viewerId);
}

export async function recentlyViewed(viewerId: string, limit = 12) {
  const recent = await getDb()
    .select({ id: discoveryEvents.templateId, last: sql<Date>`max(${discoveryEvents.createdAt})` })
    .from(discoveryEvents)
    .where(and(eq(discoveryEvents.userId, viewerId), eq(discoveryEvents.event, "view")))
    .groupBy(discoveryEvents.templateId)
    .orderBy(desc(sql`max(${discoveryEvents.createdAt})`))
    .limit(limit);
  return cardsByIds(recent.map((r) => r.id), viewerId);
}

export async function followingFeed(viewerId: string, limit = 12) {
  const rows = await selectCards()
    .where(and(published, inArray(templates.creatorId, getDb().select({ id: follows.creatorId }).from(follows).where(eq(follows.followerId, viewerId)))))
    .orderBy(desc(templates.publishedAt))
    .limit(limit);
  return toCards(rows, viewerId);
}

/**
 * "For You": category and tag affinity from the viewer's favorites, generations,
 * stated interests and (if they allow it) views. Only template categories and tags
 * are used; nothing about the person is inferred.
 */
export async function forYou(viewerId: string, limit = 12): Promise<{ items: TemplateCard[]; personalized: boolean }> {
  const [prefs] = await getDb().select().from(userPreferences).where(eq(userPreferences.userId, viewerId));
  if (prefs && !prefs.personalizationEnabled) return { items: (await browseTemplates({ sort: "trending", limit }, viewerId)).items, personalized: false };

  const historyEvents = prefs?.historyEnabled === false ? sql`'generate'` : sql`'generate', 'view'`;
  const affinity = await getDb().execute<{ category_id: string | null; tag: string | null; w: number }>(sql`
    with signals as (
      select t.category_id, t.tags, 3 as w from ${favorites} f join ${templates} t on t.id = f.target_id
        where f.user_id = ${viewerId} and f.target_type = 'template'
      union all
      select t.category_id, t.tags, case when de.event = 'generate' then 2 else 1 end from ${discoveryEvents} de
        join ${templates} t on t.id = de.template_id
        where de.user_id = ${viewerId} and de.event in (${historyEvents}) and de.created_at > now() - interval '90 days'
    )
    select category_id, null as tag, sum(w)::int as w from signals group by category_id
    union all
    select null, tag, sum(w)::int from signals, unnest(tags) tag group by tag
  `);
  const interests = prefs?.interests ?? [];
  if (affinity.length === 0 && interests.length === 0) {
    return { items: (await browseTemplates({ sort: "trending", limit }, viewerId)).items, personalized: false };
  }
  const catWeights = affinity.filter((a) => a.category_id).map((a) => sql`when ${templates.categoryId} = ${a.category_id} then ${a.w}`);
  const tagWeights = [
    ...affinity.filter((a) => a.tag).map((a) => ({ tag: a.tag!, w: a.w })),
    ...interests.map((tag) => ({ tag, w: 4 })),
  ];
  const catScore = catWeights.length ? sql`(case ${sql.join(catWeights, sql` `)} else 0 end)` : sql`0`;
  const tagScore = tagWeights.length
    ? sql`(${sql.join(
        tagWeights.map((tw) => sql`(case when ${tw.tag} = any(${templates.tags}) then ${tw.w} else 0 end)`),
        sql` + `,
      )})`
    : sql`0`;
  const score = sql`(${catScore} + ${tagScore} + ln(1 + ${templates.favoriteCount} + ${templates.generationCount}))`;
  const rows = await selectCards()
    .where(and(published, ne(templates.creatorId, viewerId)))
    .orderBy(desc(score), desc(templates.publishedAt))
    .limit(limit);
  return { items: await toCards(rows, viewerId), personalized: true };
}

export async function listCategories() {
  return getDb().select().from(templateCategories).orderBy(templateCategories.sortOrder);
}
