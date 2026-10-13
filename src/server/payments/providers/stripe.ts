import Stripe from "stripe";
import { env } from "@/server/env";
import { HttpError } from "@/server/http";
import type { PaymentEvent, PaymentProvider } from "../types";
import { WebhookRejected } from "../types";
import { checkoutItem } from "../util";

/**
 * Stripe, behind the adapter and OFF BY DEFAULT.
 *
 * Stripe's restricted-businesses policy (https://stripe.com/legal/restricted-businesses) prohibits
 * "pornography and other obscene materials" and mature content, and names AI-generated content
 * too. Hushloom is an adult product, so Stripe cannot be its live payment rail: an account used
 * this way would be closed and funds held. The adapter stays so a non-explicit deployment, or a
 * test rig, can use it, but it is only active when PAYMENT_PROVIDER=stripe AND the keys exist.
 * adultContentAllowed is false and the pricing page says which processor is live.
 */

function keys() {
  const e = env();
  return { secret: e.STRIPE_SECRET_KEY ?? null, webhook: e.STRIPE_WEBHOOK_SECRET ?? null };
}

function client(): Stripe {
  const key = keys().secret;
  if (!key) throw new HttpError(503, "payments_unavailable", "Payments are not configured on this server yet.");
  return new Stripe(key);
}

/** Verifies the signature with the webhook secret. Throws on a bad or missing signature. */
export function verifyStripeEvent(rawBody: string, signature: string | null): Stripe.Event {
  const secret = keys().webhook;
  if (!secret) throw new HttpError(503, "payments_unavailable", "Webhook secret not configured.");
  if (!signature) throw new WebhookRejected("unsigned", "Missing signature.");
  try {
    // Signature checks are offline; the API key is not used here.
    return new Stripe(keys().secret ?? "sk_unused").webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    throw new WebhookRejected("bad_signature", "Invalid signature.");
  }
}

type Sub = Stripe.Subscription & { current_period_end?: number };

function periodEnd(sub: Sub): Date | undefined {
  const s = sub.items?.data?.[0]?.current_period_end ?? sub.current_period_end;
  return s ? new Date(s * 1000) : undefined;
}

const idOf = (v: string | { id: string } | null | undefined) => (typeof v === "string" ? v : (v?.id ?? undefined));

