import { and, desc, eq } from "drizzle-orm";
import { getDb, type Tx } from "@/server/db";
import { creditAccounts, creditLedger } from "@/server/db/schema";

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

/** Locks the user's credit account row, creating it if needed: the per-user lock every balance change takes. */
export async function lockAccount(tx: Tx, userId: string) {
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

export function releaseJob(tx: Tx, userId: string, jobId: string, amount: number, note: string) {
  return applyMovement(tx, {
    userId,
    kind: "release",
    availableDelta: amount,
    reservedDelta: -amount,
    idempotencyKey: `job:${jobId}:close`,
    jobId,
    note,
  });
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
