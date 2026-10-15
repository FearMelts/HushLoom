/**
 * Abuse-scanning adapters (addendum §3): hash matching against known child sexual abuse
 * material (PhotoDNA, or Cloudflare's scanner at the edge) plus a classifier slot.
 * Every upload and every generated output is scanned before it can be shown, used or published.
 * "dev" is a labeled development scanner that only matches the hashes in SCAN_DEV_MATCH_HASHES
 * and one built-in drill fixture (tests/fixtures/scan-drill-match.png).
 */
export type ScanInput = {
  bytes: Buffer;
  mime: string;
  kind: "image" | "video";
  sha256: string;
  /** SHA-256 of the file exactly as it was received, before we re-encoded it (uploads only). */
  sourceSha256?: string;
};

export type ScanVerdict =
  | { status: "clean"; provider: string; ref?: string }
  | { status: "matched"; provider: string; ref?: string; category: "csam" | "abuse"; detail?: string }
  | { status: "unavailable"; provider: string; detail: string };

export interface ScanProvider {
  readonly key: "dev" | "photodna" | "cloudflare";
  /** Shown to operators on the review page; never shown to members. */
  readonly label: string;
  readonly isDev: boolean;
  /**
   * hashMatch: matches known material. classifier: flags unknown material (slot, none yet).
   * video: scans a whole video file itself (otherwise the pipeline sends keyframes).
   * preStorage: can clear a file before we keep or show it (false for an edge-only layer).
   */
  readonly capabilities: { hashMatch: boolean; classifier: boolean; video: boolean; preStorage: boolean };
  isConfigured(): boolean;
  scan(input: ScanInput): Promise<ScanVerdict>;
}
