import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { MODELS } from "@/server/ai/registry";
import { listModelAvailability } from "@/server/ai/providers";
import { audit } from "@/server/audit";
import { destroyAllSessions } from "@/server/auth/session";
import { applyMovement } from "@/server/credits/ledger";
import { getDb } from "@/server/db";
import {
  auditLogs,
  creditLedger,
  generationJobs,
  generationOutputs,
  mediaAssets,
  modelConfigs,
  moderationEvents,
  paymentEvents,
  templates,
  userProfiles,
  users,
} from "@/server/db/schema";
import { HttpError, notFound } from "@/server/http";

const SEVERE = ["minor", "non_consent", "real_person", "illegal"];

export async function adminStats() {
  const db = getDb();
  const day = sql`now() - interval '24 hours'`;
  const month = sql`now() - interval '30 days'`;
  const [[u], jobs, [timing], [money], [reports]] = await Promise.all([
    db
      .select({
        total: sql<number>`count(*) filter (where ${users.status} = 'active')::int`,
        new24: sql<number>`count(*) filter (where ${users.createdAt} > ${day})::int`,
      })
      .from(users),
    db
      .select({ status: generationJobs.status, demo: generationJobs.isDemo, n: sql<number>`count(*)::int` })
      .from(generationJobs)
      .where(gt(generationJobs.createdAt, sql`${day}`))
      .groupBy(generationJobs.status, generationJobs.isDemo),
    db
      .select({
        p50: sql<number | null>`percentile_cont(0.5) within group (order by extract(epoch from ${generationJobs.finishedAt} - ${generationJobs.startedAt}))`,
        p95: sql<number | null>`percentile_cont(0.95) within group (order by extract(epoch from ${generationJobs.finishedAt} - ${generationJobs.startedAt}))`,
      })
      .from(generationJobs)
      .where(and(eq(generationJobs.status, "completed"), gt(generationJobs.finishedAt, sql`${day}`))),
    db
      .select({ cents: sql<number>`coalesce(sum(${paymentEvents.amountCents}), 0)::int`, credits: sql<number>`coalesce(sum(${paymentEvents.credits}), 0)::int` })
      .from(paymentEvents)
      .where(gt(paymentEvents.createdAt, sql`${month}`)),
    db.select({ n: sql<number>`count(*)::int` }).from(moderationEvents).where(eq(moderationEvents.status, "open")),
  ]);
  const byStatus = (s: string) => jobs.filter((j) => j.status === s).reduce((a, j) => a + j.n, 0);
  const finished = byStatus("completed") + byStatus("failed");
  const [spent] = await db
    .select({ n: sql<number>`coalesce(-sum(${creditLedger.reservedDelta}), 0)::int` })
    .from(creditLedger)
    .where(and(eq(creditLedger.kind, "settle"), gt(creditLedger.createdAt, sql`${day}`)));
  return {
    users: u?.total ?? 0,
    newUsers24h: u?.new24 ?? 0,
    jobs24h: { queued: byStatus("queued"), processing: byStatus("processing"), completed: byStatus("completed"), failed: byStatus("failed"), cancelled: byStatus("cancelled") },
    demoJobs24h: jobs.filter((j) => j.demo).reduce((a, j) => a + j.n, 0),
    failureRate24h: finished ? byStatus("failed") / finished : null,
    secondsP50: timing?.p50 ?? null,
    secondsP95: timing?.p95 ?? null,
    revenueCents30d: money?.cents ?? 0,
    creditsSold30d: money?.credits ?? 0,
    creditsSpent24h: spent?.n ?? 0,
    openReports: reports?.n ?? 0,
  };
}

export async function moderationQueue() {
  const rows = await getDb()
    .select({ e: moderationEvents, reporter: userProfiles.handle })
    .from(moderationEvents)
    .leftJoin(userProfiles, eq(userProfiles.userId, moderationEvents.reporterId))
    .where(eq(moderationEvents.status, "open"))
    .orderBy(desc(moderationEvents.createdAt))
    .limit(100);
  const templateIds = rows.filter((r) => r.e.subjectType === "template").map((r) => r.e.subjectId);
  const ts = templateIds.length
    ? await getDb()
        .select({ id: templates.id, slug: templates.slug, title: templates.title, status: templates.status, creatorId: templates.creatorId })
        .from(templates)
        .where(inArray(templates.id, templateIds))
    : [];
  return rows
    .map((r) => ({
      id: r.e.id,
      subjectType: r.e.subjectType,
      subjectId: r.e.subjectId,
      reason: r.e.reason,
      note: typeof r.e.details.note === "string" ? r.e.details.note : "",
      reporter: r.reporter,
      createdAt: r.e.createdAt.toISOString(),
      severe: SEVERE.includes(r.e.reason),
      template: ts.find((t) => t.id === r.e.subjectId) ?? null,
    }))
    .sort((a, b) => Number(b.severe) - Number(a.severe));
}

export const resolveSchema = z.object({ action: z.enum(["remove", "dismiss"]), note: z.string().max(500).default("") });

