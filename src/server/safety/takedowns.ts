import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { audit } from "@/server/audit";
import type { SessionUser } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { generationJobs, generationOutputs, mediaAssets, moderationEvents, takedownRequests, templates, userProfiles } from "@/server/db/schema";
import { env } from "@/server/env";
import { HttpError, notFound } from "@/server/http";
import { purgeAssetsNow } from "@/server/media";

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
  if (parts[0] === "templates" && parts[1]) {
    try {
      return { targetType: "template", targetRef: decodeURIComponent(parts[1]) };
    } catch {
      // A broken percent-escape (/templates/%zz): a human still sees the link as it was pasted.
      return { targetType: "url", targetRef: ref };
    }
  }
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

export async function listTakedowns(opts: { status: "open" | "closed"; limit?: number }): Promise<TakedownItem[]> {
  const db = getDb();
  const rows = await db
    .select({ t: takedownRequests, handle: userProfiles.handle })
    .from(takedownRequests)
    .leftJoin(userProfiles, eq(userProfiles.userId, takedownRequests.requesterId))
    .where(opts.status === "open" ? eq(takedownRequests.status, "open") : sql`${takedownRequests.status} <> 'open'`)
    .orderBy(opts.status === "open" ? takedownRequests.createdAt : desc(takedownRequests.resolvedAt))
    .limit(opts.limit ?? 100);
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
  // The most harmful categories first; within each, oldest first.
  return opts.status === "open" ? items.sort((a, b) => Number(URGENT.includes(b.category)) - Number(URGENT.includes(a.category))) : items;
}

export const takedownActionSchema = z.object({ action: z.enum(["action", "dismiss"]), note: z.string().trim().max(500).default("") });

/**
 * "Action" soft-deletes what the request points at (an output with its creation, a template with
 * its public media, or one asset). NCII and likeness requests purge the files right away, as a
 * consent withdrawal does. A CSAM request puts the files on legal hold instead and opens an
 * escalation, so the reporting step runs through the same review queue as a scanner match.
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

    if (assetIds.length) {
      if (t.category === "csam") {
        // Evidence: hidden at once, never purged, and sent to the review queue for the report.
        await tx.update(mediaAssets).set({ deletedAt: now, legalHold: true }).where(inArray(mediaAssets.id, assetIds));
        const held = await tx.select().from(mediaAssets).where(inArray(mediaAssets.id, assetIds));
        for (const a of held) {
          await tx.insert(moderationEvents).values({
            subjectType: a.storageKey.startsWith("uploads/") ? "upload" : "output",
            subjectId: a.id,
            action: "escalate",
            status: "open",
            reason: "csam_report",
            details: { assetId: a.id, sha256: a.sha256, provider: "takedown", ref: t.id, origin: "takedown", ownerId: a.ownerId, storageKey: a.storageKey },
          });
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

function unresolved() {
  return new HttpError(422, "target_not_found", "Couldn't find what this request points at. Remove it by hand, then dismiss the request with a note.");
}
