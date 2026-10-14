import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, type Tx } from "@/server/db";
import { accountFlags, creditAccounts, creditLedger, paymentEvents } from "@/server/db/schema";

export class InsufficientCreditsError extends Error {
  constructor(
    public readonly needed: number,
    public readonly available: number,
  ) {
    super(`This needs ${needed} credits and you have ${available}.`);
  }
}

type LedgerKind = (typeof creditLedger.$inferInsert)["kind"];

type Movement = {
  userId: string;
  kind: LedgerKind;
  availableDelta: number;
  reservedDelta: number;
  idempotencyKey: string;
  jobId?: string;
  paymentEventId?: string;
  note?: string;
};

export type MovementResult = { applied: boolean; available: number; reserved: number };

async function lockAccount(tx: Tx, userId: string) {
  await tx.insert(creditAccounts).values({ userId }).onConflictDoNothing();
  const [account] = await tx.select().from(creditAccounts).where(eq(creditAccounts.userId, userId)).for("update");
  if (!account) throw new Error("credit account missing after upsert");
  return account;
}

/**
 * The only function that changes a balance. It locks the account row, skips the
 * movement if its idempotency key was already recorded, and writes the ledger
 * entry in the same transaction as the balance change.
 */
export async function applyMovement(tx: Tx, m: Movement): Promise<MovementResult> {
  const account = await lockAccount(tx, m.userId);
  const [existing] = await tx
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(eq(creditLedger.idempotencyKey, m.idempotencyKey))
    .limit(1);
  if (existing) return { applied: false, available: account.available, reserved: account.reserved };

  const available = account.available + m.availableDelta;
  const reserved = account.reserved + m.reservedDelta;
  if (available < 0) throw new InsufficientCreditsError(-m.availableDelta, account.available);
  if (reserved < 0) throw new Error(`ledger invariant: reserved would go negative for ${m.userId}`);

  await tx.update(creditAccounts).set({ available, reserved, updatedAt: new Date() }).where(eq(creditAccounts.userId, m.userId));
  await tx.insert(creditLedger).values({
    userId: m.userId,
    kind: m.kind,
    availableDelta: m.availableDelta,
    reservedDelta: m.reservedDelta,
    availableAfter: available,
    reservedAfter: reserved,
    jobId: m.jobId,
    paymentEventId: m.paymentEventId,
    idempotencyKey: m.idempotencyKey,
    note: m.note ?? "",
  });
  return { applied: true, available, reserved };
}

export function reserveForJob(tx: Tx, userId: string, jobId: string, amount: number) {
  return applyMovement(tx, {
    userId,
    kind: "reserve",
    availableDelta: -amount,
    reservedDelta: amount,
    idempotencyKey: `job:${jobId}:reserve`,
    jobId,
  });
}

/**
 * Settle and release share one key, so a job's reservation is closed exactly once:
 * a job can never be both charged and refunded, or charged twice.
 */
export function settleJob(tx: Tx, userId: string, jobId: string, amount: number) {
  return applyMovement(tx, {
    userId,
    kind: "settle",
    availableDelta: 0,
    reservedDelta: -amount,
    idempotencyKey: `job:${jobId}:close`,
    jobId,
  });
}

export async function releaseJob(tx: Tx, userId: string, jobId: string, amount: number, note: string) {
  const debts = await heldDebts(tx, userId, jobId);
  const result = await applyMovement(tx, {
    userId,
    kind: "release",
    availableDelta: amount,
    reservedDelta: -amount,
    idempotencyKey: `job:${jobId}:close`,
    jobId,
    note,
  });
  if (!result.applied || !debts.length) return result;
  const collected = await collectHeldDebts(tx, userId, jobId, amount, debts);
  return { ...result, available: result.available - collected };
}

/**
 * A refund or chargeback that found the refunded credits held by creations in progress records
 * those jobs and the amount on its credit_debt flag (payments/service.ts). Locks the reversed
 * payments first, in the order the clawback takes them, then the open flags that name this job.
 */
async function heldDebts(tx: Tx, userId: string, jobId: string) {
  const open = and(
    eq(accountFlags.userId, userId),
    eq(accountFlags.kind, "credit_debt"),
    isNull(accountFlags.clearedAt),
    sql`${accountFlags.details}->'heldJobIds' @> ${JSON.stringify([jobId])}::jsonb`,
    sql`coalesce((${accountFlags.details}->>'outstanding')::int, 0) > 0`,
  );
  const found = await tx.select({ details: accountFlags.details }).from(accountFlags).where(open);
  const originals = found.map((f) => f.details.originalEventId).filter((id): id is string => typeof id === "string");
  if (!originals.length) return [];
  await tx.select({ id: paymentEvents.id }).from(paymentEvents).where(inArray(paymentEvents.id, originals)).orderBy(paymentEvents.id).for("update");
  return tx.select().from(accountFlags).where(open).orderBy(accountFlags.createdAt).for("update");
}

/** Takes the released credits back for the reversal, up to what each flag still has outstanding, once per job and flag. */
async function collectHeldDebts(tx: Tx, userId: string, jobId: string, released: number, debts: (typeof accountFlags.$inferSelect)[]): Promise<number> {
  let left = released;
  for (const flag of debts) {
    const d = flag.details;
    const take = Math.min(left, Number(d.outstanding));
    if (take <= 0) break;
    const reversal = typeof d.paymentEventId === "string" ? d.paymentEventId : undefined;
    const moved = await applyMovement(tx, {
      userId,
      kind: d.reversal === "chargeback" ? "chargeback" : "refund",
      availableDelta: -take,
      reservedDelta: 0,
      idempotencyKey: `debt:${flag.id}:job:${jobId}`,
      jobId,
      paymentEventId: reversal,
      note: "Held by a creation when the payment was reversed; taken back when it was released",
    });
    if (!moved.applied) continue;
    left -= take;
    await tx
      .update(accountFlags)
      .set({ details: sql`${accountFlags.details} || ${JSON.stringify({ outstanding: Number(d.outstanding) - take, collected: Number(d.collected ?? 0) + take })}::jsonb` })
      .where(eq(accountFlags.id, flag.id));
    // The reversal's own row counts what it took back, so a later reversal of the same payment owes only the rest.
    if (reversal) {
      await tx
        .update(paymentEvents)
        .set({
          credits: sql`${paymentEvents.credits} - ${take}::int`,
          metadata: sql`${paymentEvents.metadata} || jsonb_build_object('creditsReversed', coalesce((${paymentEvents.metadata}->>'creditsReversed')::int, 0) + ${take}::int, 'shortfall', greatest(coalesce((${paymentEvents.metadata}->>'shortfall')::int, 0) - ${take}::int, 0))`,
        })
        .where(eq(paymentEvents.id, reversal));
    }
  }
  return released - left;
}

export async function getBalance(userId: string): Promise<{ available: number; reserved: number }> {
  const [row] = await getDb().select().from(creditAccounts).where(eq(creditAccounts.userId, userId));
  return { available: row?.available ?? 0, reserved: row?.reserved ?? 0 };
}

export async function listLedger(userId: string, limit = 50) {
  return getDb()
    .select()
    .from(creditLedger)
    .where(and(eq(creditLedger.userId, userId)))
    .orderBy(desc(creditLedger.createdAt))
    .limit(limit);
}
