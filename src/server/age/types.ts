/**
 * Age-verification providers sit behind this adapter (addendum §2). The platform's own
 * age gate and date-of-birth attestation are step one; a provider check is required in
 * the jurisdictions listed in src/config/jurisdictions.ts. "sandbox" is a labeled
 * development provider and never marks a real user verified from a real-world result.
 */
export type VerificationStart = { url: string; providerRef: string; method?: string };

export type VerificationResult = { providerRef: string; outcome: "verified" | "failed" | "pending"; method?: string; failureReason?: string };

export interface AgeVerificationProvider {
  readonly key: "sandbox" | "yoti" | "veriff";
  readonly isSandbox: boolean;
  /** Methods this provider offers that meet the UK "highly effective" bar (e.g. document, facial age estimation). */
  readonly methods: readonly string[];
  isConfigured(): boolean;
  start(input: { userId: string; returnUrl: string; jurisdiction: string | null }): Promise<VerificationStart>;
  /** Verifies the callback signature and normalizes the result; throws on unsigned or replayed callbacks. */
  verifyCallback(input: { rawBody: string; headers: Headers; url: URL }): Promise<VerificationResult>;
}
