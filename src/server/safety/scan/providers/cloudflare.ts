import { env } from "@/server/env";
import type { ScanProvider } from "../types";

/**
 * Cloudflare's CSAM Scanning Tool, modeled honestly as an edge layer (addendum §3).
 *
 * The tool is switched on in the Cloudflare dashboard (Caching > Configuration > CSAM Scanning
 * Tool). It compares images Cloudflare serves from its cache against known-CSAM lists, tries to
 * block a match at the edge, and emails the account owner once a day; the owner still has to
 * report. It has no API or webhook, and it never sees a file before we store it
 * (developers.cloudflare.com/cache/reference/csam-scanning/, blog.cloudflare.com/the-csam-scanning-tool/).
 *
 * So this adapter cannot clear anything before storage:
 * - SCAN_FAIL_CLOSED=true (the default): every scan is "unavailable", so nothing is kept or shown.
 *   Production needs SCAN_PROVIDER=photodna for pre-storage scanning, with Cloudflare's tool on
 *   as a second layer.
 * - SCAN_FAIL_CLOSED=false: the asset is recorded clean with provider "cloudflare-edge" and ref
 *   "edge-only:not-pre-scanned", which says plainly that no pre-storage check happened. This is
 *   weaker: only content Cloudflare caches is ever scanned, and this build marks all media
 *   "Cache-Control: private", so as shipped the edge sees nothing (docs/abuse-response.md).
 */
export const cloudflareEdgeProvider: ScanProvider = {
  key: "cloudflare",
  label: "Cloudflare CSAM Scanning Tool (edge only, no pre-storage scan)",
  isDev: false,
  capabilities: { hashMatch: true, classifier: false, video: false, preStorage: false },
  isConfigured: () => env().SCAN_FAIL_CLOSED === "false",

  async scan() {
    if (env().SCAN_FAIL_CLOSED === "true") {
      return {
        status: "unavailable",
        provider: "cloudflare",
        detail:
          "Cloudflare's CSAM Scanning Tool only scans content as Cloudflare serves it and has no pre-storage API. Configure SCAN_PROVIDER=photodna, or set SCAN_FAIL_CLOSED=false to rely on the edge alone (weaker).",
      };
    }
    return { status: "clean", provider: "cloudflare-edge", ref: "edge-only:not-pre-scanned" };
  },
};
