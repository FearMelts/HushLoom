import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { pricing } from "@/config/pricing";
import { audit } from "@/server/audit";
import { applyMovement } from "@/server/credits/ledger";
import { getDb, type Tx } from "@/server/db";
import { accountFlags, creditAccounts, generationJobs, paymentEvents, subscriptions, userProfiles, users } from "@/server/db/schema";
import { HttpError } from "@/server/http";
import { logger } from "@/server/log";
import type { PaymentEvent, PaymentProvider } from "./types";
import { checkoutItem, toMoneyString } from "./util";

export type Outcome = "processed" | "duplicate" | "ignored";
type ProviderKey = PaymentProvider["key"];
type EventRow = typeof paymentEvents.$inferSelect;

/**
 * Clawback policy (addendum §1): a refund or chargeback reverses the credits the payment
 * granted, pro rata for partial amounts, through a negative ledger movement. If the account
 * has already spent them, the shortfall is recorded on the event and as a credit_debt flag
 * for an admin. Credits that creations in progress hold at that moment are recorded on the
 * flag and taken back when those creations are released (releaseJob), not returned to the
 * person. A chargeback additionally flags the account, which blocks new checkouts
 * (403 account_flagged) until an admin clears the flag; browsing and creating still work.
 */
export async function processPaymentEvent(provider: ProviderKey, event: PaymentEvent): Promise<Outcome> {
  const outcome = await getDb().transaction(async (tx) => {
    const [row] = await tx
      .insert(paymentEvents)
      .values({
        provider,
        providerEventId: event.providerEventId,
        type: event.type,
        transactionRef: "transactionRef" in event ? event.transactionRef : null,
        metadata: event.metadata ?? {},
      })
      .onConflictDoNothing()
      .returning();
    if (!row) return "duplicate" as const;

    const result = await apply(tx, provider, event, row);
    const metadata = { ...row.metadata, ...(result.patch.metadata ?? {}) };
    await tx
      .update(paymentEvents)
      .set({ ...result.patch, metadata, processedAt: new Date() })
      .where(eq(paymentEvents.id, row.id));
    await audit(null, `payment.${event.type}`, "payment_event", row.id, { provider, outcome: result.outcome, ...result.auditMeta }, tx);
    if (result.outcome === "processed" && (result.patch.credits ?? 0) > 0) {
      await applyPendingReversals(tx, provider, row.transactionRef, typeof metadata.subscriptionRef === "string" ? metadata.subscriptionRef : undefined);
    }
    return result.outcome;
  });
  logger.info("payment event", { provider, id: event.providerEventId, type: event.type, outcome });
  return outcome;
}

type Applied = { outcome: "processed" | "ignored"; patch: Partial<typeof paymentEvents.$inferInsert>; auditMeta?: Record<string, unknown> };

