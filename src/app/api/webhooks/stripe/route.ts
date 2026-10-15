import { route } from "@/server/http";
import { handlePaymentWebhook } from "@/server/payments/webhook";

/** Stripe's original endpoint; it now delegates to the generic one at /api/webhooks/payments/stripe. */
export const POST = route(async (req) => handlePaymentWebhook("stripe", req));
