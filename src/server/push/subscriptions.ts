import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { audit } from "@/server/audit";
import { getDb, type Tx } from "@/server/db";
import { pushSubscriptions, sessions } from "@/server/db/schema";
import { base64UrlBytes } from "./index";

/**
 * The push services browsers use today. The server POSTs to a subscription's endpoint, so an
 * arbitrary URL would let anyone aim the server at hosts of their choosing; only these are accepted.
 * Chrome, Edge (Chromium), Opera and Samsung Internet: FCM. Firefox: Mozilla autopush.
 * Safari (macOS and iOS home-screen apps): Apple. Legacy Edge: WNS.
 */
const PUSH_SERVICE_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^([a-z0-9-]+\.)*push\.apple\.com$/,
  /^([a-z0-9-]+\.)*notify\.windows\.com$/,
];

export function isPushServiceEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.port === "" && !url.username && !url.password && PUSH_SERVICE_HOSTS.some((host) => host.test(url.hostname));
}

const endpointSchema = z.string().trim().max(2048).refine(isPushServiceEndpoint, "This browser's push service is not supported.");

/** The JSON a browser's PushSubscription.toJSON() produces. */
export const subscriptionSchema = z.object({
  endpoint: endpointSchema,
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().refine((v) => base64UrlBytes(v) === 65, "Not a P-256 public key."),
    auth: z.string().refine((v) => base64UrlBytes(v) === 16, "Not a 16-byte auth secret."),
  }),
});

export const unsubscribeSchema = z.object({ endpoint: z.string().trim().min(1).max(2048) });

/**
 * Stores this device's subscription, tied to the session that made it so signing out removes it.
 * The endpoint is unique per browser profile: a later sign-in on the same browser takes it over.
 */
export async function saveSubscription(userId: string, sessionId: string, input: z.infer<typeof subscriptionSchema>, userAgent: string | null) {
  const values = { userId, sessionId, endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth, userAgent: userAgent?.slice(0, 300) ?? null };
  const [row] = await getDb()
    .insert(pushSubscriptions)
    .values(values)
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { userId, sessionId, p256dh: values.p256dh, auth: values.auth, userAgent: values.userAgent, failedAt: null },
    })
    // xmax = 0 only on a fresh insert: devices re-sync on every visit, and only a new device is worth an audit row.
    .returning({ id: pushSubscriptions.id, inserted: sql<boolean>`(xmax = 0)` });
  if (row!.inserted) await audit(userId, "push.subscribe", "push_subscription", row!.id);
  return { id: row!.id, created: row!.inserted };
}

/** Removes one of the user's own subscriptions by endpoint; someone else's endpoint matches nothing. */
export async function removeSubscription(userId: string, endpoint: string): Promise<number> {
  const removed = await getDb()
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)))
    .returning({ id: pushSubscriptions.id });
  for (const r of removed) await audit(userId, "push.unsubscribe", "push_subscription", r.id);
  return removed.length;
}

/** Sign-out of one device: its subscriptions go with the session. */
export async function removeSessionSubscriptions(sessionId: string): Promise<number> {
  const removed = await getDb().delete(pushSubscriptions).where(eq(pushSubscriptions.sessionId, sessionId)).returning({ id: pushSubscriptions.id });
  return removed.length;
}

export async function removeUserSubscriptions(userId: string, tx?: Tx): Promise<number> {
  const removed = await (tx ?? getDb()).delete(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)).returning({ id: pushSubscriptions.id });
  return removed.length;
}

/** Subscriptions that may receive a push now: only devices whose session is still signed in. */
export async function deliverableSubscriptions(userId: string) {
  return getDb()
    .select({ id: pushSubscriptions.id, endpoint: pushSubscriptions.endpoint, p256dh: pushSubscriptions.p256dh, auth: pushSubscriptions.auth })
    .from(pushSubscriptions)
    .innerJoin(sessions, eq(sessions.id, pushSubscriptions.sessionId))
    .where(and(eq(pushSubscriptions.userId, userId), eq(sessions.userId, userId), gt(sessions.expiresAt, new Date())));
}
