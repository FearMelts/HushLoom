import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, parseJson, requireUser, route } from "@/server/http";
import { paymentsConfigured, startCheckout } from "@/server/payments";
import { rateLimit } from "@/server/redis";

export const POST = route(async (req) => {
  const user = await requireUser();
  if (!paymentsConfigured()) throw new HttpError(503, "payments_unavailable", "Payments are not configured on this server yet.");
  if (!(await rateLimit(`checkout:${user.id}`, 10, 600))) throw new HttpError(429, "rate_limited", "Too many checkout attempts. Try again in a few minutes.");
  const { itemKey } = await parseJson(req, z.object({ itemKey: z.string().max(40) }));
  return NextResponse.json(await startCheckout(user, itemKey));
});
