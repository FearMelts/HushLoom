import { NextResponse } from "next/server";
import { contextFromHeaders } from "@/server/age/rules";
import { startVerification } from "@/server/age/service";
import { HttpError, requireUser, route } from "@/server/http";
import { rateLimit } from "@/server/redis";

/** Opens an age check with the active provider and returns where to send the person. */
export const POST = route(async (req) => {
  const user = await requireUser();
  if (!(await rateLimit(`age-verify:${user.id}`, 10, 3600))) throw new HttpError(429, "rate_limited", "Too many age-check attempts for now. Try again in an hour.");
  const started = await startVerification(user, contextFromHeaders(req.headers));
  return NextResponse.json({ url: started.url, provider: started.provider, sandbox: started.sandbox, verificationId: started.verificationId }, { status: 201 });
});