async function apply(tx: Tx, provider: ProviderKey, event: PaymentEvent, row: EventRow): Promise<Applied> {
  switch (event.type) {
    case "purchase_completed": {
      const item = checkoutItem(event.itemKey);
      if (!item || item.kind !== "pack") return { outcome: "ignored", patch: { metadata: { reason: "unknown_pack", itemKey: event.itemKey } } };
      const problem = event.review ?? notPaidInFull(event, item);
      if (problem) return holdForReview(tx, provider, event.userId, row, event, item.key, problem);
      await grant(tx, event.userId, item.credits, "purchase", `${provider}:${event.providerEventId}`, row.id, `${item.label} pack`);
      return {
        outcome: "processed",
        patch: { userId: event.userId, amountCents: event.amountCents, currency: event.currency, credits: item.credits, metadata: { itemKey: item.key, label: item.label } },
        auditMeta: { userId: event.userId, credits: item.credits },
      };
    }
    case "subscription_started": {
      const plan = pricing.plans.find((p) => p.key === event.itemKey);
      if (!plan) return { outcome: "ignored", patch: { metadata: { reason: "unknown_plan", itemKey: event.itemKey } } };
      const problem = event.review ?? notPaidInFull(event, { label: plan.label, priceCents: plan.priceCents, currency: pricing.currency });
      if (problem) return holdForReview(tx, provider, event.userId, row, event, plan.key, problem);
      await tx
        .insert(subscriptions)
        .values({
          userId: event.userId,
          planKey: plan.key,
          status: "active",
          provider,
          providerCustomerId: event.providerCustomerId ?? null,
          providerSubscriptionId: event.providerSubscriptionId,
          currentPeriodEnd: event.currentPeriodEnd ?? null,
        })
        .onConflictDoUpdate({
          target: subscriptions.providerSubscriptionId,
          set: { status: "active", planKey: plan.key, provider, providerCustomerId: event.providerCustomerId ?? null, currentPeriodEnd: event.currentPeriodEnd ?? null, updatedAt: new Date() },
        });
      await applyPendingCancellation(tx, provider, event.providerSubscriptionId, event.userId);
      const credits = event.grantsFirstPeriod ? plan.monthlyCredits : null;
      if (credits) await grant(tx, event.userId, credits, "subscription_grant", `${provider}:${event.providerEventId}`, row.id, `${plan.label} monthly credits`);
      return {
        outcome: "processed",
        patch: {
          userId: event.userId,
          amountCents: event.amountCents,
          currency: event.currency,
          credits,
          metadata: { itemKey: plan.key, label: plan.label, subscriptionRef: event.providerSubscriptionId },
        },
        auditMeta: { userId: event.userId, subscription: event.providerSubscriptionId, credits },
      };
    }
    case "subscription_renewed": {
      const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.providerSubscriptionId, event.providerSubscriptionId));
      const plan = sub && pricing.plans.find((p) => p.key === sub.planKey);
      // The start event may still be on its way; fail so the processor retries later.
      if (!sub || !plan) throw new Error(`subscription ${event.providerSubscriptionId} not known yet`);
      const problem = notPaidInFull(event, { label: plan.label, priceCents: plan.priceCents, currency: pricing.currency });
      if (problem) return holdForReview(tx, provider, sub.userId, row, event, plan.key, problem);
      await grant(tx, sub.userId, plan.monthlyCredits, "subscription_grant", `${provider}:${event.providerEventId}`, row.id, `${plan.label} monthly credits`);
      await tx
        .update(subscriptions)
        .set({ status: "active", currentPeriodEnd: event.currentPeriodEnd ?? sub.currentPeriodEnd, updatedAt: new Date() })
        .where(eq(subscriptions.id, sub.id));
      return {
        outcome: "processed",
        patch: {
          userId: sub.userId,
          amountCents: event.amountCents,
          currency: event.currency,
          credits: plan.monthlyCredits,
          metadata: { itemKey: plan.key, label: plan.label, subscriptionRef: event.providerSubscriptionId },
        },
        auditMeta: { userId: sub.userId, subscription: event.providerSubscriptionId, credits: plan.monthlyCredits },
      };
    }
    case "subscription_updated":
    case "subscription_cancelled": {
      const status = event.type === "subscription_cancelled" ? "canceled" : event.status;
      const [sub] = await tx
        .update(subscriptions)
        .set({ status, ...(event.currentPeriodEnd ? { currentPeriodEnd: event.currentPeriodEnd } : {}), updatedAt: new Date() })
        .where(eq(subscriptions.providerSubscriptionId, event.providerSubscriptionId))
        .returning({ userId: subscriptions.userId });
      // A cancellation can overtake the start of its pass; it is kept pending and applied when the pass starts.
      if (!sub) return { outcome: "ignored", patch: { metadata: { reason: "unknown_subscription", subscriptionRef: event.providerSubscriptionId, status, pending: event.type === "subscription_cancelled" } } };
      return { outcome: "processed", patch: { userId: sub.userId, metadata: { subscriptionRef: event.providerSubscriptionId, status } }, auditMeta: { userId: sub.userId, status } };
    }
    case "refund":
    case "chargeback":
      return clawback(tx, provider, event, row);
    case "ignored":
      return { outcome: "ignored", patch: { metadata: { raw: event.raw } } };
  }
}

