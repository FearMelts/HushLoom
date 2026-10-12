/**
 * Abuse-scanning adapters (addendum §3): hash matching against known child sexual abuse
 * material (PhotoDNA, or Cloudflare's scanner at the edge) plus a classifier slot.
 * Every upload and every generated output is scanned before it is stored for display.
 * "dev" is a labeled development scanner that only matches the hashes in SCAN_DEV_MATCH_HASHES.
 */
export type ScanInput = { bytes: Buffer; mime: string; kind: "image" | "video"; sha256: string };

export type ScanVerdict =
  | { status: "clean"; provider: string; ref?: string }
  | { status: "matched"; provider: string; ref?: string; category: "csam" | "abuse"; detail?: string }
  | { status: "unavailable"; provider: string; detail: string };

export interface ScanProvider {
  readonly key: "dev" | "photodna" | "cloudflare";
  readonly isDev: boolean;
  readonly capabilities: { hashMatch: boolean; classifier: boolean; video: boolean };
  isConfigured(): boolean;
  scan(input: ScanInput): Promise<ScanVerdict>;
}
