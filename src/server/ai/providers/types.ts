import type { GenerationParams } from "@/server/db/schema";
import type { GenerationMode, ModelSpec } from "@/server/ai/registry";

/**
 * One media input for a request. `source` (the default) is media the result is made from: an upload,
 * or the clip being continued. `reference` is a consented character reference photo from Train,
 * sent only for modes that take one; an adapter that cannot use it must fail with "unsupported"
 * rather than ignore it.
 */
export type ProviderInput = { kind: "image" | "video"; mime: string; bytes: Buffer; width?: number | null; height?: number | null; role?: "source" | "reference" };

export type ProviderRequest = {
  jobId: string;
  model: ModelSpec;
  mode: GenerationMode;
  prompt: string;
  negativePrompt: string;
  params: GenerationParams;
  inputs: ProviderInput[];
};

export type ProviderOutput = { mime: string; bytes: Buffer; width?: number; height?: number; durationMs?: number };

export type ProviderErrorCode =
  | "timeout"
  | "rate_limited"
  | "provider_unavailable"
  | "invalid_input"
  | "content_rejected"
  | "unsupported"
  | "cancelled"
  | "internal"
  /** Our own abuse scanner blocked the output (addendum §3); nothing was kept for display. */
  | "content_blocked"
  /** Our abuse scanner could not check the output, so it was not kept (fail closed). */
  | "scan_unavailable";

/** Every provider failure is normalized to this shape before it reaches the job record. */
export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

export type ExecuteContext = {
  signal: AbortSignal;
  /** Persist the provider's id as soon as it exists so a crashed worker can be reconciled. */
  onProviderJobId: (id: string) => Promise<void>;
};

export interface ProviderAdapter {
  readonly key: string;
  /** Demo adapters never call an AI model; their outputs are labeled as such everywhere. */
  readonly isDemo: boolean;
  isConfigured(): boolean;
  execute(req: ProviderRequest, ctx: ExecuteContext): Promise<ProviderOutput[]>;
}

export const USER_FACING_ERRORS: Record<ProviderErrorCode, string> = {
  timeout: "The model took too long to respond. Your credits were returned.",
  rate_limited: "The model is busy right now. Try again in a few minutes; your credits were returned.",
  provider_unavailable: "The model is unavailable right now. Your credits were returned.",
  invalid_input: "The model could not use these inputs. Check the upload and settings; your credits were returned.",
  content_rejected: "The model's own safety filter declined this request. Your credits were returned.",
  unsupported: "This model does not support that operation. Your credits were returned.",
  cancelled: "Cancelled. Your credits were returned.",
  internal: "Something failed on our side. Your credits were returned.",
  content_blocked: "This creation was blocked by our safety checks. Your credits were returned.",
  scan_unavailable: "Our safety check couldn't run, so nothing was saved. Try again in a few minutes; your credits were returned.",
};
