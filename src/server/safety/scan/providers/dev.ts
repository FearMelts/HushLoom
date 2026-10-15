import { env, isLiveDeployment } from "@/server/env";
import type { ScanInput, ScanProvider, ScanVerdict } from "../types";

/**
 * The development scanner (addendum §3). It proves nothing about real content: it matches only
 * SHA-256 hashes listed in SCAN_DEV_MATCH_HASHES plus one built-in drill fixture, a harmless
 * striped test image at tests/fixtures/scan-drill-match.png, so the whole match path (block,
 * hold, suspend, escalate, review) can be exercised without a real hash list.
 *
 * It refuses to clear anything in production: env() refuses to boot production with this
 * scanner while SCAN_FAIL_CLOSED=true, and with fail-closed off every scan here returns
 * "unavailable" in production, which is never served.
 */
export const DEV_SCAN_FIXTURE_SHA256 = "74e83d5d64abef0cf31d79891bcf2000ded57690e2e320bbdee37d21a9f7a184";

type Forced = ScanVerdict["status"] | null | undefined;
let override: ((input: ScanInput) => Forced) | null = null;

/**
 * Test and drill hook: return "matched", "unavailable" or "clean" to force a verdict for an
 * input, or null to fall through to the hash list. Only the dev scanner consults it.
 */
export function setDevScanOverride(fn: ((input: ScanInput) => Forced) | null) {
  override = fn;
}

function matchList(): Set<string> {
  const listed = env()
    .SCAN_DEV_MATCH_HASHES.split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => /^[0-9a-f]{64}$/.test(h));
  return new Set([DEV_SCAN_FIXTURE_SHA256, ...listed]);
}

export const devScanProvider: ScanProvider = {
  key: "dev",
  label: "Development scanner (matches test hashes only)",
  isDev: true,
  capabilities: { hashMatch: true, classifier: false, video: true, preStorage: true },
  isConfigured: () => !isLiveDeployment(),

  async scan(input) {
    if (isLiveDeployment()) {
      return { status: "unavailable", provider: "dev", detail: "the development scanner refuses to run on a live site" };
    }
    const forced = override?.(input);
    if (forced === "unavailable" || (!forced && env().SCAN_DEV_SIMULATE_OUTAGE === "true")) {
      return { status: "unavailable", provider: "dev", detail: "simulated scanner outage (development drill)" };
    }
    if (forced === "matched") return { status: "matched", provider: "dev", category: "csam", ref: "dev-drill:forced", detail: "forced match (development drill)" };
    if (forced === "clean") return { status: "clean", provider: "dev", ref: "dev:forced-clean" };
    const list = matchList();
    const hit = [input.sha256, input.sourceSha256].find((h): h is string => Boolean(h && list.has(h.toLowerCase())));
    if (hit) return { status: "matched", provider: "dev", category: "csam", ref: `dev-hash:${hit.slice(0, 16)}`, detail: "hash on the development match list" };
    return { status: "clean", provider: "dev", ref: "dev:no-match" };
  },
};
