import { isIPv4, isIPv6 } from "node:net";
import type { NextRequest } from "next/server";
import { env } from "@/server/env";

/**
 * The client's address, for rate limits. Every proxy appends the address it received from to
 * X-Forwarded-For, so the entries left of those our own proxies added are whatever the client chose to
 * send. Only the entry added by the outermost of the TRUSTED_PROXY_HOPS proxies is believed: the n-th
 * from the right. With 0 (no proxy) it is the connection's address, which Next.js writes into the
 * header only when the request arrives without one; that is also the right-most entry. An IPv6 client is
 * keyed by its /64 (see addressKey).
 */
export function clientIp(req: Pick<Request, "headers">): string {
  const chain = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!chain.length) return "local";
  // Fewer entries than proxies: the request skipped the outer ones, so the entry nearest the client is used.
  return addressKey(chain[Math.max(chain.length - Math.max(env().TRUSTED_PROXY_HOPS, 1), 0)]!);
}

/**
 * One key per client. A single IPv6 subscriber, phone or cloud VM is routed a whole /64 and can give every
 * request a new address in it, so IPv6 is keyed by that /64. An IPv4 client of a dual-stack listener shows
 * up as an IPv4-mapped address (::ffff:a.b.c.d) and keys as that IPv4 address. Some proxies write
 * "address:port" ("[address]:port" for IPv6); the port changes with every connection, so it is dropped.
 * Anything else is bounded.
 */
function addressKey(entry: string): string {
  const addr = /^\[([^\]]+)\](?::\d+)?$/.exec(entry)?.[1] ?? /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(entry)?.[1] ?? entry;
  if (isIPv4(addr)) return addr;
  if (!isIPv6(addr)) return entry.slice(0, 64);
  const words = ipv6Words(addr.split("%")[0]!);
  if (words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff) return [words[6]! >> 8, words[6]! & 0xff, words[7]! >> 8, words[7]! & 0xff].join(".");
  return `${words.slice(0, 4).map((w) => w.toString(16)).join(":")}::/64`;
}

/** The eight 16-bit words of a valid IPv6 address (net.isIPv6 checked it), expanding "::" and a dotted IPv4 tail. */
function ipv6Words(addr: string): number[] {
  const words = (part: string) =>
    (part ? part.split(":") : []).flatMap((w) => {
      if (!w.includes(".")) return [parseInt(w, 16)];
      const [a, b, c, d] = w.split(".").map(Number) as [number, number, number, number];
      return [(a << 8) | b, (c << 8) | d];
    });
  const [head, tail] = addr.split("::") as [string, string | undefined];
  if (tail === undefined) return words(head);
  const h = words(head);
  const t = words(tail);
  return [...h, ...Array<number>(8 - h.length - t.length).fill(0), ...t];
}

/** Country code from the edge/CDN header configured in GEO_COUNTRY_HEADER, if any. */
export function requestCountry(req: NextRequest): string | null {
  return req.headers.get(env().GEO_COUNTRY_HEADER)?.slice(0, 2).toUpperCase() ?? null;
}

/** Region / state code from the edge header configured in GEO_REGION_HEADER (e.g. "TX"), if any. */
export function requestRegion(req: NextRequest): string | null {
  const v = req.headers.get(env().GEO_REGION_HEADER)?.trim().toUpperCase().replace(/^US-/, "");
  return v && /^[A-Z0-9]{1,3}$/.test(v) ? v : null;
}
