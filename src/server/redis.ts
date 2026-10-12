import IORedis from "ioredis";
import { env } from "@/server/env";

const g = globalThis as unknown as { hlRedis?: IORedis };

/** Shared connection. BullMQ requires maxRetriesPerRequest: null. */
export function redis(): IORedis {
  g.hlRedis ??= new IORedis(env().REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
  return g.hlRedis;
}

export async function closeRedis() {
  await g.hlRedis?.quit();
  g.hlRedis = undefined;
}

/** Fixed-window limiter. Returns false once `limit` hits occur within `windowS`. */
export async function rateLimit(bucket: string, limit: number, windowS: number): Promise<boolean> {
  const key = `rl:${bucket}`;
  const count = await redis().incr(key);
  if (count === 1) await redis().expire(key, windowS);
  return count <= limit;
}
