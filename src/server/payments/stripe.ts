import Stripe from "stripe";
import { and, eq } from "drizzle-orm";
import { pricing } from "@/config/pricing";
import { audit } from "@/server/audit";
import { applyMovement } from "@/server/credits/ledger";
import { getDb, type Tx } from "@/server/db";
import { paymentEvents, subscriptions } from "@/server/db/schema";
import { env } from "@/server/env";
import { HttpError } from "@/server/http";
import { logger } from "@/server/log";

export function paymentsConfigured(): boolean {
  return Boolean(env().STRIPE_SECRET_KEY && env().STRIPE_WEBHOOK_SECRET);
}

function client(): Stripe {
  const key = env().STRIPE_SECRET_KEY;
  if (!key) throw new HttpError(503, "payments_unavailable", "Payments are not configured on this server yet.");
  return new Stripe(key);
}

export async function createCheckout(user: { id: string; email: string }, itemKey: string): Promise<string> {
  const pack = pricing.packs.find((p) => p.key === itemKey);
  const plan = pricing.plans.find((p) => p.key === itemKey);
  if (!pack && !plan) throw new HttpError(422, "unknown_item", "That package does not exist.");
  const base = env().APP_URL;
  const session = await client().checkout.sessions.create({
    mode: plan ? "subscription" : "payment",
    customer_email: user.email,
    client_reference_id: user.id,
    metadata: { userId: user.id, itemKey },
    subscription_data: plan ? { metadata: { userId: user.id, itemKey } } : undefined,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: pricing.currency,
          unit_amount: (pack ?? plan)!.priceCents,
          product_data: { name: pack ? `${pack.label}: ${pack.credits} credits` : `${plan!.label} (monthly)` },
          recurring: plan ? { interval: "month" } : undefined,
        },
      },
    ],
    success_url: `${base}/pricing?checkout=success`,
    cancel_url: `${base}/pricing?checkout=cancelled`,
  });
  if (!session.url) throw new HttpError(502, "checkout_failed", "Checkout could not be started.");
  return session.url;
}

/** Verifies the signature with the webhook secret. Throws on a bad or missing signature. */
export function verifyStripeEvent(rawBody: string, signature: string | null): Stripe.Event {
  const secret = env().STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new HttpError(503, "payments_unavailable", "Webhook secret not configured.");
  if (!signature) throw new HttpError(400, "bad_signature", "Missing signature.");
  try {
    // Signature checks are offline; the API key is not used here.
    return new Stripe(env().STRIPE_SECRET_KEY ?? "sk_unused").webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    throw new HttpError(400, "bad_signature", "Invalid signature.");
  }
}

type Sub = Stripe.Subscription & { current_period_end?: number };

function periodEnd(sub: Sub): Date | null {
  const s = sub.items?.data?.[0]?.current_period_end ?? sub.current_period_end;
  return s ? new Date(s * 1000) : null;
}

async function grant(tx: Tx, userId: string, credits: number, kind: "purchase" | "subscription_grant", key: string, paymentEventId: string, note: string) {
  await applyMovement(tx, { userId, kind, availableDelta: credits, reservedDelta: 0, idempotencyKey: key, paymentEventId, note });
}

/**
 * Applies a verified Stripe event exactly once. The event row and its effects
 * commit together; if processing throws, nothing commits and Stripe retries.
 */
export async function processStripeEvent(event: Stripe.Event): Promise<"processed" | "duplicate" | "ignored"> {
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .insert(paymentEvents)
      .values({ provider: "stripe", providerEventId: event.id, type: event.type })
      .onConflictDoNothing()
      .returning();
    if (!row) return "duplicate";

    let outcome: "processed" | "ignored" = "processed";
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        const userId = s.metadata?.userId;
        const itemKey = s.metadata?.itemKey;
        if (!userId || !itemKey) {
          outcome = "ignored";
          break;
        }
        const pack = pricing.packs.find((p) => p.key === itemKey);
        const plan = pricing.plans.find((p) => p.key === itemKey);
        if (s.mode === "payment" && pack) {
          if (s.payment_status !== "paid") {
            outcome = "ignored";
            break;
          }
          await grant(tx, userId, pack.credits, "purchase", `stripe:${event.id}`, row.id, `${pack.label} pack`);
          await tx
            .update(paymentEvents)
            .set({ userId, amountCents: s.amount_total, currency: s.currency, credits: pack.credits })
            .where(eq(paymentEvents.id, row.id));
        } else if (s.mode === "subscription" && plan && typeof s.subscription === "string") {
          await tx
            .insert(subscriptions)
            .values({ userId, planKey: plan.key, status: "active", providerSubscriptionId: s.subscription })
            .onConflictDoUpdate({ target: subscriptions.providerSubscriptionId, set: { status: "active", planKey: plan.key, updatedAt: new Date() } });
          await tx.update(paymentEvents).set({ userId, amountCents: s.amount_total, currency: s.currency }).where(eq(paymentEvents.id, row.id));
        } else {
          outcome = "ignored";
        }
        break;
      }
      case "invoice.paid": {
        const inv = event.data.object as Stripe.Invoice & { subscription?: string | null };
        const subId = inv.subscription ?? (inv.parent?.subscription_details?.subscription as string | undefined) ?? null;
        if (!subId) {
          outcome = "ignored";
          break;
        }
        const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.providerSubscriptionId, String(subId)));
        const plan = sub && pricing.plans.find((p) => p.key === sub.planKey);
        if (!sub || !plan) {
          // The checkout event may arrive after the invoice; fail so Stripe retries later.
          throw new Error(`subscription ${subId} not known yet`);
        }
        await grant(tx, sub.userId, plan.monthlyCredits, "subscription_grant", `stripe-invoice:${inv.id}`, row.id, `${plan.label} monthly credits`);
        await tx
          .update(paymentEvents)
          .set({ userId: sub.userId, amountCents: inv.amount_paid, currency: inv.currency, credits: plan.monthlyCredits })
          .where(eq(paymentEvents.id, row.id));
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Sub;
        const status = event.type === "customer.subscription.deleted" ? "canceled" : sub.status;
        await tx
          .update(subscriptions)
          .set({ status, currentPeriodEnd: periodEnd(sub), updatedAt: new Date() })
          .where(eq(subscriptions.providerSubscriptionId, sub.id));
        break;
      }
      default:
        outcome = "ignored";
    }
    await tx.update(paymentEvents).set({ processedAt: new Date() }).where(and(eq(paymentEvents.id, row.id)));
    await audit(null, `payment.${event.type}`, "payment_event", row.id, { outcome }, tx);
    logger.info("stripe event", { id: event.id, type: event.type, outcome });
    return outcome;
  });
}