/**
 * What was bought is decided by what the processor charged, not by the item the pass-through names:
 * a payment short of the price, or in another currency, is never granted automatically.
 */
function notPaidInFull(paid: { amountCents: number; currency: string }, item: { label: string; priceCents: number; currency: string }): string | null {
  if (paid.currency.toLowerCase() !== item.currency.toLowerCase()) return `paid in ${paid.currency.toUpperCase()}, ${item.label} is priced in ${item.currency.toUpperCase()}`;
  if (!(paid.amountCents >= item.priceCents)) return `paid ${toMoneyString(paid.amountCents)}, ${item.label} costs ${toMoneyString(item.priceCents)}`;
  return null;
}

/** Records a confirmed payment that must not be granted automatically and puts it in front of an operator. Nothing is granted. */
async function holdForReview(tx: Tx, provider: ProviderKey, userId: string, row: EventRow, paid: { amountCents: number; currency: string }, itemKey: string, problem: string): Promise<Applied> {
  logger.warn("payment held for review", { provider, id: row.providerEventId, itemKey });
  await tx.insert(accountFlags).values({
    userId,
    kind: "manual_review",
    reason: `A ${provider} payment was held, not granted: ${problem}. Check it with the processor, then grant or refund by hand.`,
    details: { paymentEventId: row.id, provider, itemKey, amountCents: paid.amountCents, currency: paid.currency, transactionRef: row.transactionRef, problem },
  });
  return {
    outcome: "ignored",
    patch: { userId, amountCents: paid.amountCents, currency: paid.currency, metadata: { reason: "needs_review", review: problem, itemKey } },
    auditMeta: { userId, review: problem },
  };
}

async function grant(tx: Tx, userId: string, credits: number, kind: "purchase" | "subscription_grant", key: string, paymentEventId: string, note: string) {
  await applyMovement(tx, { userId, kind, availableDelta: credits, reservedDelta: 0, idempotencyKey: key, paymentEventId, note });
}

/** The credited event a reversal refers to: by the processor's transaction id, else by its subscription / purchase id. */
async function findCreditedEvent(tx: Tx, provider: ProviderKey, transactionRef: string, subscriptionRef?: string) {
  const credited = and(eq(paymentEvents.provider, provider), gt(paymentEvents.credits, 0));
  const byRef = await tx
    .select()
    .from(paymentEvents)
    .where(and(credited, eq(paymentEvents.transactionRef, transactionRef)))
    .orderBy(desc(paymentEvents.createdAt))
    .limit(1);
  if (byRef[0]) return byRef[0];
  if (!subscriptionRef) return null;
  const bySub = await tx
    .select()
    .from(paymentEvents)
    .where(and(credited, sql`${paymentEvents.metadata}->>'subscriptionRef' = ${subscriptionRef}`))
    .orderBy(desc(paymentEvents.createdAt))
    .limit(1);
  return bySub[0] ?? null;
}

