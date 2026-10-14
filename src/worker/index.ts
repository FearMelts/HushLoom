import { createServer } from "node:http";
import { Worker } from "bullmq";
import { closeDb } from "@/server/db";
import { env } from "@/server/env";
import { GENERATION_QUEUE, type GenerationQueueData } from "@/server/generation/queue";
import { processJob, reconcile } from "@/server/generation/processor";
import { purgeDeletedMedia } from "@/server/media";
import { logger } from "@/server/log";
import { installErrorWebhook } from "@/server/observability";
import { closeRedis, redis } from "@/server/redis";

const concurrency = env().WORKER_CONCURRENCY;
// Errors also go to ERROR_WEBHOOK_URL when it is set (src/server/observability.ts).
installErrorWebhook("worker");

const worker = new Worker<GenerationQueueData>(
  GENERATION_QUEUE,
  async (job) => {
    await processJob(job.data.jobId);
  },
  { connection: redis(), concurrency },
);

worker.on("failed", (job, err) => logger.error("queue job crashed", { jobId: job?.data.jobId, err }));

async function sweep() {
  try {
    const r = await reconcile();
    if (r.requeued || r.failed) logger.info("reconciled", r);
  } catch (err) {
    logger.error("reconcile failed", { err });
  }
}

async function purge() {
  try {
    const n = await purgeDeletedMedia(30);
    if (n) logger.info("purged deleted media", { count: n });
  } catch (err) {
    logger.error("purge failed", { err });
  }
}

void sweep();
const sweepTimer = setInterval(sweep, 60_000);
const purgeTimer = setInterval(purge, 3_600_000);
logger.info("worker started", { concurrency });

// Optional liveness endpoint for orchestrators (and the e2e runner) to see the worker is up.
const healthPort = env().WORKER_HEALTH_PORT;
const health = healthPort
  ? createServer((req, res) => {
      const ok = req.url === "/health" && worker.isRunning();
      res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" }).end(JSON.stringify({ ok }));
    }).listen(healthPort)
  : null;

async function shutdown(signal: string) {
  logger.info("worker stopping", { signal });
  clearInterval(sweepTimer);
  clearInterval(purgeTimer);
  health?.close();
  await worker.close();
  await closeRedis();
  await closeDb();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
