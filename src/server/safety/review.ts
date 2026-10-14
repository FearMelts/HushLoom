import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { audit } from "@/server/audit";
import { getDb } from "@/server/db";
import { accountFlags, mediaAssets, moderationEvents, userProfiles, users } from "@/server/db/schema";
import { HttpError, notFound } from "@/server/http";

/**
 * The human review queue for abuse-scan matches (addendum §3). A match opens a moderation event
 * with action "escalate"; an admin either confirms it and records the report reference (the
 * evidence stays on legal hold, the account stays suspended) or clears it as a false positive
 * (the asset becomes servable, the hold lifts, the flag clears and the account is reinstated
 * when no other abuse flag is open). The queue never shows the matched media itself.
 */
export type Escalation = {
  id: string;
  subjectType: string;
  reason: string;
  status: "open" | "resolved";
  createdAt: string;
  resolvedAt: string | null;
  asset: { id: string; kind: string; mime: string; bytes: number; sha256: string; scanStatus: string; legalHold: boolean; storageKey: string; createdAt: string } | null;
  provider: string | null;
  ref: string | null;
  origin: string | null;
  jobId: string | null;
  owner: { id: string; handle: string | null; email: string; status: string } | null;
  resolution: { kind: string; reportRef: string | null; reportedTo: string | null; note: string; by: string | null } | null;
};

const str = (v: unknown) => (typeof v === "string" ? v : null);

async function hydrate(rows: (typeof moderationEvents.$inferSelect)[]): Promise<Escalation[]> {
  const db = getDb();
  return Promise.all(
    rows.map(async (e) => {
      const d = e.details;
      const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, e.subjectId));
      const ownerId = str(d.ownerId) ?? asset?.ownerId ?? null;
      const [owner] = ownerId
        ? await db
            .select({ id: users.id, email: users.email, status: users.status, handle: userProfiles.handle })
            .from(users)
            .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
            .where(eq(users.id, ownerId))
        : [];
      const [actor] = e.actorId ? await db.select({ handle: userProfiles.handle }).from(userProfiles).where(eq(userProfiles.userId, e.actorId)) : [];
      return {
        id: e.id,
        subjectType: e.subjectType,
        reason: e.reason,
        status: e.status,
        createdAt: e.createdAt.toISOString(),
        resolvedAt: e.resolvedAt?.toISOString() ?? null,
        asset: asset
          ? {
              id: asset.id,
              kind: asset.kind,
              mime: asset.mime,
              bytes: asset.bytes,
              sha256: asset.sha256,
              scanStatus: asset.scanStatus,
              legalHold: asset.legalHold,
              storageKey: asset.storageKey,
              createdAt: asset.createdAt.toISOString(),
            }
          : null,
        provider: str(d.provider),
        ref: str(d.ref),
        origin: str(d.origin),
        jobId: str(d.jobId),
        owner: owner ? { id: owner.id, handle: owner.handle, email: owner.email, status: owner.status } : null,
        resolution: e.status === "resolved" ? { kind: str(d.resolution) ?? "resolved", reportRef: str(d.reportRef), reportedTo: str(d.reportedTo), note: str(d.resolutionNote) ?? "", by: actor?.handle ?? null } : null,
      };
    }),
  );
}

export async function listEscalations(opts: { status: "open" | "resolved"; limit?: number }) {
  const rows = await getDb()
    .select()
    .from(moderationEvents)
    .where(and(eq(moderationEvents.action, "escalate"), eq(moderationEvents.status, opts.status)))
    .orderBy(opts.status === "open" ? moderationEvents.createdAt : desc(moderationEvents.resolvedAt))
    .limit(opts.limit ?? 100);
  return hydrate(rows);
}

export const reviewActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("confirm"),
    reportRef: z.string().trim().min(3, "Enter the report reference.").max(120),
    reportedTo: z.enum(["ncmec_cybertipline", "iwf", "other_authority"]),
    note: z.string().trim().max(500).default(""),
  }),
  z.object({ action: z.literal("clear"), note: z.string().trim().min(3, "Say why this is a false positive.").max(500) }),
]);

