import type { NextRequest } from "next/server";
import { env } from "@/server/env";

/** Country code from the edge/CDN header configured in GEO_COUNTRY_HEADER, if any. */
export function requestCountry(req: NextRequest): string | null {
  return req.headers.get(env().GEO_COUNTRY_HEADER)?.slice(0, 2).toUpperCase() ?? null;
}

/** Region / state code from the edge header configured in GEO_REGION_HEADER (e.g. "TX"), if any. */
export function requestRegion(req: NextRequest): string | null {
  const v = req.headers.get(env().GEO_REGION_HEADER)?.trim().toUpperCase().replace(/^US-/, "");
  return v && /^[A-Z0-9]{1,3}$/.test(v) ? v : null;
}
