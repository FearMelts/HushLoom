import { NextResponse } from "next/server";
import { audit } from "@/server/audit";
import { SESSION_COOKIE, destroyAllSessions } from "@/server/auth/session";
import { requireUser, route } from "@/server/http";

/** Signs out on every device, including this one. */
export const DELETE = route(async () => {
  const user = await requireUser();
  await destroyAllSessions(user.id);
  await audit(user.id, "sessions.revoke_all", "user", user.id);
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
});
