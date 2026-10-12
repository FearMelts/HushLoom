import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/server/db";
import { characterReferences, generationJobs, generationOutputs, mediaAssets, projectScenes, projects, sceneVersions, type ContinuityGuide } from "@/server/db/schema";
import { assetUrl, assetUrlById } from "@/server/media";
import { listCreations, type CreationListItem } from "@/server/generation/views";
import { HttpError, notFound } from "@/server/http";

export const continuitySchema = z
  .object({
    lighting: z.string().trim().max(40).optional(),
    framing: z.string().trim().max(40).optional(),
    palette: z.string().trim().max(80).optional(),
    characterReferenceId: z.string().uuid().optional(),
    notes: z.string().trim().max(400).optional(),
  })
  .strict();

export const projectSchema = z.object({
  title: z.string().trim().min(1, "Give the project a name.").max(80),
  description: z.string().trim().max(500).default(""),
});
export const projectPatchSchema = projectSchema.partial();
export const sceneSchema = z.object({
  title: z.string().trim().min(1).max(80),
  continuity: continuitySchema.optional(),
});
export const scenePatchSchema = sceneSchema.partial();

export type SceneVersion = {
  id: string;
  parentVersionId: string | null;
  branchLabel: string;
  isSelected: boolean;
  createdAt: string;
  creation: CreationListItem;
};
export type SceneDetail = { id: string; position: number; title: string; continuity: ContinuityGuide; versions: SceneVersion[] };

async function ownedProject(userId: string, projectId: string) {
  const [p] = await getDb()
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId), isNull(projects.deletedAt)));
  if (!p) throw notFound();
  return p;
}

async function ownedScene(userId: string, sceneId: string) {
  const [row] = await getDb()
    .select({ scene: projectScenes })
    .from(projectScenes)
    .innerJoin(projects, eq(projects.id, projectScenes.projectId))
    .where(and(eq(projectScenes.id, sceneId), eq(projects.userId, userId), isNull(projects.deletedAt)));
  if (!row) throw notFound();
  return row.scene;
}

async function checkContinuity(userId: string, c: ContinuityGuide | undefined) {
  if (!c?.characterReferenceId) return;
  const [ref] = await getDb()
    .select({ id: characterReferences.id })
    .from(characterReferences)
    .where(and(eq(characterReferences.id, c.characterReferenceId), eq(characterReferences.userId, userId), isNull(characterReferences.deletedAt)));
  if (!ref) throw notFound();
}

const touch = (projectId: string) => getDb().update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, projectId));

export async function listProjects(userId: string) {
  const db = getDb();
  const rows = await db
    .select({
      id: projects.id,
      title: projects.title,
      description: projects.description,
      updatedAt: projects.updatedAt,
      scenes: sql<number>`(select count(*)::int from ${projectScenes} s where s.project_id = ${projects.id})`,
      clips: sql<number>`(select count(*)::int from ${generationJobs} j where j.project_id = ${projects.id} and j.deleted_at is null and j.status = 'completed')`,
    })
    .from(projects)
    .where(and(eq(projects.userId, userId), isNull(projects.deletedAt)))
    .orderBy(desc(projects.updatedAt));
  // One cover per project: the newest finished creation in it.
  const covers = rows.length
    ? await db
        .selectDistinctOn([generationJobs.projectId], { projectId: generationJobs.projectId, asset: mediaAssets, posterAssetId: generationOutputs.posterAssetId })
        .from(generationJobs)
        .innerJoin(generationOutputs, and(eq(generationOutputs.jobId, generationJobs.id), isNull(generationOutputs.deletedAt)))
        .innerJoin(mediaAssets, eq(mediaAssets.id, generationOutputs.assetId))
        .where(
          and(
            eq(generationJobs.userId, userId),
            inArray(generationJobs.projectId, rows.map((r) => r.id)),
            eq(generationJobs.status, "completed"),
            isNull(generationJobs.deletedAt),
          ),
        )
        .orderBy(generationJobs.projectId, desc(generationJobs.createdAt))
    : [];
  return Promise.all(
    rows.map(async (r) => {
      const c = covers.find((x) => x.projectId === r.id);
      return {
        ...r,
        updatedAt: r.updatedAt.toISOString(),
        cover: c ? { kind: c.asset.kind, url: await assetUrl(c.asset, userId), posterUrl: await assetUrlById(c.posterAssetId, userId) } : null,
      };
    }),
  );
}

export async function createProject(userId: string, input: z.infer<typeof projectSchema>) {
  return getDb().transaction(async (tx) => {
    const [p] = await tx.insert(projects).values({ userId, title: input.title, description: input.description }).returning();
    await tx.insert(projectScenes).values({ projectId: p!.id, position: 0, title: "Opening", continuity: {} });
    return p!;
  });
}

export async function updateProject(userId: string, projectId: string, input: z.infer<typeof projectPatchSchema>) {
  await ownedProject(userId, projectId);
  const [p] = await getDb()
    .update(projects)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(projects.id, projectId))
    .returning();
  return p!;
}

/** Soft-deletes the project. Its creations stay in the Library, detached from the project. */
export async function deleteProject(userId: string, projectId: string) {
  await ownedProject(userId, projectId);
  await getDb().update(projects).set({ deletedAt: new Date() }).where(eq(projects.id, projectId));
}

