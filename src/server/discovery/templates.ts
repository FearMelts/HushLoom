import { and, desc, eq, ilike, inArray, isNull, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { getModel } from "@/server/ai/registry";
import { adapterFor } from "@/server/ai/providers";
import { getDb } from "@/server/db";
import {
  discoveryEvents,
  favorites,
  follows,
  mediaAssets,
  templateCategories,
  templates,
  templateVersions,
  userPreferences,
  userProfiles,
} from "@/server/db/schema";
import { assetUrl } from "@/server/media";
import type { Viewer } from "@/server/age/service";

export type { Viewer };

/**
 * Whether a model key belongs to a demonstration adapter (no AI model is called). A template's
 * cover and preview were made with its version's model, so a demo model means demo media, and
 * the card says so (audit D1). Unknown keys are not claimed to be demos.
 */
export function isDemoModelKey(modelKey: string | null | undefined): boolean {
  const model = modelKey ? getModel(modelKey) : undefined;
  return model ? (adapterFor(model)?.isDemo ?? false) : false;
}

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
  /** The current version runs on a demo model, so the cover and preview are labeled placeholders, not AI output. */
  isDemo: boolean;
  posterUrl: string | null;
  previewUrl: string | null;
  /** True when the viewer must verify their age (or sign in and verify) before media is issued; titles and metadata still show. */
  mediaWithheld: boolean;
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
  modelKey: templateVersions.modelKey,
};

type Row = {
  t: typeof templates.$inferSelect;
  handle: string;
  displayName: string;
  category: string | null;
  poster: typeof mediaAssets.$inferSelect | null;
  modelKey: string | null;
};

/**
 * Every public template is explicit on an adults-only site, so a viewer who still needs an age
 * check (addendum §2) gets the card without media: no signed URL is issued at all, rather than a
 * blurred image the client could unblur.
 */
async function toCards(rows: Row[], viewer: Viewer): Promise<TemplateCard[]> {
  const viewerId = viewer.id;
  const ids = rows.map((r) => r.t.id);
  const favs =
    viewerId && ids.length
      ? await getDb()
          .select({ id: favorites.targetId })
          .from(favorites)
          .where(and(eq(favorites.userId, viewerId), eq(favorites.targetType, "template"), inArray(favorites.targetId, ids)))
      : [];
  const favSet = new Set(favs.map((f) => f.id));
  const previewIds = viewer.explicitAllowed ? rows.map((r) => r.t.previewAssetId).filter((x): x is string => Boolean(x)) : [];
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
        isDemo: isDemoModelKey(r.modelKey),
        posterUrl: viewer.explicitAllowed && r.poster ? await assetUrl(r.poster, viewerId) : null,
        previewUrl: viewer.explicitAllowed && preview ? await assetUrl(preview, viewerId) : null,
        mediaWithheld: !viewer.explicitAllowed,
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
    .leftJoin(mediaAssets, eq(mediaAssets.id, templates.posterAssetId))
    .leftJoin(templateVersions, and(eq(templateVersions.templateId, templates.id), eq(templateVersions.version, templates.currentVersion)));
}

const published = and(eq(templates.status, "published"), isNull(templates.deletedAt));

export type BrowseQuery = {
  q?: string;
  category?: string;
  media?: "image" | "video";
  sort?: SortKey;
  creatorId?: string;
  vipOnly?: boolean;
  /** Exact tag (lowercase, as stored), for "More in #tag" rails. */
  tag?: string;
  /** Leave these templates out (the one being viewed, or ones another rail already shows). */
  excludeIds?: string[];
  limit?: number;
  offset?: number;
};

