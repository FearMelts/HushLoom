import { NextResponse } from "next/server";
import { z } from "zod";
import { contextFromHeaders } from "@/server/age/rules";
import { deleteAccount, passwordAttemptAllowed } from "@/server/auth/account";
import { SESSION_COOKIE } from "@/server/auth/session";
import { HttpError, parseJson, requireUser, route } from "@/server/http";
import { profileSchema, settingsFor, updateProfile } from "@/server/me";

/** Settings data, including the age-verification status for this request's jurisdiction. */
export const GET = route(async (req) => {
  const user = await requireUser();
  return NextResponse.json(await settingsFor(user.id, contextFromHeaders(req.headers)));
});

export const PATCH = route(async (req) => {
  const user = await requireUser();
  await updateProfile(user.id, await parseJson(req, profileSchema));
  return NextResponse.json({ ok: true });
});

/** Deletes the account. Requires the password again, counted against the same attempt limit as sign-in. */
export const DELETE = route(async (req) => {
  const user = await requireUser();
  const { password } = await parseJson(req, z.object({ password: z.string().min(1).max(200) }));
  if (!(await passwordAttemptAllowed(user.email))) throw new HttpError(429, "rate_limited", "Too many attempts. Wait 15 minutes and try again.");
  await deleteAccount(user.id, password);
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
});