export async function getProjectDetail(userId: string, projectId: string) {
  const project = await ownedProject(userId, projectId);
  const db = getDb();
  const scenes = await db.select().from(projectScenes).where(eq(projectScenes.projectId, projectId)).orderBy(asc(projectScenes.position));
  const versions = scenes.length
    ? await db
        .select()
        .from(sceneVersions)
        .where(inArray(sceneVersions.sceneId, scenes.map((s) => s.id)))
        .orderBy(asc(sceneVersions.createdAt))
    : [];
  const creations = await listCreations(userId, { projectId, limit: 200, sort: "oldest" });
  const byJob = new Map(creations.map((c) => [c.id, c]));
  const detail: SceneDetail[] = scenes.map((s) => ({
    id: s.id,
    position: s.position,
    title: s.title,
    continuity: s.continuity,
    versions: versions
      .filter((v) => v.sceneId === s.id && byJob.has(v.jobId))
      .map((v) => ({
        id: v.id,
        parentVersionId: v.parentVersionId,
        branchLabel: v.branchLabel,
        isSelected: v.isSelected,
        createdAt: v.createdAt.toISOString(),
        creation: byJob.get(v.jobId)!,
      })),
  }));
  const loose = creations.filter((c) => !versions.some((v) => v.jobId === c.id));
  return { project: { id: project.id, title: project.title, description: project.description, updatedAt: project.updatedAt.toISOString() }, scenes: detail, loose };
}

/** New scenes inherit the previous scene's continuity guide, so a sequence keeps its look by default. */
export async function addScene(userId: string, projectId: string, input: z.infer<typeof sceneSchema>) {
  await ownedProject(userId, projectId);
  await checkContinuity(userId, input.continuity);
  const db = getDb();
  const [last] = await db.select().from(projectScenes).where(eq(projectScenes.projectId, projectId)).orderBy(desc(projectScenes.position)).limit(1);
  if (last && last.position >= 49) throw new HttpError(422, "limit_reached", "A project can hold up to 50 scenes.");
  const [scene] = await db
    .insert(projectScenes)
    .values({ projectId, position: (last?.position ?? -1) + 1, title: input.title, continuity: input.continuity ?? last?.continuity ?? {} })
    .returning();
  await touch(projectId);
  return scene!;
}

export async function updateScene(userId: string, sceneId: string, input: z.infer<typeof scenePatchSchema>) {
  const scene = await ownedScene(userId, sceneId);
  await checkContinuity(userId, input.continuity);
  const [s] = await getDb()
    .update(projectScenes)
    .set({ ...(input.title ? { title: input.title } : {}), ...(input.continuity ? { continuity: input.continuity } : {}) })
    .where(eq(projectScenes.id, sceneId))
    .returning();
  await touch(scene.projectId);
  return s!;
}

export async function deleteScene(userId: string, sceneId: string) {
  const scene = await ownedScene(userId, sceneId);
  await getDb().transaction(async (tx) => {
    await tx.delete(projectScenes).where(eq(projectScenes.id, sceneId));
    const rest = await tx.select({ id: projectScenes.id }).from(projectScenes).where(eq(projectScenes.projectId, scene.projectId)).orderBy(asc(projectScenes.position));
    for (const [i, s] of rest.entries()) await tx.update(projectScenes).set({ position: i }).where(eq(projectScenes.id, s.id));
  });
  await touch(scene.projectId);
}

/** `order` must name every scene in the project exactly once. */
export async function reorderScenes(userId: string, projectId: string, order: string[]) {
  await ownedProject(userId, projectId);
  await getDb().transaction(async (tx) => {
    const current = await tx.select({ id: projectScenes.id }).from(projectScenes).where(eq(projectScenes.projectId, projectId)).for("update");
    const ids = new Set(current.map((s) => s.id));
    if (order.length !== ids.size || new Set(order).size !== order.length || order.some((id) => !ids.has(id))) {
      throw new HttpError(422, "invalid_order", "The new order must list every scene once.");
    }
    for (const [i, id] of order.entries()) await tx.update(projectScenes).set({ position: i }).where(eq(projectScenes.id, id));
  });
  await touch(projectId);
}

/** Marks one finished version as the take this scene uses. */
export async function selectVersion(userId: string, sceneId: string, versionId: string) {
  const scene = await ownedScene(userId, sceneId);
  await getDb().transaction(async (tx) => {
    const [v] = await tx
      .select({ id: sceneVersions.id, status: generationJobs.status })
      .from(sceneVersions)
      .innerJoin(generationJobs, eq(generationJobs.id, sceneVersions.jobId))
      .where(and(eq(sceneVersions.id, versionId), eq(sceneVersions.sceneId, sceneId), isNull(generationJobs.deletedAt)));
    if (!v) throw notFound();
    if (v.status !== "completed") throw new HttpError(409, "not_ready", "Only a finished version can be selected.");
    await tx.update(sceneVersions).set({ isSelected: false }).where(eq(sceneVersions.sceneId, sceneId));
    await tx.update(sceneVersions).set({ isSelected: true }).where(eq(sceneVersions.id, versionId));
  });
  await touch(scene.projectId);
}
