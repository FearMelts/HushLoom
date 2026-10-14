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

  it("keys an IPv6 client by its /64, the block one subscriber or VM is routed", async () => {
    const clientIp = await clientIpWith("1");
    expect(clientIp(req("2001:db8:42:7::1"))).toBe("2001:db8:42:7::/64");
    expect(clientIp(req("6.6.6.6, 2001:DB8:42:7:ffff:1:2:3"))).toBe("2001:db8:42:7::/64");
    expect(clientIp(req("2001:0db8:0042:0007:0000:0000:0000:0009"))).toBe("2001:db8:42:7::/64");
    expect(clientIp(req("2001:db8:42:8::1"))).toBe("2001:db8:42:8::/64");
    expect(clientIp(req("::1"))).toBe("0:0:0:0::/64");
    // IPv4 clients of a dual-stack listener appear as IPv4-mapped addresses: each is its own IPv4 address, not one shared /64.
    expect(clientIp(req("::ffff:203.0.113.9"))).toBe("203.0.113.9");
    expect(clientIp(req("::FFFF:cb00:7109"))).toBe("203.0.113.9");
    expect(clientIp(req("203.0.113.9"))).toBe("203.0.113.9");
  });

  it("drops the port and brackets a proxy may write, so each new connection's source port is not a new key", async () => {
    const clientIp = await clientIpWith("1");
    expect(clientIp(req("6.6.6.6, 203.0.113.30:40001"))).toBe("203.0.113.30");
    expect(clientIp(req("203.0.113.30:40002"))).toBe("203.0.113.30");
    expect(clientIp(req("[2001:db8:42:7::1]:443"))).toBe("2001:db8:42:7::/64");
    expect(clientIp(req("[2001:db8:42:7::2]"))).toBe("2001:db8:42:7::/64");
    expect(clientIp(req("[::ffff:203.0.113.30]:40003"))).toBe("203.0.113.30");
  });

  it("bounds the bucket key", async () => {
    const clientIp = await clientIpWith("0");
    expect(clientIp(req("x".repeat(500))).length).toBe(64);
  });
});
