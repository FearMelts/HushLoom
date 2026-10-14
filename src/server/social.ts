import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/server/db";
import { favorites, follows, generationJobs, templates, userProfiles, users } from "@/server/db/schema";
import { HttpError, notFound } from "@/server/http";

export async function setFavorite(userId: string, targetType: "template" | "creation", targetId: string, on: boolean) {
  const db = getDb();
  if (targetType === "template") {
    const [t] = await db.select({ id: templates.id }).from(templates).where(and(eq(templates.id, targetId), eq(templates.status, "published"), isNull(templates.deletedAt)));
    if (!t) throw notFound();
  } else {
    const [j] = await db.select({ id: generationJobs.id }).from(generationJobs).where(and(eq(generationJobs.id, targetId), eq(generationJobs.userId, userId)));
    if (!j) throw notFound();
  }
  await db.transaction(async (tx) => {
    // Lock the template first, so concurrent favorites run one at a time and each recount sees the others' rows.
    if (targetType === "template") await tx.select({ id: templates.id }).from(templates).where(eq(templates.id, targetId)).for("update");
    if (on) await tx.insert(favorites).values({ userId, targetType, targetId }).onConflictDoNothing();
    else await tx.delete(favorites).where(and(eq(favorites.userId, userId), eq(favorites.targetType, targetType), eq(favorites.targetId, targetId)));
    if (targetType === "template") {
      await tx.execute(sql`update templates set favorite_count = (select count(*) from favorites where target_type = 'template' and target_id = ${targetId}) where id = ${targetId}`);
    }
  });
}

export async function setFollow(followerId: string, creatorId: string, on: boolean) {
  if (followerId === creatorId) throw new HttpError(422, "self_follow", "You can't follow yourself.");
  const [c] = await getDb().select({ id: users.id }).from(users).where(and(eq(users.id, creatorId), eq(users.status, "active")));
  if (!c) throw notFound();
  if (on) await getDb().insert(follows).values({ followerId, creatorId }).onConflictDoNothing();
  else await getDb().delete(follows).where(and(eq(follows.followerId, followerId), eq(follows.creatorId, creatorId)));
}

export async function profileByHandle(handle: string) {
  const [row] = await getDb()
    .select({ userId: userProfiles.userId, handle: userProfiles.handle, displayName: userProfiles.displayName, bio: userProfiles.bio, role: users.role, createdAt: users.createdAt })
    .from(userProfiles)
    .innerJoin(users, eq(users.id, userProfiles.userId))
    .where(and(sql`lower(${userProfiles.handle}) = ${handle.toLowerCase()}`, eq(users.status, "active")));
  return row ?? null;
}
