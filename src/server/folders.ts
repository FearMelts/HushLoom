import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/server/db";
import { folderItems, folders, generationOutputs } from "@/server/db/schema";
import { notFound } from "@/server/http";

export function listFolders(userId: string) {
  return getDb().select().from(folders).where(eq(folders.userId, userId)).orderBy(asc(folders.name));
}

export async function createFolder(userId: string, name: string) {
  const [f] = await getDb().insert(folders).values({ userId, name }).returning();
  return f!;
}

export async function deleteFolder(userId: string, folderId: string) {
  const res = await getDb().delete(folders).where(and(eq(folders.id, folderId), eq(folders.userId, userId))).returning();
  if (!res.length) throw notFound();
}

/** Adds the outputs of the given jobs to a folder. Both must belong to the user. */
export async function addToFolder(userId: string, folderId: string, jobIds: string[]) {
  const [f] = await getDb().select().from(folders).where(and(eq(folders.id, folderId), eq(folders.userId, userId)));
  if (!f) throw notFound();
  const outs = await getDb()
    .select({ id: generationOutputs.id })
    .from(generationOutputs)
    .where(and(inArray(generationOutputs.jobId, jobIds), eq(generationOutputs.userId, userId), isNull(generationOutputs.deletedAt)));
  if (outs.length) await getDb().insert(folderItems).values(outs.map((o) => ({ folderId, outputId: o.id }))).onConflictDoNothing();
  return outs.length;
}
