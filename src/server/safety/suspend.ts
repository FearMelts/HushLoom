import { and, eq, isNull, or, sql } from "drizzle-orm";
import { audit } from "@/server/audit";
import type { Tx } from "@/server/db";
import { accountFlags, pushSubscriptions, sessions, templates, users } from "@/server/db/schema";

/** details.source on the manual_review flag an admin suspension records, so a cleared scan case never lifts it. */
export const ADMIN_SUSPENSION = "admin_suspension";

/**
 * Open flags that keep an account suspended: an abuse case (csam_match, from a scanner match or a
 * CSAM takedown) or an admin's suspension.
 */
export function suspensionCauses(t: Tx, userId: string) {
  return t
    .select({ id: accountFlags.id, kind: accountFlags.kind })
    .from(accountFlags)
    .where(and(eq(accountFlags.userId, userId), isNull(accountFlags.clearedAt), or(eq(accountFlags.kind, "csam_match"), sql`${accountFlags.details}->>'source' = ${ADMIN_SUSPENSION}`)));
}

/**
 * The account side of an abuse case (addendum §3): the owner is suspended and signed out on every
 * device until a person reviews it. A scanner match and a CSAM takedown an admin actioned both take
 * this path, so neither leaves the owner able to sign in and publish the same material again.
 * The caller records the case's csam_match flag first; the review queue reinstates the account only
 * when no such flag is left open. Like an admin suspension, it unpublishes every template the
 * account has live, so discovery never lists work whose creator page now 404s. Returns true when
 * this call suspended the account.
 */
export async function suspendForAbuse(t: Tx, userId: string, meta: Record<string, unknown>, actorId: string | null = null): Promise<boolean> {
  const now = new Date();
  const [suspended] = await t
    .update(users)
    .set({ status: "suspended", updatedAt: now })
    .where(and(eq(users.id, userId), eq(users.status, "active")))
    .returning({ id: users.id });
  const unpublished = await t
    .update(templates)
    .set({ status: "unpublished", updatedAt: now })
    .where(and(eq(templates.creatorId, userId), eq(templates.status, "published")))
    .returning({ id: templates.id });
  if (!suspended) return false;
  await audit(actorId, "user.suspend", "user", userId, { ...meta, unpublishedTemplates: unpublished.length }, t);
  await t.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  await t.delete(sessions).where(eq(sessions.userId, userId));
  return true;
}
