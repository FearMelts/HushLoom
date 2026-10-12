/**
 * Jurisdictions where a provider-backed age check is required before a user may
 * generate, upload or view explicit content (addendum §2, 2026-10-12).
 *
 * Sources checked by the project on 12 October 2026:
 * - UK: Ofcom requires "highly effective age assurance" for services that allow users to generate
 *   or upload pornographic content, in force since 25 July 2025.
 *   https://www.ofcom.org.uk/online-safety/protecting-children/enforcement-programme-to-protect-children-from-encountering-pornographic-content-through-the-use-of-age-assurance
 * - US: the Supreme Court upheld Texas's law in 2025; the Free Speech Coalition tracker lists the
 *   states with similar laws (27 at the time of writing). https://www.freespeechcoalition.com/faq
 *
 * The state list below was compiled from that tracker; it is configuration, not legal advice.
 * The operator must re-check it before launch and can override it with AGE_VERIFICATION_REGIONS
 * (comma-separated codes such as "GB,US-TX,US-FL"). A bare "US" would cover every state.
 */
export const DEFAULT_AGE_VERIFICATION_REGIONS: readonly string[] = [
  "GB",
  "US-AL",
  "US-AR",
  "US-AZ",
  "US-FL",
  "US-GA",
  "US-ID",
  "US-IN",
  "US-KS",
  "US-KY",
  "US-LA",
  "US-MO",
  "US-MS",
  "US-MT",
  "US-NC",
  "US-ND",
  "US-NE",
  "US-OH",
  "US-OK",
  "US-SC",
  "US-SD",
  "US-TN",
  "US-TX",
  "US-UT",
  "US-VA",
  "US-WY",
];

/** Builds the "GB" / "US-TX" code the rules use from the edge headers. */
export function jurisdictionCode(country: string | null, region: string | null): string | null {
  if (!country) return null;
  const c = country.toUpperCase();
  const r = region?.toUpperCase().replace(/^US-/, "");
  return c === "US" && r ? `US-${r}` : c;
}

/** True when `code` ("US-TX", "GB") falls under one of the configured regions ("US-TX", "US", "GB"). */
export function jurisdictionRequiresVerification(code: string | null, regions: readonly string[]): boolean {
  if (!code) return false;
  const upper = code.toUpperCase();
  const country = upper.split("-")[0]!;
  return regions.some((r) => {
    const rr = r.trim().toUpperCase();
    return rr === upper || rr === country;
  });
}
