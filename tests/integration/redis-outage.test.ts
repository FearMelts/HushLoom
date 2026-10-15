import { NextRequest } from "next/server";
import { afterAll, describe, expect, it, vi } from "vitest";

// Redis is unreachable for this whole file: nothing listens on port 1.
vi.hoisted(() => {
  vi.stubEnv("REDIS_URL", "redis://127.0.0.1:1");
});

import { GET as health } from "@/app/api/health/route";
import { POST as loginRoute } from "@/app/api/auth/login/route";
import { closeDb } from "@/server/db";
import { closeRedis } from "@/server/redis";

afterAll(async () => {
  await closeRedis();
  await closeDb();
  vi.unstubAllEnvs();
});

/** The response, or "hung" when there is none within 8 seconds. */
async function within<T>(p: Promise<T>): Promise<T | "hung"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<"hung">((resolve) => (timer = setTimeout(() => resolve("hung"), 8_000)));
  try {
    return await Promise.race([p, hung]);
  } finally {
    clearTimeout(timer);
  }
}

describe("R30 Redis outage", () => {
  it("a rate-limited route answers instead of waiting for Redis to come back", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const req = new NextRequest("http://localhost/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "someone@example.test", password: "a guess" }),
      headers: { "content-type": "application/json" },
    });
    const res = await within(loginRoute(req, undefined as never));
    expect(res).not.toBe("hung");
    // Fails closed: no attempt is let through unlimited.
    expect((res as Response).status).toBe(503);
    expect(((await (res as Response).json()) as { error: { code: string } }).error.code).toBe("unavailable");
  });

  it("the health check reports Redis down", async () => {
    const res = await within(health());
    expect(res).not.toBe("hung");
    expect((res as Response).status).toBe(503);
    expect(await (res as Response).json()).toMatchObject({ ok: false, checks: { redis: "down" } });
  });
});
