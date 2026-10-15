import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { CreatePrefill } from "@/components/create-panel";
import { isUuid } from "@/lib/ids";
import { listModelAvailability } from "@/server/ai/providers";
import { FRAMINGS, LIGHTINGS, type GenerationMode } from "@/server/ai/registry";
import type { SessionUser } from "@/server/auth/session";
import { getBalance } from "@/server/credits/ledger";
import { getDb } from "@/server/db";
import { characterReferences, consentRecords, generationJobs, projectScenes, projects, templates, userPreferences } from "@/server/db/schema";
import { hasVip } from "@/server/generation/service";

/** Everything the Create panel needs about the viewer and the available models. */
export async function createContext(user: SessionUser | null) {
  const models = await listModelAvailability();
  if (!user) return { models, balance: 0, vip: false, copilot: true, characterRefs: [], projects: [] };
  const db = getDb();
  const [balance, vip, prefs, refs, projs] = await Promise.all([
    getBalance(user.id),
    hasVip(user.id),
    db.select({ copilot: userPreferences.copilotEnabled }).from(userPreferences).where(eq(userPreferences.userId, user.id)),
    db
      .select({ id: characterReferences.id, name: characterReferences.name })
      .from(characterReferences)
      .innerJoin(consentRecords, eq(consentRecords.id, characterReferences.consentRecordId))
      .where(and(eq(characterReferences.userId, user.id), isNull(characterReferences.deletedAt), isNull(consentRecords.withdrawnAt))),
    db.select({ id: projects.id, title: projects.title }).from(projects).where(and(eq(projects.userId, user.id), isNull(projects.deletedAt))).orderBy(desc(projects.updatedAt)).limit(30),
  ]);
  const scenes = projs.length
    ? await db.select({ id: projectScenes.id, title: projectScenes.title, projectId: projectScenes.projectId }).from(projectScenes)
        .where(inArray(projectScenes.projectId, projs.map((p) => p.id)))
        .orderBy(asc(projectScenes.position))
    : [];
  return {
    models,
    balance: balance.available,
    vip,
    copilot: prefs[0]?.copilot ?? true,
    characterRefs: refs,
    projects: projs.map((p) => ({ ...p, scenes: scenes.filter((s) => s.projectId === p.id).map((s) => ({ id: s.id, title: s.title })) })),
  };
}

/**
 * A remix keeps its source template's attribution only while that template is still one this person
 * can make from (published or their own, and VIP only with a pass). Otherwise the remix is made
 * unattributed rather than refused, since the prompt and settings are already the person's own.
 */
async function attributableTemplate(userId: string, templateId: string): Promise<string | undefined> {
  const [t] = await getDb()
    .select({ id: templates.id, status: templates.status, creatorId: templates.creatorId, isVip: templates.isVip })
    .from(templates)
    .where(and(eq(templates.id, templateId), isNull(templates.deletedAt)));
  if (!t) return undefined;
  const own = t.creatorId === userId;
  if (t.status !== "published" && !own) return undefined;
  if (t.isVip && !own && !(await hasVip(userId))) return undefined;
  return t.id;
}

const isLighting = (v: string | undefined): v is (typeof LIGHTINGS)[number] => (LIGHTINGS as readonly string[]).includes(v ?? "");
const isFraming = (v: string | undefined): v is (typeof FRAMINGS)[number] => (FRAMINGS as readonly string[]).includes(v ?? "");

/**
 * The Create panel's starting point on /generate/<kind>:
 * - `?from=<jobId>` (Remix, and Reuse settings with `&reuse=exact`, which also keeps the seed): the
 *   source's prompt and settings, linked to it as a "remix" so it shows in the source's versions,
 *   with its template attribution and its character reference.
 * - `?scene=<sceneId>`: a project scene's continuity guide folded into the prompt and settings.
 * - `?character=<id>`: a reference-guided still with that character.
 */
export async function generatePrefill(userId: string | undefined, kind: "image" | "video", sp: Record<string, string | undefined>): Promise<CreatePrefill | undefined> {
  if (!userId) return undefined;
  const db = getDb();
  if (isUuid(sp.from)) {
    const [job] = await db
      .select()
      .from(generationJobs)
      .where(and(eq(generationJobs.id, sp.from), eq(generationJobs.userId, userId), isNull(generationJobs.deletedAt)));
    if (job) {
      const withoutSeed = Object.fromEntries(Object.entries(job.params).filter(([k]) => k !== "seed"));
      return {
        // An upload or clip input is not carried over; the panel asks for one again.
        mode: job.inputAssetIds.length ? undefined : (job.mode as GenerationMode),
        modelKey: job.modelKey,
        prompt: job.prompt,
        negativePrompt: job.negativePrompt,
        params: sp.reuse === "exact" ? job.params : withoutSeed,
        projectId: job.projectId ?? undefined,
        sceneId: job.sceneId ?? undefined,
        // The panel keeps it only while that character is still on file; it never swaps in another.
        characterReferenceId: job.characterReferenceId ?? undefined,
        parentJobId: job.id,
        relation: "remix",
        templateId: job.templateId ? await attributableTemplate(userId, job.templateId) : undefined,
      };
    }
  }
  if (isUuid(sp.scene)) {
    const [row] = await db
      .select({ scene: projectScenes, project: projects })
      .from(projectScenes)
      .innerJoin(projects, eq(projects.id, projectScenes.projectId))
      .where(and(eq(projectScenes.id, sp.scene), eq(projects.userId, userId), isNull(projects.deletedAt)));
    if (row) {
      const c = row.scene.continuity;
      const note = [c.lighting && `${c.lighting} lighting`, c.framing && `${c.framing} framing`, c.palette && `${c.palette} palette`, c.notes].filter(Boolean).join(", ");
      return {
        prompt: note ? `${row.scene.title}. ${note}` : row.scene.title,
        // Only values the settings offer become settings; anything else stays in the prompt text above.
        params: { ...(isLighting(c.lighting) ? { lighting: c.lighting } : {}), ...(isFraming(c.framing) ? { framing: c.framing } : {}) },
        projectId: row.project.id,
        sceneId: row.scene.id,
        characterReferenceId: c.characterReferenceId,
        // Only still models take a character reference in this build; the panel says so for clips.
        mode: c.characterReferenceId && kind === "image" ? "reference_guided" : undefined,
        continuityNote: note || undefined,
      };
    }
  }
  if (isUuid(sp.character) && kind === "image") return { mode: "reference_guided", characterReferenceId: sp.character };
  return undefined;
}
