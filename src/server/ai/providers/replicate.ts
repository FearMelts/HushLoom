import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/server/env";
import { ProviderError, type ExecuteContext, type ProviderAdapter, type ProviderInput, type ProviderOutput, type ProviderRequest } from "./types";

/**
 * Replicate HTTP adapter (https://replicate.com/docs/reference/http).
 * Status: implemented against the documented predictions API, not exercised
 * against the live service in this build because no token was available.
 */

const API = "https://api.replicate.com/v1";

type Prediction = {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: unknown;
  error?: string | null;
};

type InputBuilder = {
  /**
   * The model's own input field for a character reference image, when its schema has one. Without
   * it, a request that carries a reference fails as "unsupported" before anything is sent, so a
   * reference is never silently dropped.
   */
  referenceField?: string;
  build: (req: ProviderRequest) => Record<string, unknown>;
};

/** Per-model input mapping. Each provider model has its own schema; add one entry per enabled model. */
const INPUT_BUILDERS: Record<string, InputBuilder> = {
  // Text-to-image only: its schema has no image or reference input.
  "black-forest-labs/flux-schnell": {
    build: (req) => ({
      prompt: req.prompt,
      aspect_ratio: req.params.aspectRatio ?? "1:1",
      num_outputs: 1,
      output_format: "webp",
      ...(req.params.seed !== undefined ? { seed: req.params.seed } : {}),
    }),
  },
};

/**
 * A file input as a data URI, which Replicate's HTTP API accepts for small files (larger ones go
 * through its files API). Written from the public docs; never exercised against the live service,
 * and no model registered today declares a reference field.
 */
function dataUri(input: ProviderInput): string {
  return `data:${input.mime};base64,${input.bytes.toString("base64")}`;
}

/** The prediction input for a request, or "unsupported" when the model cannot take the reference it carries. Exported for tests. */
export function buildReplicateInput(req: ProviderRequest): Record<string, unknown> {
  const builder = INPUT_BUILDERS[req.model.providerModel];
  if (!builder) throw new ProviderError("unsupported", `no input mapping for ${req.model.providerModel}`, false);
  const input = builder.build(req);
  const reference = req.inputs.find((i) => i.role === "reference");
  if (reference) {
    if (!builder.referenceField) throw new ProviderError("unsupported", `${req.model.providerModel} takes no reference image`, false);
    input[builder.referenceField] = dataUri(reference);
  }
  return input;
}

function normalizeHttpError(status: number, body: string): ProviderError {
  if (status === 401 || status === 403) return new ProviderError("provider_unavailable", `replicate auth failed (${status})`, false);
  if (status === 404) return new ProviderError("unsupported", "replicate model not found", false);
  if (status === 422) return new ProviderError("invalid_input", `replicate rejected input: ${body.slice(0, 300)}`, false);
  if (status === 429) return new ProviderError("rate_limited", "replicate rate limited", true);
  if (status >= 500) return new ProviderError("provider_unavailable", `replicate ${status}`, true);
  return new ProviderError("internal", `replicate ${status}: ${body.slice(0, 300)}`, false);
}

async function call(path: string, init: RequestInit, signal: AbortSignal): Promise<Prediction> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      ...init,
      signal,
      headers: { Authorization: `Bearer ${env().REPLICATE_API_TOKEN}`, "Content-Type": "application/json", ...init.headers },
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new ProviderError("timeout", "replicate request aborted", true);
    throw new ProviderError("provider_unavailable", `replicate network error: ${(e as Error).message}`, true);
  }
  const text = await res.text();
  if (!res.ok) throw normalizeHttpError(res.status, text);
  return JSON.parse(text) as Prediction;
}

function outputUrls(output: unknown): string[] {
  if (typeof output === "string") return [output];
  if (Array.isArray(output)) return output.filter((o): o is string => typeof o === "string");
  return [];
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new ProviderError("timeout", "aborted while waiting", true));
    }, { once: true });
  });

export const replicateProvider: ProviderAdapter = {
  key: "replicate",
  isDemo: false,
  isConfigured: () => Boolean(env().REPLICATE_API_TOKEN),

  async execute(req: ProviderRequest, ctx: ExecuteContext): Promise<ProviderOutput[]> {
    const input = buildReplicateInput(req);
    let prediction = await call(
      `/models/${req.model.providerModel}/predictions`,
      { method: "POST", body: JSON.stringify({ input }) },
      ctx.signal,
    );
    await ctx.onProviderJobId(prediction.id);

    let delay = 1000;
    try {
      while (prediction.status === "starting" || prediction.status === "processing") {
        await sleep(delay, ctx.signal);
        delay = Math.min(delay * 1.5, 8000);
        prediction = await call(`/predictions/${prediction.id}`, { method: "GET" }, ctx.signal);
      }
    } catch (e) {
      // Best effort: stop billing at the provider when we give up.
      await fetch(`${API}/predictions/${prediction.id}/cancel`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env().REPLICATE_API_TOKEN}` },
      }).catch(() => undefined);
      throw e;
    }

    if (prediction.status === "canceled") throw new ProviderError("cancelled", "cancelled at provider", false);
    if (prediction.status === "failed") {
      const msg = prediction.error ?? "unknown failure";
      const nsfw = /nsfw|safety|content/i.test(msg);
      throw new ProviderError(nsfw ? "content_rejected" : "internal", `replicate: ${msg}`, false);
    }

    const urls = outputUrls(prediction.output);
    if (urls.length === 0) throw new ProviderError("internal", "replicate returned no output", false);
    const outputs: ProviderOutput[] = [];
    for (const url of urls) {
      const res = await fetch(url, { signal: ctx.signal });
      if (!res.ok) throw new ProviderError("provider_unavailable", `output download failed (${res.status})`, true);
      outputs.push({ mime: res.headers.get("content-type") ?? "application/octet-stream", bytes: Buffer.from(await res.arrayBuffer()) });
    }
    return outputs;
  },
};

/**
 * Verifies a Replicate webhook (Standard Webhooks scheme): HMAC-SHA256 over
 * "id.timestamp.body" with the base64 secret after the "whsec_" prefix.
 */
export function verifyReplicateWebhook(
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  body: string,
  secret: string,
  nowS = Math.floor(Date.now() / 1000),
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowS - ts) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();
  return signature.split(" ").some((part) => {
    const [, sig] = part.split(",");
    if (!sig) return false;
    const given = Buffer.from(sig, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
