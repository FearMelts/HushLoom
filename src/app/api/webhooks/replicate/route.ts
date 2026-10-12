import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { verifyReplicateWebhook } from "@/server/ai/providers/replicate";
import { getDb } from "@/server/db";
import { generationJobs } from "@/server/db/schema";
import { env } from "@/server/env";
import { HttpError, route } from "@/server/http";
import { logger } from "@/server/log";

/**
 * Replicate can call this when a prediction changes state. The worker already polls each
 * prediction to completion, so the webhook only records that the provider reported in;
 * it never changes job state or credits on its own.
 */
export const POST = route(async (req) => {
  const secret = env().REPLICATE_WEBHOOK_SECRET;
  if (!secret) throw new HttpError(503, "webhook_unconfigured", "Webhook secret not configured.");
  const body = await req.text();
  const ok = verifyReplicateWebhook(
    { id: req.headers.get("webhook-id"), timestamp: req.headers.get("webhook-timestamp"), signature: req.headers.get("webhook-signature") },
    body,
    secret,
  );
  if (!ok) throw new HttpError(400, "bad_signature", "Invalid signature.");
  let prediction: { id?: unknown; status?: unknown };
  try {
    prediction = JSON.parse(body) as { id?: unknown; status?: unknown };
  } catch {
    throw new HttpError(400, "invalid_json", "Body must be JSON.");
  }
  const [job] = typeof prediction.id === "string"
    ? await getDb().select({ id: generationJobs.id, status: generationJobs.status }).from(generationJobs).where(eq(generationJobs.providerJobId, prediction.id))
    : [];
  logger.info("replicate webhook", { prediction: prediction.id, providerStatus: prediction.status, jobId: job?.id, jobStatus: job?.status });
  return NextResponse.json({ received: true });
});
