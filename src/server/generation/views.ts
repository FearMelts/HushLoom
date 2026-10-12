import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/server/db";
import { favorites, generationJobs, generationOutputs, mediaAssets, templates } from "@/server/db/schema";
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
  output: { assetId: string; kind: "image" | "video"; url: string | null; posterUrl: string | null; width: number | null; height: number | null } | null;
  isFavorited: boolean;
};

export type CreationFilters = {
  media?: "image" | "video";
  status?: string;
  favorites?: boolean;
  projectId?: string;
  templateId?: string;
  modelKey?: string;
  folderId?: string;
  active?: boolean;
  sort?: "newest" | "oldest";
  limit?: number;
  offset?: number;
};

export async function listCreations(userId: string, f: CreationFilters): Promise<CreationListItem[]> {
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

  const jobs = await db
    .select({ job: generationJobs, templateTitle: templates.title })
    .from(generationJobs)
    .leftJoin(templates, eq(templates.id, generationJobs.templateId))
    .where(and(...conds))
    .orderBy(f.sort === "oldest" ? generationJobs.createdAt : desc(generationJobs.createdAt))
    .limit(Math.min(f.limit ?? 60, 200))
    .offset(f.offset ?? 0);
  return hydrate(userId, jobs);
}

const posterUrl = async (asset: typeof mediaAssets.$inferSelect | undefined, userId: string) => (asset ? assetUrl(asset, userId) : null);

async function hydrate(userId: string, jobs: { job: typeof generationJobs.$inferSelect; templateTitle: string | null }[]): Promise<CreationListItem[]> {
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
              url: await assetUrl(out.asset, userId),
              posterUrl: await posterUrl(posters.find((p) => p.id === out.posterAssetId), userId),
              width: out.asset.width,
              height: out.asset.height,
            }
          : null,
        isFavorited: favs.some((f) => f.id === job.id),
      };
    }),
  );
}

export async function getCreation(userId: string, jobId: string): Promise<CreationListItem | null> {
  const rows = await getDb()
    .select({ job: generationJobs, templateTitle: templates.title })
    .from(generationJobs)
    .leftJoin(templates, eq(templates.id, generationJobs.templateId))
    .where(and(eq(generationJobs.id, jobId), eq(generationJobs.userId, userId), isNull(generationJobs.deletedAt)));
  const [item] = await hydrate(userId, rows);
  return item ?? null;
}

/** Jobs related by lineage (parent, children, siblings), for version comparison. */
export async function lineage(userId: string, jobId: string): Promise<CreationListItem[]> {
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
  return hydrate(userId, rows);
}