async function clawback(tx: Tx, provider: ProviderKey, event: Extract<PaymentEvent, { type: "refund" | "chargeback" }>, row: EventRow): Promise<Applied> {
  const original = await findCreditedEvent(tx, provider, event.transactionRef, event.subscriptionRef);
  if (!original || !original.userId || !original.credits) {
    // It may have overtaken its purchase (a sale retried after a 5xx, then voided the same day): kept
    // pending and applied by applyPendingReversals when that purchase is credited.
    logger.warn("payment reversal without a matching purchase; kept pending", { provider, id: event.providerEventId, transactionRef: event.transactionRef });
    return {
      outcome: "ignored",
      patch: {
        currency: event.currency,
        metadata: {
          reason: "original_not_found",
          pending: true,
          transactionRef: event.transactionRef,
          subscriptionRef: event.subscriptionRef ?? null,
          pendingAmountCents: event.amountCents,
          cumulative: event.type === "refund" && event.cumulative === true,
        },
      },
    };
  }
  const userId = original.userId;
  const granted = original.credits;

  // Reversals of one payment run one at a time: lock it before reading what earlier ones took back,
  // so a refund and a chargeback processed together cannot each claw back the whole grant.
  await tx.select({ id: paymentEvents.id }).from(paymentEvents).where(eq(paymentEvents.id, original.id)).for("update");

  // Earlier reversals of the same payment (partial refunds, a refund followed by a chargeback).
  const earlier = await tx
    .select({ credits: sql<number>`coalesce(sum(-${paymentEvents.credits}), 0)::int`, amount: sql<number>`coalesce(sum(-${paymentEvents.amountCents}), 0)::int` })
    .from(paymentEvents)
    .where(and(eq(paymentEvents.provider, provider), sql`${paymentEvents.metadata}->>'reversesEventId' = ${original.id}`));
  const alreadyReversed = earlier[0]?.credits ?? 0;
  const amountReversedBefore = earlier[0]?.amount ?? 0;

  // Pro rata for partial amounts; a full reversal (or one with no usable amounts) takes everything back.
  const paid = original.amountCents ?? 0;
  const totalReversed = event.type === "refund" && event.cumulative ? event.amountCents : amountReversedBefore + event.amountCents;
  const target = paid > 0 && event.amountCents > 0 ? Math.min(granted, Math.ceil((granted * totalReversed) / paid)) : granted;
  const owed = Math.max(0, target - alreadyReversed);

  const [account] = await tx.select().from(creditAccounts).where(eq(creditAccounts.userId, userId)).for("update");
  const available = account?.available ?? 0;
  const reversed = Math.min(available, owed);
  const shortfall = owed - reversed;
  const label = typeof original.metadata.label === "string" ? original.metadata.label : "purchase";

  if (reversed > 0) {
    await applyMovement(tx, {
      userId,
      kind: event.type,
      availableDelta: -reversed,
      reservedDelta: 0,
      idempotencyKey: `${event.type}:${provider}:${event.providerEventId}`,
      paymentEventId: row.id,
      note: event.type === "refund" ? `Refund of ${label}` : `Chargeback on ${label}`,
    });
  }
  if (shortfall > 0) {
    // Credits held by creations in progress are not spent yet: they are taken back if those creations are released.
    const held = Math.min(shortfall, account?.reserved ?? 0);
    const heldJobIds = held > 0 ? (await tx.select({ id: generationJobs.id }).from(generationJobs).where(and(eq(generationJobs.userId, userId), inArray(generationJobs.status, ["queued", "processing"])))).map((j) => j.id) : [];
    const what = event.type === "refund" ? "Refund" : "Chargeback";
    await tx.insert(accountFlags).values({
      userId,
      kind: "credit_debt",
      reason: held > 0
        ? `${what} of ${label}: ${shortfall} credits were already spent or held by creations in progress; the ${held} held are taken back if those creations are cancelled or fail.`
        : `${what} of ${label}: ${shortfall} credits were already spent.`,
      details: { paymentEventId: row.id, originalEventId: original.id, transactionRef: event.transactionRef, shortfall, reversed, reversal: event.type, held, heldJobIds, outstanding: held, collected: 0 },
    });
  }
  if (event.type === "chargeback") {
    await tx.insert(accountFlags).values({
      userId,
      kind: "chargeback",
      reason: `Chargeback on ${label} (${provider} ${event.transactionRef}). Checkout is paused until an operator clears this.`,
      details: { paymentEventId: row.id, originalEventId: original.id, transactionRef: event.transactionRef, amountCents: event.amountCents, reversed, shortfall },
    });
  }
  const thisAmount = event.type === "refund" && event.cumulative ? Math.max(0, event.amountCents - amountReversedBefore) : event.amountCents;
  return {
    outcome: "processed",
    patch: {
      userId,
      amountCents: -thisAmount,
      currency: event.currency,
      credits: -reversed,
      metadata: { reversesEventId: original.id, originalTransactionRef: original.transactionRef, label, creditsReversed: reversed, shortfall },
    },
    auditMeta: { userId, creditsReversed: reversed, shortfall, originalEventId: original.id },
  };
}

