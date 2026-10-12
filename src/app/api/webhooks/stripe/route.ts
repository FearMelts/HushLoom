import { NextResponse } from "next/server";
import { route } from "@/server/http";
import { processStripeEvent, verifyStripeEvent } from "@/server/payments/stripe";

/** Stripe calls this. The raw body is verified before anything is read from it. */
export const POST = route(async (req) => {
  const raw = await req.text();
  const event = verifyStripeEvent(raw, req.headers.get("stripe-signature"));
  const outcome = await processStripeEvent(event);
  return NextResponse.json({ received: true, outcome });
});
