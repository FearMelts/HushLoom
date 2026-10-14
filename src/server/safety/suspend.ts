import { and, eq } from "drizzle-orm";
import { audit } from "@/server/audit";
import type { Tx } from "@/server/db";
import { pushSubscriptions, sessions, users } from "@/server/db/schema";

/**
 * The account side of an abuse case (addendum §3): the owner is suspended and signed out on every
 * device until a person reviews it. A scanner match and a CSAM takedown an admin actioned both take
 * this path, so neither leaves the owner able to sign in and publish the same material again.
 * The caller records the case's csam_match flag first; the review queue reinstates the account only
 * when no such flag is left open. Returns true when this call suspended the account.
 */
export async function suspendForAbuse(t: Tx, userId: string, meta: Record<string, unknown>, actorId: string | null = null): Promise<boolean> {
  const [suspended] = await t
    .update(users)
    .set({ status: "suspended", updatedAt: new Date() })
    .where(and(eq(users.id, userId), eq(users.status, "active")))
    .returning({ id: users.id });
  if (!suspended) return false;
  await audit(actorId, "user.suspend", "user", userId, meta, t);
  await t.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  await t.delete(sessions).where(eq(sessions.userId, userId));
  return true;
}