/** Resolves a report. "remove" takes the template down (status removed) and closes every open report on it. */
export async function resolveReport(adminId: string, eventId: string, input: z.infer<typeof resolveSchema>) {
  await getDb().transaction(async (tx) => {
    const [e] = await tx.select().from(moderationEvents).where(eq(moderationEvents.id, eventId)).for("update");
    if (!e) throw notFound();
    if (e.status !== "open") throw new HttpError(409, "already_resolved", "Someone already resolved this.");
    const now = new Date();
    if (input.action === "remove") {
      if (e.subjectType === "template") {
        await tx.update(templates).set({ status: "removed", updatedAt: now }).where(eq(templates.id, e.subjectId));
      } else if (e.subjectType === "output") {
        const [o] = await tx.update(generationOutputs).set({ deletedAt: now }).where(eq(generationOutputs.id, e.subjectId)).returning();
        if (o) await tx.update(mediaAssets).set({ deletedAt: now }).where(eq(mediaAssets.id, o.assetId));
      } else {
        throw new HttpError(422, "unsupported", "Only templates and outputs can be removed from here.");
      }
      await tx
        .update(moderationEvents)
        .set({ status: "resolved", resolvedAt: now, actorId: adminId })
        .where(and(eq(moderationEvents.subjectType, e.subjectType), eq(moderationEvents.subjectId, e.subjectId), eq(moderationEvents.status, "open")));
    } else {
      await tx.update(moderationEvents).set({ status: "resolved", resolvedAt: now, actorId: adminId }).where(eq(moderationEvents.id, eventId));
    }
    await tx.insert(moderationEvents).values({
      subjectType: e.subjectType,
      subjectId: e.subjectId,
      action: input.action,
      status: "resolved",
      actorId: adminId,
      reason: e.reason,
      details: { reportId: e.id, note: input.note },
      resolvedAt: now,
    });
    await audit(adminId, `moderation.${input.action}`, e.subjectType, e.subjectId, { reportId: e.id, note: input.note }, tx);
  });
}

export async function modelsForAdmin() {
  const overrides = await getDb().select().from(modelConfigs);
  return (await listModelAvailability()).map((m) => ({
    key: m.key,
    name: m.displayName,
    output: m.output,
    provider: m.providerKey,
    isDemo: m.isDemo,
    available: m.available,
    reason: m.reason ?? null,
    priceMultiplierPct: m.priceMultiplierPct,
    enabled: overrides.find((o) => o.modelKey === m.key)?.enabled ?? true,
  }));
}

export const modelConfigSchema = z.object({ enabled: z.boolean().optional(), priceMultiplierPct: z.number().int().min(10).max(1000).optional() });

export async function setModelConfig(adminId: string, modelKey: string, input: z.infer<typeof modelConfigSchema>) {
  if (!MODELS.some((m) => m.key === modelKey)) throw notFound();
  const set = { ...(input.enabled !== undefined ? { enabled: input.enabled } : {}), ...(input.priceMultiplierPct !== undefined ? { priceMultiplier: input.priceMultiplierPct } : {}) };
  await getDb()
    .insert(modelConfigs)
    .values({ modelKey, ...set })
    .onConflictDoUpdate({ target: modelConfigs.modelKey, set: { ...set, updatedAt: new Date() } });
  await audit(adminId, "model.configure", "model", modelKey, input);
}

export const adjustSchema = z.object({
  account: z.string().trim().min(3).max(200),
  amount: z.number().int().min(-100_000).max(100_000).refine((n) => n !== 0, "Enter a non-zero amount."),
  reason: z.string().trim().min(3, "Say why.").max(200),
  idempotencyKey: z.string().min(8).max(100),
});

/** Adds or removes credits for an account found by email or handle. Retrying with the same key never applies twice. */
export async function adjustCredits(adminId: string, input: z.infer<typeof adjustSchema>) {
  const needle = input.account.replace(/^@/, "").toLowerCase();
  const [target] = await getDb()
    .select({ id: users.id, handle: userProfiles.handle })
    .from(users)
    .innerJoin(userProfiles, eq(userProfiles.userId, users.id))
    .where(and(or(sql`lower(${users.email}) = ${needle}`, sql`lower(${userProfiles.handle}) = ${needle}`), isNull(users.deletedAt)));
  if (!target) throw new HttpError(404, "not_found", "No account with that email or handle.");
  const result = await getDb().transaction(async (tx) => {
    const r = await applyMovement(tx, {
      userId: target.id,
      kind: "admin_adjust",
      availableDelta: input.amount,
      reservedDelta: 0,
      idempotencyKey: `admin:${adminId}:${input.idempotencyKey}`,
      note: input.reason,
    });
    if (r.applied) await audit(adminId, "credits.adjust", "user", target.id, { amount: input.amount, reason: input.reason }, tx);
    return r;
  });
  return { handle: target.handle, ...result };
}

export async function suspendUser(adminId: string, userId: string, reason: string) {
  const [u] = await getDb().update(users).set({ status: "suspended", updatedAt: new Date() }).where(and(eq(users.id, userId), eq(users.status, "active"))).returning({ id: users.id });
  if (!u) throw notFound();
  await destroyAllSessions(userId);
  await audit(adminId, "user.suspend", "user", userId, { reason });
}

export async function recentAudit(limit = 60) {
  const rows = await getDb()
    .select({ a: auditLogs, actor: userProfiles.handle })
    .from(auditLogs)
    .leftJoin(userProfiles, eq(userProfiles.userId, auditLogs.actorId))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.a.id,
    actor: r.actor,
    action: r.a.action,
    target: `${r.a.targetType}:${r.a.targetId.slice(0, 8)}`,
    metadata: r.a.metadata,
    createdAt: r.a.createdAt.toISOString(),
  }));
}