/** Maps a verified Stripe event to the shared shape. Unknown types are recorded as ignored. */
export function stripeEventToPayment(event: Stripe.Event): PaymentEvent {
  const providerEventId = event.id;
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      // Delayed methods (bank debits) complete unpaid and confirm later with the second event, which carries the same session.
      const s = event.data.object;
      const userId = s.metadata?.userId;
      const itemKey = s.metadata?.itemKey;
      const item = itemKey ? checkoutItem(itemKey) : null;
      if (!userId || !item) return { type: "ignored", providerEventId, raw: "checkout.session.completed without Hushloom metadata" };
      if (s.mode === "payment" && item.kind === "pack") {
        if (s.payment_status !== "paid") return { type: "ignored", providerEventId, raw: `checkout ${s.id} ${s.payment_status}` };
        return {
          type: "purchase_completed",
          providerEventId,
          userId,
          itemKey: item.key,
          amountCents: s.amount_total ?? item.priceCents,
          currency: s.currency ?? item.currency,
          transactionRef: idOf(s.payment_intent) ?? s.id,
          metadata: { sessionId: s.id },
        };
      }
      if (s.mode === "subscription" && item.kind === "plan" && typeof s.subscription === "string") {
        return {
          type: "subscription_started",
          providerEventId,
          userId,
          itemKey: item.key,
          providerSubscriptionId: s.subscription,
          providerCustomerId: idOf(s.customer),
          amountCents: s.amount_total ?? item.priceCents,
          currency: s.currency ?? item.currency,
          transactionRef: s.id,
          // Stripe bills the first period through invoice.paid, which grants the credits.
          grantsFirstPeriod: false,
          metadata: { sessionId: s.id },
        };
      }
      return { type: "ignored", providerEventId, raw: `checkout ${s.id} mode ${s.mode}` };
    }
    case "invoice.paid": {
      const inv = event.data.object as Stripe.Invoice & { subscription?: string | null };
      const subId = inv.subscription ?? (inv.parent?.subscription_details?.subscription as string | undefined) ?? null;
      if (!subId) return { type: "ignored", providerEventId, raw: `invoice ${inv.id} without subscription` };
      const line = inv.lines?.data?.[0];
      return {
        type: "subscription_renewed",
        providerEventId,
        providerSubscriptionId: String(subId),
        amountCents: inv.amount_paid,
        currency: inv.currency,
        transactionRef: inv.id ?? providerEventId,
        currentPeriodEnd: line?.period?.end ? new Date(line.period.end * 1000) : undefined,
        metadata: { invoiceId: inv.id },
      };
    }
    case "customer.subscription.updated": {
      const sub = event.data.object as Sub;
      return { type: "subscription_updated", providerEventId, providerSubscriptionId: sub.id, status: sub.status, currentPeriodEnd: periodEnd(sub) };
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object as Sub;
      return { type: "subscription_cancelled", providerEventId, providerSubscriptionId: sub.id, currentPeriodEnd: periodEnd(sub) };
    }
    case "charge.refunded": {
      // Older API versions link a charge to its invoice directly; newer ones only through the payment intent.
      const ch = event.data.object as Stripe.Charge & { invoice?: string | { id: string } | null };
      return {
        type: "refund",
        providerEventId,
        transactionRef: idOf(ch.payment_intent) ?? ch.id,
        subscriptionRef: idOf(ch.invoice) ?? undefined,
        amountCents: ch.amount_refunded,
        currency: ch.currency,
        cumulative: true,
        metadata: { chargeId: ch.id, invoiceId: idOf(ch.invoice) },
      };
    }
    case "charge.dispute.created": {
      const d = event.data.object;
      return {
        type: "chargeback",
        providerEventId,
        transactionRef: idOf(d.payment_intent) ?? idOf(d.charge) ?? providerEventId,
        amountCents: d.amount,
        currency: d.currency,
        metadata: { disputeId: d.id, chargeId: idOf(d.charge), reason: d.reason },
      };
    }
    default:
      return { type: "ignored", providerEventId, raw: event.type };
  }
}

export const stripeProvider: PaymentProvider = {
  key: "stripe",
  label: "Stripe",
  isSandbox: false,
  capabilities: { packs: true, subscriptions: true, refunds: true, adultContentAllowed: false },
  isConfigured: () => env().PAYMENT_PROVIDER === "stripe" && Boolean(keys().secret && keys().webhook),
  webhookConfigured: () => Boolean(keys().webhook),
  configurationProblem() {
    if (env().PAYMENT_PROVIDER !== "stripe") return "PAYMENT_PROVIDER is not stripe.";
    const m = (["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] as const).filter((k) => !env()[k]);
    return m.length ? `Missing ${m.join(", ")}.` : null;
  },
  async createCheckout({ user, item, successUrl, cancelUrl }) {
    const session = await client().checkout.sessions.create({
      mode: item.kind === "plan" ? "subscription" : "payment",
      customer_email: user.email,
      client_reference_id: user.id,
      metadata: { userId: user.id, itemKey: item.key },
      subscription_data: item.kind === "plan" ? { metadata: { userId: user.id, itemKey: item.key } } : undefined,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: item.currency,
            unit_amount: item.priceCents,
            product_data: { name: item.kind === "pack" ? `${item.label}: ${item.credits} credits` : `${item.label} (monthly)` },
            recurring: item.kind === "plan" ? { interval: "month" } : undefined,
          },
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
    });
    if (!session.url) throw new HttpError(502, "checkout_failed", "Checkout could not be started.");
    return { url: session.url, providerRef: session.id };
  },
  async verifyWebhook({ rawBody, headers }) {
    return stripeEventToPayment(verifyStripeEvent(rawBody, headers.get("stripe-signature")));
  },
};
