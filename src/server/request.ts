import type { NextRequest } from "next/server";
import { env } from "@/server/env";

/**
 * The client's address, for rate limits. Every proxy appends the address it received from to
 * X-Forwarded-For, so the entries left of those our own proxies added are whatever the client chose to
 * send. Only the entry added by the outermost of the TRUSTED_PROXY_HOPS proxies is believed: the n-th
 * from the right. With 0 (no proxy) it is the connection's address, which Next.js writes into the
 * header only when the request arrives without one; that is also the right-most entry.
 */
export function clientIp(req: Pick<Request, "headers">): string {
  const chain = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!chain.length) return "local";
  // Fewer entries than proxies: the request skipped the outer ones, so the entry nearest the client is used.
  return chain[Math.max(chain.length - Math.max(env().TRUSTED_PROXY_HOPS, 1), 0)]!.slice(0, 64);
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
