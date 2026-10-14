import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { audit } from "@/server/audit";
import type { SessionUser } from "@/server/auth/session";
import { getDb, type Tx } from "@/server/db";
import { accountFlags, generationJobs, generationOutputs, mediaAssets, moderationEvents, takedownRequests, takenDownHashes, templates, userProfiles } from "@/server/db/schema";
import { env } from "@/server/env";
import { HttpError, notFound } from "@/server/http";
import { purgeAssetsNow } from "@/server/media";
import { suspendForAbuse } from "@/server/safety/suspend";

/**
 * Takedown requests (addendum §3): anyone, signed in or not, can ask for content to come down,
 * especially nonconsensual intimate imagery. Requests wait for a human in /admin/review; nothing
 * is removed automatically, so the form cannot be used to knock down someone else's work.
 */
export const TAKEDOWN_CATEGORIES = ["ncii", "csam", "likeness", "copyright", "other"] as const;
export type TakedownCategory = (typeof TAKEDOWN_CATEGORIES)[number];
type TargetType = "output" | "template" | "asset" | "url";

export const takedownSchema = z.object({
  category: z.enum(TAKEDOWN_CATEGORIES),
  target: z.string().trim().min(3, "Paste the link, or the id from the page.").max(500),
  email: z.string().trim().email("Enter a valid email.").max(200).optional().or(z.literal("").transform(() => undefined)),
  name: z.string().trim().max(120).default(""),
  details: z.string().trim().max(2000).default(""),
  goodFaith: z.literal(true, { errorMap: () => ({ message: "Confirm the statement to send the request." }) }),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Turns a pasted link or id into the kind of record it points at. Unknown things stay a URL for a human to look at. */
export async function resolveTarget(raw: string): Promise<{ targetType: TargetType; targetRef: string }> {
  const db = getDb();
  const ref = raw.trim();
  if (UUID.test(ref)) {
    const id = ref.toLowerCase();
    if ((await db.select({ id: generationJobs.id }).from(generationJobs).where(eq(generationJobs.id, id))).length) return { targetType: "output", targetRef: id };
    if ((await db.select({ id: generationOutputs.id }).from(generationOutputs).where(eq(generationOutputs.id, id))).length) return { targetType: "output", targetRef: id };
    if ((await db.select({ id: templates.id }).from(templates).where(eq(templates.id, id))).length) return { targetType: "template", targetRef: id };
    if ((await db.select({ id: mediaAssets.id }).from(mediaAssets).where(eq(mediaAssets.id, id))).length) return { targetType: "asset", targetRef: id };
    return { targetType: "url", targetRef: ref };
  }
  let url: URL;
  try {
    url = new URL(ref, env().APP_URL);
  } catch {
    return { targetType: "url", targetRef: ref };
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "templates" && parts[1]) return { targetType: "template", targetRef: decodeURIComponent(parts[1]) };
  if (parts[0] === "collection" && parts[1] && UUID.test(parts[1])) return { targetType: "output", targetRef: parts[1].toLowerCase() };
  if (parts[0] === "api" && parts[1] === "media") {
    const key = url.searchParams.get("k");
    const [a] = key ? await db.select({ id: mediaAssets.id }).from(mediaAssets).where(eq(mediaAssets.storageKey, key)) : [];
    if (a) return { targetType: "asset", targetRef: a.id };
  }
  return { targetType: "url", targetRef: ref };
}

export async function createTakedown(input: z.infer<typeof takedownSchema>, requester: SessionUser | null) {
  if (!requester && !input.email) throw new HttpError(422, "email_required", "Add an email so we can reach you about this.", { fieldErrors: { email: ["Add an email so we can reach you."] } });
  const target = await resolveTarget(input.target);
  const signature = input.name ? `\n\nSigned: ${input.name}. Good-faith statement confirmed.` : "\n\nGood-faith statement confirmed.";
  const [row] = await getDb()
    .insert(takedownRequests)
    .values({
      requesterId: requester?.id ?? null,
      requesterEmail: input.email ?? null,
      targetType: target.targetType,
      targetRef: target.targetRef.slice(0, 500),
      category: input.category,
      details: `${input.details}${signature}`.trim(),
    })
    .returning({ id: takedownRequests.id });
  // Ids and the category only: never the requester's email or their words.
  await audit(requester?.id ?? null, "takedown.create", "takedown", row!.id, { category: input.category, targetType: target.targetType });
  return { id: row!.id };
}

export type TakedownItem = {
  id: string;
  category: TakedownCategory;
  targetType: TargetType;
  targetRef: string;
  targetLabel: string | null;
  details: string;
  requester: string;
  status: "open" | "actioned" | "dismissed";
  resolutionNote: string;
  createdAt: string;
  resolvedAt: string | null;
};

const URGENT: TakedownCategory[] = ["csam", "ncii", "likeness"];
export const TAKEDOWN_PAGE = 100;

const statusFilter = (status: "open" | "closed") => (status === "open" ? eq(takedownRequests.status, "open") : sql`${takedownRequests.status} <> 'open'`);

/**
 * Open requests come most harmful first (CSAM, intimate images, likeness), then oldest first. The
 * order is applied in the query, before the page is cut, so no number of older low-priority
 * requests can push a new urgent one off the page. Closed requests come newest first.
 */
export async function listTakedowns(opts: { status: "open" | "closed"; limit?: number; offset?: number }): Promise<TakedownItem[]> {
  const db = getDb();
  const urgentFirst = sql`case when ${inArray(takedownRequests.category, URGENT)} then 0 else 1 end`;
  const rows = await db
    .select({ t: takedownRequests, handle: userProfiles.handle })
    .from(takedownRequests)
    .leftJoin(userProfiles, eq(userProfiles.userId, takedownRequests.requesterId))
    .where(statusFilter(opts.status))
    .orderBy(...(opts.status === "open" ? [urgentFirst, takedownRequests.createdAt, takedownRequests.id] : [desc(takedownRequests.resolvedAt), takedownRequests.id]))
    .limit(opts.limit ?? TAKEDOWN_PAGE)
    .offset(opts.offset ?? 0);
  const items = await Promise.all(
    rows.map(async ({ t, handle }) => {
      let targetLabel: string | null = null;
      if (t.targetType === "template") {
        const [tpl] = await db
          .select({ title: templates.title, status: templates.status })
          .from(templates)
          .where(UUID.test(t.targetRef) ? eq(templates.id, t.targetRef) : eq(templates.slug, t.targetRef));
        targetLabel = tpl ? `${tpl.title} (${tpl.status})` : null;
      }
      return {
        id: t.id,
        category: t.category,
        targetType: t.targetType,
        targetRef: t.targetRef,
        targetLabel,
        details: t.details,
        requester: handle ? `@${handle}` : (t.requesterEmail ?? "anonymous"),
        status: t.status,
        resolutionNote: t.resolutionNote,
        createdAt: t.createdAt.toISOString(),
        resolvedAt: t.resolvedAt?.toISOString() ?? null,
      };
    }),
  );
  return items;
}

/** How many requests are open (or closed), so the queue can say how many lie beyond the page. */
export async function countTakedowns(status: "open" | "closed"): Promise<number> {
  const [row] = await getDb().select({ n: sql<number>`count(*)::int` }).from(takedownRequests).where(statusFilter(status));
  return row?.n ?? 0;
}

export const takedownActionSchema = z.object({ action: z.enum(["action", "dismiss"]), note: z.string().trim().max(500).default("") });

/**
 * "Action" soft-deletes what the request points at (an output with its creation, a template with
 * its public media, or one asset) and every other copy of the same creation (takeDownCopies).
 * NCII and likeness requests purge the files right away, as a consent withdrawal does. A CSAM
 * request puts the files on legal hold instead, opens an escalation per file, and flags and
 * suspends the owner, exactly as a scanner match does, so the reporting step runs through the
 * same review queue and the owner cannot publish the material again meanwhile.
 */
export async function resolveTakedown(adminId: string, takedownId: string, input: z.infer<typeof takedownActionSchema>) {
  if (input.action === "dismiss" && input.note.length < 3) throw new HttpError(422, "note_required", "Add a short note on why this is dismissed.");
  const purge: string[] = [];
  await getDb().transaction(async (tx) => {
    const [t] = await tx.select().from(takedownRequests).where(eq(takedownRequests.id, takedownId)).for("update");
    if (!t) throw notFound();
    if (t.status !== "open") throw new HttpError(409, "already_resolved", "Someone already resolved this.");
    const now = new Date();
    if (input.action === "dismiss") {
      await tx.update(takedownRequests).set({ status: "dismissed", resolutionNote: input.note, resolvedBy: adminId, resolvedAt: now }).where(eq(takedownRequests.id, t.id));
      await audit(adminId, "takedown.dismiss", "takedown", t.id, { category: t.category, note: input.note }, tx);
      return;
    }

    const target = t.targetType === "url" ? await resolveTarget(t.targetRef) : { targetType: t.targetType, targetRef: t.targetRef };
    const assetIds: string[] = [];
    let removed: string | null = null;
    if (target.targetType === "output") {
      const outs = await tx
        .select()
        .from(generationOutputs)
        .where(or(eq(generationOutputs.jobId, target.targetRef), eq(generationOutputs.id, target.targetRef)));
      const jobIds = [...new Set(outs.map((o) => o.jobId))];
      if (!outs.length && !(await tx.select({ id: generationJobs.id }).from(generationJobs).where(eq(generationJobs.id, target.targetRef))).length) throw unresolved();
      assetIds.push(...outs.flatMap((o) => (o.posterAssetId ? [o.assetId, o.posterAssetId] : [o.assetId])));
      if (outs.length) await tx.update(generationOutputs).set({ deletedAt: now }).where(inArray(generationOutputs.id, outs.map((o) => o.id)));
      await tx.update(generationJobs).set({ deletedAt: now }).where(inArray(generationJobs.id, jobIds.length ? jobIds : [target.targetRef]));
      removed = "output";
    } else if (target.targetType === "template") {
      const [tpl] = await tx
        .select()
        .from(templates)
        .where(UUID.test(target.targetRef) ? eq(templates.id, target.targetRef) : eq(templates.slug, target.targetRef));
      if (!tpl) throw unresolved();
      await tx.update(templates).set({ status: "removed", deletedAt: now, updatedAt: now }).where(eq(templates.id, tpl.id));
      assetIds.push(...[tpl.posterAssetId, tpl.previewAssetId].filter((x): x is string => Boolean(x)));
      removed = "template";
    } else if (target.targetType === "asset") {
      const [a] = await tx.select({ id: mediaAssets.id }).from(mediaAssets).where(eq(mediaAssets.id, target.targetRef));
      if (!a) throw unresolved();
      assetIds.push(a.id);
      await tx.update(templates).set({ status: "removed", updatedAt: now }).where(or(eq(templates.posterAssetId, a.id), eq(templates.previewAssetId, a.id)));
      await tx.update(generationOutputs).set({ deletedAt: now }).where(eq(generationOutputs.assetId, a.id));
      removed = "asset";
    } else {
      throw unresolved();
    }
    assetIds.push(...(await takeDownCopies(tx, assetIds, now)));

    if (assetIds.length) {
      // The bytes stay down: publishing the same file again, however it is made, is refused (isTakenDownOrHeld).
      const hashes = await tx.selectDistinct({ sha256: mediaAssets.sha256 }).from(mediaAssets).where(inArray(mediaAssets.id, assetIds));
      await tx.insert(takenDownHashes).values(hashes.map((h) => ({ sha256: h.sha256, takedownId: t.id }))).onConflictDoNothing();
      if (t.category === "csam") {
        // Evidence: hidden at once, never purged, and sent to the review queue for the report.
        await tx.update(mediaAssets).set({ deletedAt: now, legalHold: true }).where(inArray(mediaAssets.id, assetIds));
        const held = await tx.select().from(mediaAssets).where(inArray(mediaAssets.id, assetIds));
        for (const a of held) {
          const [event] = await tx
            .insert(moderationEvents)
            .values({
              subjectType: a.storageKey.startsWith("uploads/") ? "upload" : "output",
              subjectId: a.id,
              action: "escalate",
              status: "open",
              reason: "csam_report",
              details: { assetId: a.id, sha256: a.sha256, provider: "takedown", ref: t.id, origin: "takedown", ownerId: a.ownerId, storageKey: a.storageKey },
            })
            .returning({ id: moderationEvents.id });
          if (!a.ownerId) continue;
          // The owner takes the same path as after a scanner match: a flag per case, suspended until review.
          await tx.insert(accountFlags).values({
            userId: a.ownerId,
            kind: "csam_match",
            reason: "A CSAM takedown request was actioned. Held for human review.",
            details: { assetId: a.id, escalationId: event!.id, provider: "takedown", ref: t.id, origin: "takedown" },
            createdBy: adminId,
          });
          await suspendForAbuse(tx, a.ownerId, { reason: "takedown_csam", assetId: a.id, escalationId: event!.id, takedownId: t.id }, adminId);
        }
      } else {
        await tx.update(mediaAssets).set({ deletedAt: now }).where(and(inArray(mediaAssets.id, assetIds), eq(mediaAssets.legalHold, false), isNull(mediaAssets.deletedAt)));
        if (t.category === "ncii" || t.category === "likeness") purge.push(...assetIds);
      }
    }
    await tx.update(takedownRequests).set({ status: "actioned", resolutionNote: input.note, resolvedBy: adminId, resolvedAt: now }).where(eq(takedownRequests.id, t.id));
    await audit(adminId, "takedown.action", "takedown", t.id, { category: t.category, removed, targetRef: target.targetRef, assets: assetIds.length, note: input.note }, tx);
  });
  // Purge skips anything on legal hold.
  if (purge.length) await purgeAssetsNow(purge);
}

/**
 * Publishing copies an output's bytes into new public assets, so what a request names is rarely the
 * only copy. Taking down just that one would leave the creator's source creation, which they could
 * publish again under a new slug at once, and any other template made from it. The copies are all
 * assets with the same SHA-256, whoever owns them: a byte-identical file is the same image, and a
 * second account can make it with the same prompt and seed. Their creations are soft-deleted and
 * their templates removed. Returns the asset ids not already in `assetIds`, to be held or deleted
 * with them.
 */
async function takeDownCopies(tx: Tx, assetIds: string[], now: Date): Promise<string[]> {
  if (!assetIds.length) return [];
  const named = await tx.selectDistinct({ sha256: mediaAssets.sha256 }).from(mediaAssets).where(inArray(mediaAssets.id, assetIds));
  if (!named.length) return [];
  const rows = await tx.select({ id: mediaAssets.id }).from(mediaAssets).where(inArray(mediaAssets.sha256, named.map((n) => n.sha256)));
  const same = new Set(rows.map((r) => r.id));
  if (!same.size) return [];
  const ids = [...same];
  const outs = await tx
    .select()
    .from(generationOutputs)
    .where(or(inArray(generationOutputs.assetId, ids), inArray(generationOutputs.posterAssetId, ids)));
  if (outs.length) {
    await tx.update(generationOutputs).set({ deletedAt: now }).where(and(inArray(generationOutputs.id, outs.map((o) => o.id)), isNull(generationOutputs.deletedAt)));
    await tx.update(generationJobs).set({ deletedAt: now }).where(and(inArray(generationJobs.id, [...new Set(outs.map((o) => o.jobId))]), isNull(generationJobs.deletedAt)));
  }
  const tpls = await tx
    .update(templates)
    .set({ status: "removed", deletedAt: now, updatedAt: now })
    .where(and(or(inArray(templates.posterAssetId, ids), inArray(templates.previewAssetId, ids)), isNull(templates.deletedAt)))
    .returning({ posterAssetId: templates.posterAssetId, previewAssetId: templates.previewAssetId });
  for (const o of outs) [o.assetId, o.posterAssetId].forEach((id) => id && same.add(id));
  for (const p of tpls) [p.posterAssetId, p.previewAssetId].forEach((id) => id && same.add(id));
  return [...same].filter((id) => !assetIds.includes(id));
}

/**
 * Whether any of these files was taken down or is held as evidence, by its bytes: an actioned
 * takedown records the SHA-256 of everything it removed, and a scanner match holds the file
 * itself. A byte-identical copy is the same content, whoever made it and however.
 */
export async function isTakenDownOrHeld(db: Pick<Tx, "select">, sha256s: string[]): Promise<boolean> {
  if (!sha256s.length) return false;
  const [listed] = await db.select({ sha256: takenDownHashes.sha256 }).from(takenDownHashes).where(inArray(takenDownHashes.sha256, sha256s)).limit(1);
  if (listed) return true;
  const [held] = await db
    .select({ id: mediaAssets.id })
    .from(mediaAssets)
    .where(and(inArray(mediaAssets.sha256, sha256s), eq(mediaAssets.legalHold, true)))
    .limit(1);
  return Boolean(held);
}

function unresolved() {
  return new HttpError(422, "target_not_found", "Couldn't find what this request points at. Remove it by hand, then dismiss the request with a note.");
}
