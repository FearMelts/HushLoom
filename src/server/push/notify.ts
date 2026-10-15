import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/server/db";
import { pushSubscriptions, userPreferences } from "@/server/db/schema";
import { logger } from "@/server/log";
import { vapidConfig, type VapidConfig } from "./index";
import { buildPushPayload, type PushOutcome } from "./payload";
import { webPushSender, type PushSender, type PushSendResult } from "./sender";
import { deliverableSubscriptions } from "./subscriptions";

export type NotifyResult = {
  sent: number;
  pruned: number;
  failed: number;
  skipped?: "push_disabled" | "preference_off" | "no_subscriptions" | "error";
};

export type NotifyOptions = {
  /** Replaces the web-push sender (tests). */
  sender?: PushSender;
  /** Replaces the deployment's VAPID config; null means push is off. */
  vapid?: VapidConfig | null;
};

/**
 * Sends the opt-in "finished" notification (addendum §4) to every signed-in device of the user.
 * The payload is built from the outcome and job id only (see ./payload.ts). Subscriptions the push
 * service reports gone (404/410) are deleted; other failures are marked with failedAt and kept for
 * the next attempt. Called fire-and-forget by the generation processor, so it never throws: every
 * failure is logged and swallowed.
 */
export async function notifyJobFinished(input: { userId: string; jobId: string; outcome: PushOutcome }, options: NotifyOptions = {}): Promise<NotifyResult> {
  const result: NotifyResult = { sent: 0, pruned: 0, failed: 0 };
  try {
    const vapid = options.vapid !== undefined ? options.vapid : vapidConfig();
    if (!vapid) return { ...result, skipped: "push_disabled" };

    const db = getDb();
    const [prefs] = await db.select({ notifyOnFinish: userPreferences.notifyOnFinish }).from(userPreferences).where(eq(userPreferences.userId, input.userId));
    if (!prefs?.notifyOnFinish) return { ...result, skipped: "preference_off" };

    const targets = await deliverableSubscriptions(input.userId);
    if (!targets.length) return { ...result, skipped: "no_subscriptions" };

    const payload = JSON.stringify(buildPushPayload(input.outcome, input.jobId));
    const send = options.sender ?? webPushSender;
    const outcomes = await Promise.all(
      targets.map(async (t) => ({ id: t.id, res: await send(t, payload, vapid).catch((): PushSendResult => ({ ok: false, statusCode: null, gone: false })) })),
    );

    const now = new Date();
    const delivered = outcomes.filter((o) => o.res.ok).map((o) => o.id);
    const gone = outcomes.filter((o) => !o.res.ok && o.res.gone).map((o) => o.id);
    const failing = outcomes.filter((o) => !o.res.ok && !o.res.gone).map((o) => o.id);
    if (delivered.length) await db.update(pushSubscriptions).set({ lastUsedAt: now, failedAt: null }).where(inArray(pushSubscriptions.id, delivered));
    if (failing.length) await db.update(pushSubscriptions).set({ failedAt: now }).where(inArray(pushSubscriptions.id, failing));
    if (gone.length) await db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, gone));

    Object.assign(result, { sent: delivered.length, pruned: gone.length, failed: failing.length });
    // Ids and counts only: endpoints are capability URLs and stay out of logs.
    logger.info("push.job_finished", { jobId: input.jobId, outcome: input.outcome, ...result });
    return result;
  } catch (err) {
    logger.error("push.notify_failed", { jobId: input.jobId, outcome: input.outcome, err: err instanceof Error ? err.message : String(err) });
    return { ...result, skipped: "error" };
  }
}
