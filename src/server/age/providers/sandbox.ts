import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { env } from "@/server/env";
import { CallbackRejected, type AgeVerificationProvider } from "../types";

/**
 * The sandbox age-verification provider (addendum §2). It sends the user to an internal page
 * that says, in large type, that it is a sandbox and proves nothing, with "Simulate verified"
 * and "Simulate failed" buttons. The page posts to the normal callback route with an HMAC over
 * the body, so the whole flow (start → callback → signature check → replay rejection → status)
 * runs end to end without a real provider. It refuses to run in production; env() also refuses
 * to boot production with this provider while enforcement is on.
 */
export const SANDBOX_SIGNATURE_HEADER = "x-hushloom-sandbox-signature";

export const sandboxCallbackSchema = z.object({
  providerRef: z.string().min(8).max(80),
  outcome: z.enum(["verified", "failed"]),
  method: z.literal("sandbox"),
  issuedAt: z.string().datetime(),
});

export type SandboxCallback = z.infer<typeof sandboxCallbackSchema>;

/** Dev/test secret for the sandbox callback; never a real provider's secret. */
export function sandboxSigningSecret(): string {
  return env().AGE_VERIFICATION_WEBHOOK_SECRET ?? "dev-only-age-sandbox-secret-not-for-production";
}

export function signSandboxBody(body: string): string {
  return createHmac("sha256", sandboxSigningSecret()).update(body).digest("hex");
}

/** A pre-signed callback body for the sandbox page to deliver when a button is pressed. */
export function sandboxCallback(providerRef: string, outcome: SandboxCallback["outcome"]): { body: string; signature: string } {
  const body = JSON.stringify({ providerRef, outcome, method: "sandbox", issuedAt: new Date().toISOString() } satisfies SandboxCallback);
  return { body, signature: signSandboxBody(body) };
}

function refuseInProduction() {
  if (env().NODE_ENV === "production") throw new Error("The sandbox age-verification provider cannot run in production");
}

export const sandboxProvider: AgeVerificationProvider = {
  key: "sandbox",
  label: "Sandbox check (proves nothing)",
  isSandbox: true,
  methods: ["sandbox"],
  isConfigured: () => env().NODE_ENV !== "production",

  async start() {
    refuseInProduction();
    const providerRef = `sbx_${randomBytes(12).toString("base64url")}`;
    const url = new URL("/verify/sandbox", env().APP_URL);
    url.searchParams.set("ref", providerRef);
    return { url: url.toString(), providerRef, method: "sandbox" };
  },

  async verifyCallback({ rawBody, headers }) {
    refuseInProduction();
    const given = headers.get(SANDBOX_SIGNATURE_HEADER);
    if (!given) throw new CallbackRejected("unsigned", "The sandbox callback carried no signature.");
    const expected = Buffer.from(signSandboxBody(rawBody), "utf8");
    const actual = Buffer.from(given, "utf8");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new CallbackRejected("bad_signature", "The sandbox signature does not match the body.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new CallbackRejected("malformed", "The sandbox callback body must be JSON.");
    }
    const body = sandboxCallbackSchema.safeParse(parsed);
    if (!body.success) throw new CallbackRejected("malformed", "The sandbox callback body is incomplete.");
    return {
      providerRef: body.data.providerRef,
      outcome: body.data.outcome,
      method: "sandbox",
      failureReason: body.data.outcome === "failed" ? "sandbox_simulated_failure" : undefined,
    };
  },
};
