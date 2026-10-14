import { NextResponse } from "next/server";
import { currentSessionId, destroyCurrentSession } from "@/server/auth/session";
import { route } from "@/server/http";
import { removeSessionSubscriptions } from "@/server/push/subscriptions";

export const POST = route(async () => {
  // This device stops receiving pushes when it signs out. Deleting the session would cascade to its
  // subscriptions too; removing them first keeps that true even if the foreign key ever changes.
  const sessionId = await currentSessionId();
  if (sessionId) await removeSessionSubscriptions(sessionId);
  await destroyCurrentSession();
  return NextResponse.json({ ok: true });
});
