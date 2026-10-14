/**
 * The whole content of a Hushloom push notification (addendum §4). It is built from the outcome and
 * the job id only, so a prompt, template, model, media or anything else private cannot reach a lock
 * screen or the push service: the function never sees them.
 */
export type PushOutcome = "completed" | "failed" | "cancelled";

export type PushPayload = { title: "Hushloom"; body: string; url: string; tag: string };

export const PUSH_BODY: Record<PushOutcome, string> = {
  completed: "Your creation is ready",
  failed: "A creation didn't finish",
  cancelled: "A creation was cancelled",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildPushPayload(outcome: PushOutcome, jobId: string): PushPayload {
  if (!UUID.test(jobId)) throw new Error("buildPushPayload expects a job id");
  return { title: "Hushloom", body: PUSH_BODY[outcome], url: `/collection/${jobId}`, tag: `job-${jobId}` };
}
