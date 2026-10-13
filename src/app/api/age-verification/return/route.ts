import { NextResponse } from "next/server";
import { syncVerification, VERIFY_PATH } from "@/server/age/service";
import { getCurrentUser } from "@/server/auth/session";
import { HttpError, route } from "@/server/http";
import { env } from "@/server/env";
import { logger } from "@/server/log";

/**
 * Where the provider sends the person back after a check (Yoti appends ?sessionId=...). For a
 * signed-in owner of that pending check, the outcome is fetched from the provider's API; the
 * redirect itself proves nothing and never changes a status on its own.
 */
export const GET = route(async (req) => {
  const user = await getCurrentUser();
  const ref = req.nextUrl.searchParams.get("sessionId") ?? req.nextUrl.searchParams.get("ref");
  const home = new URL(VERIFY_PATH, env().APP_URL);
  if (!user) return NextResponse.redirect(new URL(`/auth?next=${encodeURIComponent(VERIFY_PATH)}`, env().APP_URL));
  if (ref) {
    try {
      await syncVerification(user, ref);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      logger.warn("age verification return could not sync", { code: err.code });
    }
  }
  return NextResponse.redirect(home);
});
