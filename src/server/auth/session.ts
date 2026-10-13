import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { and, eq, gt, isNull } from "drizzle-orm";
import { cookies } from "next/headers";
import { cache } from "react";
import { getDb } from "@/server/db";
import { sessions, userProfiles, users } from "@/server/db/schema";
import { env } from "@/server/env";

export const SESSION_COOKIE = "hl_session";

export type SessionUser = {
  id: string;
  email: string;
  role: "member" | "creator" | "admin";
  handle: string;
  displayName: string;
  ageAssuranceMethod: string;
  /** Age-verification columns (addendum §2), carried by the session loader so the gate needs no extra query. Optional for callers that build a user by hand. */
  jurisdiction?: string | null;
  ageVerificationStatus?: (typeof users.$inferSelect)["ageVerificationStatus"];
  ageVerifiedAt?: Date | null;
  ageVerificationProvider?: string | null;
};

export function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string, userAgent: string | null): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + env().SESSION_TTL_DAYS * 86_400_000);
  await getDb().insert(sessions).values({ userId, tokenHash: hashToken(token), expiresAt, userAgent: userAgent?.slice(0, 300) });
  return { token, expiresAt };
}

export async function setSessionCookie(token: string, expiresAt: Date) {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env().NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function userForToken(token: string): Promise<SessionUser | null> {
  const [row] = await getDb()
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      handle: userProfiles.handle,
      displayName: userProfiles.displayName,
      ageAssuranceMethod: users.ageAssuranceMethod,
      jurisdiction: users.jurisdiction,
      ageVerificationStatus: users.ageVerificationStatus,
      ageVerifiedAt: users.ageVerifiedAt,
      ageVerificationProvider: users.ageVerificationProvider,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(userProfiles, eq(userProfiles.userId, users.id))
    .where(
      and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date()), eq(users.status, "active"), isNull(users.deletedAt)),
    )
    .limit(1);
  return row ?? null;
}

/** The signed-in user for this request, or null. Cached per request. */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return userForToken(token);
});

export async function destroyCurrentSession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await getDb().delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
  jar.delete(SESSION_COOKIE);
}

export async function destroyAllSessions(userId: string) {
  await getDb().delete(sessions).where(eq(sessions.userId, userId));
}
