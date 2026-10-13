import { NextResponse, type NextRequest } from "next/server";
import { HttpError } from "@/server/http";
import { logger } from "@/server/log";
import { paymentProvider, providerByKey } from "./index";
import { processPaymentEvent } from "./service";
import { WebhookRejected } from "./types";

/**
 * One entry point for every processor's webhook. The provider named in the path must be the
 * active one, or another real processor whose own secrets are present (so refunds and
 * chargebacks for an earlier processor still land). Verification failures are 400 with the
 * reason as the code; a redelivered event is 200 "duplicate" and touches nothing.
 */
export async function handlePaymentWebhook(providerKey: string, req: NextRequest): Promise<Response> {
  const provider = providerByKey(providerKey);
  if (!provider) throw new HttpError(404, "not_found", "Not found.");
  const active = paymentProvider();
  const accepted = provider.key === active.key ? provider.webhookConfigured() : !provider.isSandbox && provider.webhookConfigured();
  if (!accepted) throw new HttpError(503, "payments_unavailable", `${provider.label} webhooks are not configured on this server.`);

  const rawBody = await req.text();
  let event;
  try {
    event = await provider.verifyWebhook({ rawBody, headers: req.headers, url: req.nextUrl });
  } catch (err) {
    if (err instanceof WebhookRejected) {
      logger.warn("payment webhook rejected", { provider: provider.key, reason: err.reason });
      throw new HttpError(400, err.reason, err.message);
    }
    throw err;
  }
  const outcome = await processPaymentEvent(provider.key, event);
  if (provider.key === "segpay") {
    // Segpay's synchronous postbacks compare the body with the "Expected Response" configured in its portal.
    return new Response("OK", { status: 200, headers: { "content-type": "text/plain", "x-payment-outcome": outcome } });
  }
  return NextResponse.json({ received: true, outcome });
}