/**
 * Reversals that arrived before the payment they reverse are applied in the transaction that credits
 * that payment. They keep their own ledger key, so each still moves credits exactly once, and a
 * redelivery of either event is a duplicate.
 */
async function applyPendingReversals(tx: Tx, provider: ProviderKey, transactionRef: string | null, subscriptionRef: string | undefined) {
  const refs = [
    ...(transactionRef ? [eq(paymentEvents.transactionRef, transactionRef)] : []),
    ...(subscriptionRef ? [sql`${paymentEvents.metadata}->>'subscriptionRef' = ${subscriptionRef}`] : []),
  ];
  if (!refs.length) return;
  const pending = await tx
    .select()
    .from(paymentEvents)
    .where(and(eq(paymentEvents.provider, provider), inArray(paymentEvents.type, ["refund", "chargeback"]), sql`${paymentEvents.metadata}->>'pending' = 'true'`, or(...refs)))
    .orderBy(paymentEvents.createdAt)
    .for("update");
  for (const row of pending) {
    const m = row.metadata;
    const base = {
      providerEventId: row.providerEventId,
      transactionRef: row.transactionRef ?? "",
      amountCents: typeof m.pendingAmountCents === "number" ? m.pendingAmountCents : 0,
      currency: row.currency ?? "",
      subscriptionRef: typeof m.subscriptionRef === "string" ? m.subscriptionRef : undefined,
    };
    const reversal = row.type === "refund" ? { type: "refund" as const, ...base, cumulative: m.cumulative === true } : { type: "chargeback" as const, ...base };
    const result = await clawback(tx, provider, reversal, row);
    if (result.outcome !== "processed") continue;
    await tx
      .update(paymentEvents)
      .set({ ...result.patch, metadata: { ...m, ...result.patch.metadata, reason: "applied_after_purchase", pending: false } })
      .where(eq(paymentEvents.id, row.id));
    await audit(null, `payment.${row.type}`, "payment_event", row.id, { provider, outcome: result.outcome, appliedAfterPurchase: true, ...result.auditMeta }, tx);
  }
}

/** A cancellation that arrived before its pass started ends the pass as soon as it exists. */
async function applyPendingCancellation(tx: Tx, provider: ProviderKey, providerSubscriptionId: string, userId: string) {
  const ended = await tx
    .update(paymentEvents)
    .set({ userId, metadata: sql`${paymentEvents.metadata} || '{"pending": false}'::jsonb` })
    .where(
      and(
        eq(paymentEvents.provider, provider),
        eq(paymentEvents.type, "subscription_cancelled"),
        sql`${paymentEvents.metadata}->>'pending' = 'true'`,
        sql`${paymentEvents.metadata}->>'subscriptionRef' = ${providerSubscriptionId}`,
      ),
    )
    .returning({ status: sql<string | null>`${paymentEvents.metadata}->>'status'`, createdAt: paymentEvents.createdAt });
  const latest = ended.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (!latest) return;
  await tx
    .update(subscriptions)
    .set({ status: latest.status ?? "canceled", updatedAt: new Date() })
    .where(eq(subscriptions.providerSubscriptionId, providerSubscriptionId));
}

// ── Flags ──────────────────────────────────────────────────────────────────

