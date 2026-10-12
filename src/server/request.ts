import type { NextRequest } from "next/server";
import { env } from "@/server/env";

/** Country code from the edge/CDN header configured in GEO_COUNTRY_HEADER, if any. */
export function requestCountry(req: NextRequest): string | null {
  return req.headers.get(env().GEO_COUNTRY_HEADER)?.slice(0, 2).toUpperCase() ?? null;
}
