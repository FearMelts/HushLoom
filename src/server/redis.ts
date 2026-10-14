import IORedis from "ioredis";
import { env } from "@/server/env";
import { HttpError } from "@/server/http";
import { logger } from "@/server/log";

const g = globalThis as unknown as { hlRedis?: IORedis; hlRedisRequest?: IORedis };

/** Shared connection. BullMQ requires maxRetriesPerRequest: null. */
export function redis(): IORedis {
  g.hlRedis ??= new IORedis(env().REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
  return g.hlRedis;
}

/**
 * For commands a request waits on (rate limits, the health check). The BullMQ connection above keeps a
 * command queued until Redis is back, which would hold every such request open through an outage; here
 * a command fails after one reconnect attempt or two seconds instead.
 */
export function requestRedis(): IORedis {
  g.hlRedisRequest ??= new IORedis(env().REDIS_URL, { maxRetriesPerRequest: 1, commandTimeout: 2_000 });
  return g.hlRedisRequest;
}

export async function closeRedis() {
  for (const client of [g.hlRedis, g.hlRedisRequest]) {
    // QUIT waits for a connection that may never come back; drop it instead when Redis is unreachable.
    if (client?.status === "ready") await client.quit();
    else client?.disconnect();
  }
  g.hlRedis = undefined;
  g.hlRedisRequest = undefined;
}

/**
 * Fixed-window limiter. Returns false once `limit` hits occur within `windowS`. Fails closed: while
 * Redis is unreachable it answers 503 rather than letting attempts through unlimited.
 */
export async function rateLimit(bucket: string, limit: number, windowS: number): Promise<boolean> {
  const key = `rl:${bucket}`;
  try {
    const count = await requestRedis().incr(key);
    if (count === 1) await requestRedis().expire(key, windowS);
    return count <= limit;
  } catch (err) {
    // The bucket is not logged: it can hold an email address.
    logger.error("rate limiter unavailable", { err });
    throw new HttpError(503, "unavailable", "We can't take this right now. Try again in a minute.");
  }
}
