/**
 * Age-verification providers sit behind this adapter (addendum §2). The platform's own
 * age gate and date-of-birth attestation are step one; a provider check is required in
 * the jurisdictions listed in src/config/jurisdictions.ts. "sandbox" is a labeled
 * development provider and never marks a real user verified from a real-world result.
 */
export type AgeVerificationProviderKey = "sandbox" | "yoti";

export type VerificationStart = { url: string; providerRef: string; method?: string };

export type VerificationResult = { providerRef: string; outcome: "verified" | "failed" | "pending"; method?: string; failureReason?: string };

export class CallbackRejected extends Error {
  constructor(
    public readonly reason: "unsigned" | "bad_signature" | "malformed" | "unconfigured",
    message: string,
  ) {
    super(message);
  }
}

export interface AgeVerificationProvider {
  readonly key: AgeVerificationProviderKey;
  /** Shown next to the status in Settings and the verification report. */
  readonly label: string;
  readonly isSandbox: boolean;
  /** Methods this provider offers that meet the UK "highly effective" bar (e.g. document, facial age estimation). */
  readonly methods: readonly string[];
  isConfigured(): boolean;
  /** Opens a check for one of our age_verifications rows and returns where to send the user. */
  start(input: { userId: string; verificationId: string; returnUrl: string; jurisdiction: string | null }): Promise<VerificationStart>;
  /** Verifies the callback signature and normalizes the result; throws CallbackRejected on unsigned or malformed callbacks. */
  verifyCallback(input: { rawBody: string; headers: Headers; url: URL }): Promise<VerificationResult>;
  /** Pulls the current outcome from the provider's API (for providers that report synchronously). */
  fetchResult?(providerRef: string): Promise<VerificationResult>;
}
