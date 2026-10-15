import { and, asc, desc, eq, gte, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
import type { Viewer } from "@/server/age/service";
import { getDb } from "@/server/db";
import { favorites, generationJobs, generationOutputs, mediaAssets, projects, templates, userProfiles } from "@/server/db/schema";
import { assetUrl } from "@/server/media";

export type CreationListItem = {
  id: string;
  status: string;
  mode: string;
  modelKey: string;
  prompt: string;
  isDemo: boolean;
  createdAt: string;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  failureMessage: string | null;
  costCredits: number;
  templateTitle: string | null;
  projectId: string | null;
  relation: string | null;
  output: { assetId: string; kind: "image" | "video"; url: string | null; posterUrl: string | null; width: number | null; height: number | null; mediaWithheld: boolean } | null;
  isFavorited: boolean;
};

/**
 * The viewer's age-rule decision for this request (viewerAccess() or viewerAccessFor()). Someone who
 * now needs a verification they lack gets their own creations without media URLs too (addendum §2).
 */
export type MediaAccess = Pick<Viewer, "explicitAllowed">;

export type CreationFilters = {
  media?: "image" | "video";
  status?: string;
  favorites?: boolean;
  projectId?: string;
  templateId?: string;
  modelKey?: string;
  folderId?: string;
  /** Output quality as requested at creation; a creation without one was made in HD. */
  quality?: "hd" | "4k";
  /** Calendar days in UTC, "YYYY-MM-DD", both inclusive. */
  from?: string;
  to?: string;
  /** Creations made from any template by this creator. */
  templateCreatorId?: string;
  active?: boolean;
  sort?: "newest" | "oldest";
  limit?: number;
  offset?: number;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** "YYYY-MM-DD" to the start of that day in UTC, or undefined for anything else (including 2026-02-31). */
export function utcDay(value: string | undefined): Date | undefined {
  if (!value || !DAY.test(value)) return undefined;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? undefined : d;
}

export async function listCreations(userId: string, f: CreationFilters, access: MediaAccess): Promise<CreationListItem[]> {
  const db = getDb();
  const conds: (SQL | undefined)[] = [eq(generationJobs.userId, userId), isNull(generationJobs.deletedAt)];
  if (f.active) conds.push(inArray(generationJobs.status, ["queued", "processing"]));
  else conds.push(sql`${generationJobs.status} not in ('awaiting_confirmation', 'draft')`);
  if (f.status) conds.push(eq(generationJobs.status, f.status as "completed"));
  if (f.media) conds.push(f.media === "video" ? sql`(${generationJobs.mode}::text like '%video%' or ${generationJobs.mode} = 'scene_continuation')` : sql`(${generationJobs.mode}::text not like '%video%' and ${generationJobs.mode} <> 'scene_continuation')`);
  if (f.projectId) conds.push(eq(generationJobs.projectId, f.projectId));
  if (f.templateId) conds.push(eq(generationJobs.templateId, f.templateId));
  if (f.modelKey) conds.push(eq(generationJobs.modelKey, f.modelKey));
  if (f.favorites) conds.push(sql`exists (select 1 from ${favorites} fv where fv.user_id = ${userId} and fv.target_type = 'creation' and fv.target_id = ${generationJobs.id})`);
  if (f.folderId) conds.push(sql`exists (select 1 from folder_items fi join generation_outputs go on go.id = fi.output_id where fi.folder_id = ${f.folderId} and go.job_id = ${generationJobs.id})`);
  if (f.quality) conds.push(sql`coalesce(${generationJobs.params}->>'quality', 'hd') = ${f.quality}`);
  const from = utcDay(f.from);
  const to = utcDay(f.to);
  if (from) conds.push(gte(generationJobs.createdAt, from));
  if (to) conds.push(lt(generationJobs.createdAt, new Date(to.getTime() + 86_400_000)));
  if (f.templateCreatorId) conds.push(eq(templates.creatorId, f.templateCreatorId));

  const jobs = await db
    .select({ job: generationJobs, templateTitle: templates.title })
    .from(generationJobs)
    .leftJoin(templates, eq(templates.id, generationJobs.templateId))
    .where(and(...conds))
    .orderBy(f.sort === "oldest" ? generationJobs.createdAt : desc(generationJobs.createdAt))
    .limit(Math.min(f.limit ?? 60, 200))
    .offset(f.offset ?? 0);
  return hydrate(userId, jobs, access);
}

/**
 * Options for the Library's extra filters, drawn only from this person's own creations: the
 * projects they made something in, the templates they used and those templates' creators.
 */
export async function libraryFacets(userId: string) {
  const db = getDb();
  const mine = and(eq(generationJobs.userId, userId), isNull(generationJobs.deletedAt), sql`${generationJobs.status} not in ('awaiting_confirmation', 'draft')`);
  const [usedProjects, usedTemplates, creators] = await Promise.all([
    db
      .selectDistinct({ id: projects.id, title: projects.title })
      .from(generationJobs)
      .innerJoin(projects, and(eq(projects.id, generationJobs.projectId), isNull(projects.deletedAt)))
      .where(mine)
      .orderBy(asc(projects.title)),
    db
      .selectDistinct({ id: templates.id, title: templates.title })
      .from(generationJobs)
      .innerJoin(templates, eq(templates.id, generationJobs.templateId))
      .where(mine)
      .orderBy(asc(templates.title)),
    db
      .selectDistinct({ id: userProfiles.userId, handle: userProfiles.handle, displayName: userProfiles.displayName })
      .from(generationJobs)
      .innerJoin(templates, eq(templates.id, generationJobs.templateId))
      .innerJoin(userProfiles, eq(userProfiles.userId, templates.creatorId))
      .where(mine)
      .orderBy(asc(userProfiles.handle)),
  ]);
  return { projects: usedProjects, templates: usedTemplates, creators };
}

const posterUrl =async (asset: typeof mediaAssets.$inferSelect | undefined, userId: string) => (asset ? assetUrl(asset, userId) : null);

async function hydrate(userId: string, jobs: { job: typeof generationJobs.$inferSelect; templateTitle: string | null }[], access: MediaAccess): Promise<CreationListItem[]> {
  const db = getDb();
  const ids = jobs.map((j) => j.job.id);
  const outs = ids.length
    ? await db
        .select({ jobId: generationOutputs.jobId, asset: mediaAssets, posterAssetId: generationOutputs.posterAssetId })
        .from(generationOutputs)
        .innerJoin(mediaAssets, eq(mediaAssets.id, generationOutputs.assetId))
        .where(and(inArray(generationOutputs.jobId, ids), isNull(generationOutputs.deletedAt)))
    : [];
  const posterIds = outs.map((o) => o.posterAssetId).filter((x): x is string => Boolean(x));
  const posters = posterIds.length ? await db.select().from(mediaAssets).where(inArray(mediaAssets.id, posterIds)) : [];
  const favs = ids.length
    ? await db
        .select({ id: favorites.targetId })
        .from(favorites)
        .where(and(eq(favorites.userId, userId), eq(favorites.targetType, "creation"), inArray(favorites.targetId, ids)))
    : [];
  return Promise.all(
    jobs.map(async ({ job, templateTitle }) => {
      const out = outs.find((o) => o.jobId === job.id);
      return {
        id: job.id,
        status: job.status,
        mode: job.mode,
        modelKey: job.modelKey,
        prompt: job.prompt,
        isDemo: job.isDemo,
        createdAt: job.createdAt.toISOString(),
        queuedAt: job.queuedAt?.toISOString() ?? null,
        startedAt: job.startedAt?.toISOString() ?? null,
        finishedAt: job.finishedAt?.toISOString() ?? null,
        failureMessage: job.failureMessage,
        costCredits: job.costCredits,
        templateTitle,
        projectId: job.projectId,
        relation: job.relation,
        output: out
          ? {
              assetId: out.asset.id,
              kind: out.asset.kind,
              url: access.explicitAllowed ? await assetUrl(out.asset, userId) : null,
              posterUrl: access.explicitAllowed ? await posterUrl(posters.find((p) => p.id === out.posterAssetId), userId) : null,
              width: out.asset.width,
              height: out.asset.height,
              mediaWithheld: !access.explicitAllowed,
            }
          : null,
        isFavorited: favs.some((f) => f.id === job.id),
      };
    }),
  );
}

export async function getCreation(userId: string, jobId: string, access: MediaAccess): Promise<CreationListItem | null> {
  const rows = await getDb()
    .select({ job: generationJobs, templateTitle: templates.title })
    .from(generationJobs)
    .leftJoin(templates, eq(templates.id, generationJobs.templateId))
    .where(and(eq(generationJobs.id, jobId), eq(generationJobs.userId, userId), isNull(generationJobs.deletedAt)));
  const [item] = await hydrate(userId, rows, access);
  return item ?? null;
}

/** Jobs related by lineage (parent, children, siblings), for version comparison. */
export async function lineage(userId: string, jobId: string, access: MediaAccess): Promise<CreationListItem[]> {
  const [job] = await getDb().select().from(generationJobs).where(and(eq(generationJobs.id, jobId), eq(generationJobs.userId, userId)));
  if (!job) return [];
  const root = job.parentJobId ?? job.id;
  const rows = await getDb()
    .select({ job: generationJobs, templateTitle: templates.title })
    .from(generationJobs)
    .leftJoin(templates, eq(templates.id, generationJobs.templateId))
    .where(
      and(
        eq(generationJobs.userId, userId),
        isNull(generationJobs.deletedAt),
        sql`(${generationJobs.id} = ${root} or ${generationJobs.parentJobId} = ${root} or ${generationJobs.parentJobId} = ${job.id})`,
        sql`${generationJobs.status} not in ('draft', 'awaiting_confirmation')`,
      ),
    )
    .orderBy(generationJobs.createdAt)
    .limit(24);
  return hydrate(userId, rows, access);
}
