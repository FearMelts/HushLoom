import { Queue } from "bullmq";
import { redis } from "@/server/redis";

export const GENERATION_QUEUE = "generation";

export type GenerationQueueData = { jobId: string; attempt: number };

const g = globalThis as unknown as { hlQueue?: Queue<GenerationQueueData> };

export function generationQueue(): Queue<GenerationQueueData> {
  g.hlQueue ??= new Queue<GenerationQueueData>(GENERATION_QUEUE, {
    connection: redis(),
    defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 5000, attempts: 1 },
  });
  return g.hlQueue;
}

/**
 * The queue entry id includes the attempt number, so re-enqueueing the same
 * attempt is a no-op while a retry gets a fresh entry.
 */
export async function enqueueGeneration(jobId: string, delayMs: number, attempt: number) {
  await generationQueue().add("run", { jobId, attempt }, { jobId: `${jobId}-a${attempt}`, delay: delayMs });
}
