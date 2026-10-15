import { env } from "@/server/env";
import { sandboxProvider } from "./providers/sandbox";
import { yotiProvider } from "./providers/yoti";
import { configuredRegions } from "./rules";
import type { AgeVerificationProvider } from "./types";

/** The active age-verification provider, chosen by AGE_VERIFICATION_PROVIDER. */
export function ageVerificationProvider(): AgeVerificationProvider {
  switch (env().AGE_VERIFICATION_PROVIDER) {
    case "yoti":
      return yotiProvider;
    default:
      return sandboxProvider;
  }
}

export type AgeVerificationStatus = {
  provider: AgeVerificationProvider["key"];
  label: string;
  sandbox: boolean;
  configured: boolean;
  enforce: boolean;
  failClosed: boolean;
  regions: string[];
  validDays: number;
  methods: string[];
};

/** What the UI, the health page and the verification report say about age verification. Holds no secrets. */
export function ageVerificationStatus(): AgeVerificationStatus {
  const p = ageVerificationProvider();
  const e = env();
  return {
    provider: p.key,
    label: p.label,
    sandbox: p.isSandbox,
    configured: p.isConfigured(),
    enforce: e.AGE_VERIFICATION_ENFORCE === "true",
    failClosed: e.AGE_VERIFICATION_FAIL_CLOSED === "true",
    regions: configuredRegions(),
    validDays: e.AGE_VERIFICATION_VALID_DAYS,
    methods: [...p.methods],
  };
}
