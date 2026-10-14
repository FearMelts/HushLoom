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
 *
 * The count and its expiry go in one transaction (EXPIRE NX, Redis 7), so no failure between two commands
 * can leave a counter without a TTL, which would answer 429 for good once past the limit. NX keeps the
 * running window's TTL, and gives one to any counter an earlier version of this function left without.
 */
export async function rateLimit(bucket: string, limit: number, windowS: number): Promise<boolean> {
  const key = `rl:${bucket}`;
  try {
    const [incr] = (await requestRedis().multi().incr(key).expire(key, windowS, "NX").exec()) ?? [];
    if (!incr || incr[0]) throw incr?.[0] ?? new Error("rate limit transaction discarded");
    return (incr[1] as number) <= limit;
  } catch (err) {
    // The bucket is not logged: it can hold an email address.
    logger.error("rate limiter unavailable", { err });
    throw new HttpError(503, "unavailable", "We can't take this right now. Try again in a minute.");
  }
}
