import { NextResponse } from "next/server";
import { z } from "zod";
import { jurisdictionFromHeaders } from "@/server/age/rules";
import { rememberJurisdiction } from "@/server/age/service";
import { authenticate } from "@/server/auth/account";
import { createSession, setSessionCookie } from "@/server/auth/session";
import { HttpError, parseJson, route } from "@/server/http";
import { rateLimit } from "@/server/redis";

export const POST = route(async (req) => {
  const { email, password } = await parseJson(req, z.object({ email: z.string().max(200), password: z.string().max(200) }));
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const allowed = (await rateLimit(`login:ip:${ip}`, 30, 900)) && (await rateLimit(`login:email:${email.toLowerCase()}`, 10, 900));
  if (!allowed) throw new HttpError(429, "rate_limited", "Too many attempts. Wait 15 minutes and try again.");
  const user = await authenticate(email, password);
  if (!user) throw new HttpError(401, "bad_credentials", "Email or password is incorrect.");
  // Each sign-in refreshes the stored jurisdiction from the geo headers; a missing header keeps the old value.
  await rememberJurisdiction(user.id, jurisdictionFromHeaders(req.headers));
  const { token, expiresAt } = await createSession(user.id, req.headers.get("user-agent"));
  await setSessionCookie(token, expiresAt);
  return NextResponse.json({ ok: true });
});