export async function resolveEscalation(adminId: string, eventId: string, input: z.infer<typeof reviewActionSchema>) {
  await getDb().transaction(async (tx) => {
    const [e] = await tx.select().from(moderationEvents).where(eq(moderationEvents.id, eventId)).for("update");
    if (!e || e.action !== "escalate") throw notFound();
    if (e.status !== "open") throw new HttpError(409, "already_resolved", "Someone already resolved this.");
    const now = new Date();
    const assetId = e.subjectId;

    if (input.action === "confirm") {
      // The evidence stays on hold and the account stays suspended; the report reference is the record.
      await tx.update(mediaAssets).set({ legalHold: true }).where(eq(mediaAssets.id, assetId));
      await tx
        .update(moderationEvents)
        .set({
          status: "resolved",
          resolvedAt: now,
          actorId: adminId,
          details: sql`${moderationEvents.details} || ${JSON.stringify({ resolution: "confirmed", reportRef: input.reportRef, reportedTo: input.reportedTo, resolutionNote: input.note })}::jsonb`,
        })
        .where(eq(moderationEvents.id, e.id));
      await tx
        .update(accountFlags)
        .set({ details: sql`${accountFlags.details} || ${JSON.stringify({ reportRef: input.reportRef, reportedTo: input.reportedTo })}::jsonb` })
        .where(sql`${accountFlags.details}->>'escalationId' = ${e.id}`);
      await tx.insert(moderationEvents).values({
        subjectType: e.subjectType,
        subjectId: assetId,
        action: "hold",
        status: "resolved",
        actorId: adminId,
        reason: e.reason,
        details: { escalationId: e.id, reportRef: input.reportRef, reportedTo: input.reportedTo, note: input.note },
        resolvedAt: now,
      });
      await audit(adminId, "scan.match_confirmed", "media_asset", assetId, { escalationId: e.id, reportRef: input.reportRef, reportedTo: input.reportedTo }, tx);
      return;
    }

    // False positive: the asset is cleared and servable again, the hold lifts, the flag clears.
    await tx
      .update(mediaAssets)
      .set({ scanStatus: "clean", legalHold: false, scanRef: `review-cleared:${e.id}`, scannedAt: now })
      .where(eq(mediaAssets.id, assetId));
    await tx
      .update(moderationEvents)
      .set({ status: "resolved", resolvedAt: now, actorId: adminId, details: sql`${moderationEvents.details} || ${JSON.stringify({ resolution: "false_positive", resolutionNote: input.note })}::jsonb` })
      .where(eq(moderationEvents.id, e.id));
    await tx.insert(moderationEvents).values({
      subjectType: e.subjectType,
      subjectId: assetId,
      action: "approve",
      status: "resolved",
      actorId: adminId,
      reason: "false_positive",
      details: { escalationId: e.id, note: input.note },
      resolvedAt: now,
    });
    const cleared = await tx
      .update(accountFlags)
      .set({ clearedAt: now, clearedBy: adminId, details: sql`${accountFlags.details} || ${JSON.stringify({ clearNote: input.note })}::jsonb` })
      .where(and(sql`${accountFlags.details}->>'escalationId' = ${e.id}`, isNull(accountFlags.clearedAt)))
      .returning({ userId: accountFlags.userId });
    await audit(adminId, "scan.false_positive_cleared", "media_asset", assetId, { escalationId: e.id, note: input.note }, tx);
    const ownerId = cleared[0]?.userId ?? (typeof e.details.ownerId === "string" ? e.details.ownerId : null);
    if (!ownerId) return;
    const [stillFlagged] = await tx
      .select({ id: accountFlags.id })
      .from(accountFlags)
      .where(and(eq(accountFlags.userId, ownerId), eq(accountFlags.kind, "csam_match"), isNull(accountFlags.clearedAt)))
      .limit(1);
    if (stillFlagged) return;
    const [reinstated] = await tx
      .update(users)
      .set({ status: "active", updatedAt: now })
      .where(and(eq(users.id, ownerId), eq(users.status, "suspended"), isNull(users.deletedAt)))
      .returning({ id: users.id });
    if (reinstated) await audit(adminId, "user.reinstate", "user", ownerId, { reason: "scan_false_positive", escalationId: e.id }, tx);
  });
}