export async function browseTemplates(query: BrowseQuery, viewer: Viewer) {
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
  if (query.tag) conds.push(sql`${query.tag.trim().toLowerCase()} = any(${templates.tags})`);
  if (query.excludeIds?.length) conds.push(notInArray(templates.id, query.excludeIds));
  const limit = Math.min(query.limit ?? 24, 60);
  const rows = await selectCards()
    .where(and(...conds))
    .orderBy(...sortExpr(query.sort ?? "trending"), desc(templates.id))
    .limit(limit + 1)
    .offset(query.offset ?? 0);
  return { items: await toCards(rows.slice(0, limit), viewer), hasMore: rows.length > limit };
}

export async function cardsByIds(ids: string[], viewer: Viewer): Promise<TemplateCard[]> {
  if (!ids.length) return [];
  const rows = await selectCards().where(and(published, inArray(templates.id, ids)));
  const cards = await toCards(rows, viewer);
  return ids.map((id) => cards.find((c) => c.id === id)).filter((c): c is TemplateCard => Boolean(c));
}

export async function similarTemplates(templateId: string, viewer: Viewer, limit = 8) {
  const [t] = await getDb().select().from(templates).where(eq(templates.id, templateId));
  if (!t) return [];
  const overlap = sql<number>`(
    (case when ${templates.categoryId} = ${t.categoryId} then 2 else 0 end)
    + coalesce(array_length(array(select unnest(${templates.tags}) intersect select unnest(src.tags) from ${templates} src where src.id = ${t.id}), 1), 0)
  )`;
  const rows = await selectCards()
    .where(and(published, ne(templates.id, templateId), sql`${overlap} > 0`))
    .orderBy(desc(overlap), desc(templates.favoriteCount))
    .limit(limit);
  return toCards(rows, viewer);
}

/** A signed-in viewer: the personalized rails need an account. */
export type SignedInViewer = Viewer & { id: string };

export async function recentlyViewed(viewer: SignedInViewer, limit = 12) {
  const recent = await getDb()
    .select({ id: discoveryEvents.templateId, last: sql<Date>`max(${discoveryEvents.createdAt})` })
    .from(discoveryEvents)
    .where(and(eq(discoveryEvents.userId, viewer.id), eq(discoveryEvents.event, "view")))
    .groupBy(discoveryEvents.templateId)
    .orderBy(desc(sql`max(${discoveryEvents.createdAt})`))
    .limit(limit);
  return cardsByIds(recent.map((r) => r.id), viewer);
}

/** "Saved inspirations": the viewer's own favorited templates, most recently saved first. */
export async function savedTemplates(viewer: SignedInViewer, limit = 12) {
  const saved = await getDb()
    .select({ id: favorites.targetId })
    .from(favorites)
    .where(and(eq(favorites.userId, viewer.id), eq(favorites.targetType, "template")))
    .orderBy(desc(favorites.createdAt))
    .limit(limit);
  return cardsByIds(saved.map((r) => r.id), viewer);
}

export async function followingFeed(viewer: SignedInViewer, limit = 12) {
  const rows = await selectCards()
    .where(and(published, inArray(templates.creatorId, getDb().select({ id: follows.creatorId }).from(follows).where(eq(follows.followerId, viewer.id)))))
    .orderBy(desc(templates.publishedAt))
    .limit(limit);
  return toCards(rows, viewer);
}

/**
 * "For You": category and tag affinity from the viewer's favorites, generations,
 * stated interests and (if they allow it) views. Only template categories and tags
 * are used; nothing about the person is inferred.
 */
export async function forYou(viewer: SignedInViewer, limit = 12): Promise<{ items: TemplateCard[]; personalized: boolean }> {
  const viewerId = viewer.id;
  const [prefs] = await getDb().select().from(userPreferences).where(eq(userPreferences.userId, viewerId));
  if (prefs && !prefs.personalizationEnabled) return { items: (await browseTemplates({ sort: "trending", limit }, viewer)).items, personalized: false };

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
    return { items: (await browseTemplates({ sort: "trending", limit }, viewer)).items, personalized: false };
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
  return { items: await toCards(rows, viewer), personalized: true };
}

export async function listCategories() {
  return getDb().select().from(templateCategories).orderBy(templateCategories.sortOrder);
}