export async function openFlags(userId: string) {
  return getDb()
    .select()
    .from(accountFlags)
    .where(and(eq(accountFlags.userId, userId), isNull(accountFlags.clearedAt)))
    .orderBy(desc(accountFlags.createdAt));
}

/** Chargebacks pause buying until an operator looks. Other flags (credit_debt, reviews) do not block checkout. */
export async function checkoutBlock(userId: string): Promise<string | null> {
  const flags = await openFlags(userId);
  return flags.some((f) => f.kind === "chargeback") ? "Buying is paused on this account after a chargeback. Write to support and we will sort it out." : null;
}

export async function assertCanCheckout(userId: string) {
  const block = await checkoutBlock(userId);
  if (block) throw new HttpError(403, "account_flagged", block);
}

export async function listFlags(opts: { includeCleared?: boolean; limit?: number } = {}) {
  const rows = await getDb()
    .select({ f: accountFlags, handle: userProfiles.handle, email: users.email, clearedBy: sql<string | null>`(select handle from user_profiles p where p.user_id = ${accountFlags.clearedBy})` })
    .from(accountFlags)
    .innerJoin(users, eq(users.id, accountFlags.userId))
    .leftJoin(userProfiles, eq(userProfiles.userId, accountFlags.userId))
    .where(opts.includeCleared ? undefined : isNull(accountFlags.clearedAt))
    .orderBy(desc(accountFlags.createdAt))
    .limit(opts.limit ?? 100);
  return rows.map((r) => ({
    id: r.f.id,
    kind: r.f.kind,
    reason: r.f.reason,
    details: r.f.details,
    createdAt: r.f.createdAt.toISOString(),
    clearedAt: r.f.clearedAt?.toISOString() ?? null,
    clearedBy: r.clearedBy,
    user: { id: r.f.userId, handle: r.handle, email: r.email },
  }));
}

export async function clearFlag(adminId: string, flagId: string, note: string) {
  // An abuse-scan flag is cleared only through the review queue, which also restores the asset and the account.
  const [kind] = await getDb().select({ kind: accountFlags.kind }).from(accountFlags).where(eq(accountFlags.id, flagId));
  if (kind?.kind === "csam_match") throw new HttpError(409, "use_review_queue", "Abuse-match flags are cleared from Admin › Abuse review.");
  const [flag] = await getDb()
    .update(accountFlags)
    .set({ clearedAt: new Date(), clearedBy: adminId, details: sql`${accountFlags.details} || ${JSON.stringify({ clearNote: note })}::jsonb` })
    .where(and(eq(accountFlags.id, flagId), isNull(accountFlags.clearedAt)))
    .returning();
  if (!flag) throw new HttpError(404, "not_found", "No open flag with that id.");
  await audit(adminId, "flag.clear", "user", flag.userId, { flagId, kind: flag.kind, note });
  return flag;
}

// ── History ────────────────────────────────────────────────────────────────

export const EVENT_LABEL: Record<string, string> = {
  purchase_completed: "Credit pack",
  subscription_started: "Pass started",
  subscription_renewed: "Pass renewed",
  subscription_updated: "Pass updated",
  subscription_cancelled: "Pass ended",
  refund: "Refund",
  chargeback: "Chargeback",
  ignored: "Notice",
};

/** The signed-in person's own payment events, newest first. Only what the processor confirmed to the server. */
export async function listPaymentHistory(userId: string, limit = 40) {
  return getDb()
    .select({
      id: paymentEvents.id,
      provider: paymentEvents.provider,
      type: paymentEvents.type,
      amountCents: paymentEvents.amountCents,
      currency: paymentEvents.currency,
      credits: paymentEvents.credits,
      transactionRef: paymentEvents.transactionRef,
      metadata: paymentEvents.metadata,
      createdAt: paymentEvents.createdAt,
    })
    .from(paymentEvents)
    .where(eq(paymentEvents.userId, userId))
    .orderBy(desc(paymentEvents.createdAt))
    .limit(limit);
}
