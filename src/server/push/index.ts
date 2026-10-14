import { env, type Env } from "@/server/env";

/**
 * Web Push configuration (addendum §4). Push is opt-in per user and needs a VAPID key pair; without
 * one it is off and says so, and nothing pretends to deliver. Generate keys once per deployment with
 * `npx web-push generate-vapid-keys` and keep them in the secret store, never in the repo.
 * The sender that talks to push services is in ./sender.ts, so the app's routes never load web-push.
 */
export type VapidConfig = { publicKey: string; privateKey: string; subject: string };

/** not_configured: no VAPID variables; incomplete: some missing; invalid_keys / invalid_subject: set but unusable. */
export type PushDisabledReason = "not_configured" | "incomplete" | "invalid_keys" | "invalid_subject";

export type PushStatus = { enabled: true; reason: null; publicKey: string } | { enabled: false; reason: PushDisabledReason; publicKey: null };

type VapidEnv = Pick<Env, "VAPID_PUBLIC_KEY" | "VAPID_PRIVATE_KEY" | "VAPID_SUBJECT">;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Length in bytes of a base64url string, or -1 when it is not base64url. */
export function base64UrlBytes(value: string): number {
  return BASE64URL.test(value) ? Buffer.from(value, "base64url").length : -1;
}

/** Reads the VAPID variables. Keys must be a P-256 pair (65-byte public, 32-byte private); the subject a mailto: or https: contact. */
export function vapidFrom(source: VapidEnv): { config: VapidConfig } | { reason: PushDisabledReason } {
  const publicKey = source.VAPID_PUBLIC_KEY?.trim() ?? "";
  const privateKey = source.VAPID_PRIVATE_KEY?.trim() ?? "";
  const subject = source.VAPID_SUBJECT?.trim() ?? "";
  if (!publicKey && !privateKey && !subject) return { reason: "not_configured" };
  if (!publicKey || !privateKey || !subject) return { reason: "incomplete" };
  if (base64UrlBytes(publicKey) !== 65 || base64UrlBytes(privateKey) !== 32) return { reason: "invalid_keys" };
  if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s/]+\S*)$/.test(subject)) return { reason: "invalid_subject" };
  return { config: { publicKey, privateKey, subject } };
}

/** The deployment's VAPID config, or null when push is off. */
export function vapidConfig(source: VapidEnv = env()): VapidConfig | null {
  const result = vapidFrom(source);
  return "config" in result ? result.config : null;
}

export function pushStatus(source: VapidEnv = env()): PushStatus {
  const result = vapidFrom(source);
  if ("reason" in result) return { enabled: false, reason: result.reason, publicKey: null };
  return { enabled: true, reason: null, publicKey: result.config.publicKey };
}
