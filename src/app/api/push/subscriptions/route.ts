import { NextResponse } from "next/server";
import { currentSessionId } from "@/server/auth/session";
import { HttpError, parseJson, requireUser, route, unauthorized } from "@/server/http";
import { pushStatus } from "@/server/push";
import { removeSubscription, saveSubscription, subscriptionSchema, unsubscribeSchema } from "@/server/push/subscriptions";
import { rateLimit } from "@/server/redis";

/** Stores this device's push subscription for the current session (upsert on endpoint). */
export const POST = route(async (req) => {
  const user = await requireUser();
  if (!pushStatus().enabled) throw new HttpError(503, "push_disabled", "Push is not configured on this server.");
  const sessionId = await currentSessionId();
  if (!sessionId) throw unauthorized();
  if (!(await rateLimit(`push:subscribe:${user.id}`, 60, 3600))) throw new HttpError(429, "rate_limited", "Too many requests. Try again in a while.");
  const input = await parseJson(req, subscriptionSchema);
  const saved = await saveSubscription(user.id, sessionId, input, req.headers.get("user-agent"));
  return NextResponse.json({ ok: true, id: saved.id, created: saved.created });
});

/** Removes one of your own subscriptions by endpoint (turning notifications off on this device). */
export const DELETE = route(async (req) => {
  const user = await requireUser();
  const { endpoint } = await parseJson(req, unsubscribeSchema);
  const removed = await removeSubscription(user.id, endpoint);
  return NextResponse.json({ ok: true, removed });
});
