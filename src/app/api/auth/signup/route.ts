import { NextResponse } from "next/server";
import { registerUser, signupSchema } from "@/server/auth/account";
import { createSession, setSessionCookie } from "@/server/auth/session";
import { HttpError, parseJson, route } from "@/server/http";
import { rateLimit } from "@/server/redis";

export const POST = route(async (req) => {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (!(await rateLimit(`signup:${ip}`, 10, 3600))) throw new HttpError(429, "rate_limited", "Too many sign-ups from here. Try later.");
  const input = await parseJson(req, signupSchema);
  const user = await registerUser(input);
  const { token, expiresAt } = await createSession(user.id, req.headers.get("user-agent"));
  await setSessionCookie(token, expiresAt);
  return NextResponse.json({ ok: true }, { status: 201 });
});
