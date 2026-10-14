import { afterEach, describe, expect, it, vi } from "vitest";

async function clientIpWith(hops: string | undefined) {
  vi.resetModules();
  if (hops !== undefined) vi.stubEnv("TRUSTED_PROXY_HOPS", hops);
  return (await import("@/server/request")).clientIp;
}

const req = (xff?: string) => ({ headers: new Headers(xff === undefined ? {} : { "x-forwarded-for": xff }) });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("clientIp (R05)", () => {
  it("defaults to no proxy: the connection's address, which Next.js writes as the only entry", async () => {
    const clientIp = await clientIpWith(undefined);
    expect(clientIp(req("198.51.100.4"))).toBe("198.51.100.4");
    expect(clientIp(req())).toBe("local");
    expect(clientIp(req(" , "))).toBe("local");
  });

  it("never takes a client-sent left-most entry", async () => {
    const clientIp = await clientIpWith("1");
    expect(clientIp(req("6.6.6.6, 203.0.113.9"))).toBe("203.0.113.9");
    expect(clientIp(req("6.6.6.6,7.7.7.7 ,203.0.113.9"))).toBe("203.0.113.9");
  });

  it("with two proxies, uses the address the outer one saw and ignores both what the client sent and the outer proxy's own address", async () => {
    const clientIp = await clientIpWith("2");
    expect(clientIp(req("6.6.6.6, 203.0.113.9, 10.0.0.2"))).toBe("203.0.113.9");
    // A request that reached only the inner proxy: the one entry it added.
    expect(clientIp(req("203.0.113.9"))).toBe("203.0.113.9");
  });

  it("bounds the bucket key", async () => {
    const clientIp = await clientIpWith("0");
    expect(clientIp(req("x".repeat(500))).length).toBe(64);
  });
});
