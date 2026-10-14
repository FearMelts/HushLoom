import { DEFAULT_AGE_VERIFICATION_REGIONS, jurisdictionCode, jurisdictionRequiresVerification } from "@/config/jurisdictions";
import { env } from "@/server/env";

/**
 * Pure jurisdiction rules for age verification (addendum §2): which regions require a provider
 * check, how a request's geo headers become a jurisdiction code, and when a verification expires.
 * No database access here, so the gate, the pages and the tests can all share it.
 */
export type AgeContext = { country: string | null; region?: string | null };

type HeaderReader = { get(name: string): string | null };

/**
 * Regions that require a provider check: AGE_VERIFICATION_REGIONS when set, else the defaults in
 * src/config/jurisdictions.ts. The older AGE_ASSURANCE_STRICT_REGIONS list is folded in, since a
 * "strict" region is exactly one that needs more than self-declaration.
 */
export function configuredRegions(): string[] {
  const e = env();
  const base = e.AGE_VERIFICATION_REGIONS !== undefined ? e.AGE_VERIFICATION_REGIONS.split(",") : [...DEFAULT_AGE_VERIFICATION_REGIONS];
  return [...base, ...e.AGE_ASSURANCE_STRICT_REGIONS.split(",")].map((s) => s.trim().toUpperCase()).filter(Boolean);
}

/** Country values edges send when they do not know the location: Cloudflare's XX (unknown) and T1 (Tor), GeoIP's A1 (anonymous proxy) and A2 (satellite). */
const UNKNOWN_COUNTRIES = new Set(["XX", "T1", "A1", "A2"]);

/**
 * True when `code` does not say where the request is: an edge's unknown marker, or a bare country
 * whose rules are per region with no region given ("US" while "US-TX" is configured).
 */
function locationUnknown(code: string, regions: readonly string[]): boolean {
  const upper = code.toUpperCase();
  if (UNKNOWN_COUNTRIES.has(upper)) return true;
  return !upper.includes("-") && regions.some((r) => r.startsWith(`${upper}-`));
}

/** True when `code` ("GB", "US-TX", or null for unknown) requires a provider check under the current configuration. */
export function jurisdictionRequired(code: string | null): boolean {
  const e = env();
  if (e.AGE_VERIFICATION_ENFORCE !== "true") return false;
  const regions = configuredRegions();
  if (!regions.length) return false;
  if (code && jurisdictionRequiresVerification(code, regions)) return true;
  // Unknown location while rules exist (no header, an unknown marker, or "US" without a state): AGE_VERIFICATION_FAIL_CLOSED decides.
  if (!code || locationUnknown(code, regions)) return e.AGE_VERIFICATION_FAIL_CLOSED === "true";
  return false;
}

export function contextJurisdiction(ctx: AgeContext): string | null {
  return jurisdictionCode(ctx.country, ctx.region ?? null);
}

/** Country and region from the edge headers (GEO_COUNTRY_HEADER / GEO_REGION_HEADER), for pages that only have headers(). */
export function contextFromHeaders(h: HeaderReader): AgeContext {
  const country = h.get(env().GEO_COUNTRY_HEADER)?.slice(0, 2).toUpperCase() || null;
  const raw = h.get(env().GEO_REGION_HEADER)?.trim().toUpperCase().replace(/^US-/, "");
  const region = raw && /^[A-Z0-9]{1,3}$/.test(raw) ? raw : null;
  return { country, region };
}

/**
 * The jurisdiction to store on the account at signup or sign-in. Null (keep what was stored) when the
 * headers do not pin the location down, so an unknown marker or a stateless "US" never sticks.
 */
export function jurisdictionFromHeaders(h: HeaderReader): string | null {
  const code = contextJurisdiction(contextFromHeaders(h));
  return code && !locationUnknown(code, configuredRegions()) ? code : null;
}

/** A verification is good for AGE_VERIFICATION_VALID_DAYS after it completed; after that it reads as expired. */
export function expiryFor(verifiedAt: Date | null): Date | null {
  return verifiedAt ? new Date(verifiedAt.getTime() + env().AGE_VERIFICATION_VALID_DAYS * 86_400_000) : null;
}
