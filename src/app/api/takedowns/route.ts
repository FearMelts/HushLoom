import { NextResponse } from "next/server";
import { getCurrentUser } from "@/server/auth/session";
import { HttpError, parseJson, route } from "@/server/http";
import { rateLimit } from "@/server/redis";
import { createTakedown, takedownSchema } from "@/server/safety/takedowns";

/** Public takedown requests (addendum §3). Signed out is fine with an email; a human reviews every one. */
export const POST = route(async (req) => {
  const user = await getCurrentUser();
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const bucket = user ? `takedown:user:${user.id}` : `takedown:ip:${ip}`;
  if (!(await rateLimit(bucket, 10, 3600))) throw new HttpError(429, "rate_limited", "That's a lot of requests from here. Try again in an hour, or write to us directly.");
  const input = await parseJson(req, takedownSchema);
  const { id } = await createTakedown(input, user);
  return NextResponse.json({ ok: true, id }, { status: 201 });
});
