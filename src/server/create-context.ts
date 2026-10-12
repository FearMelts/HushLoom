import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { listModelAvailability } from "@/server/ai/providers";
import type { SessionUser } from "@/server/auth/session";
import { getBalance } from "@/server/credits/ledger";
import { getDb } from "@/server/db";
import { characterReferences, consentRecords, projectScenes, projects, userPreferences } from "@/server/db/schema";
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
