import { constants, createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";
import { z } from "zod";
import { env } from "@/server/env";
import { logger } from "@/server/log";
import { CallbackRejected, type AgeVerificationProvider, type VerificationResult } from "../types";

/**
 * Yoti Age Verification Service adapter (addendum §2).
 *
 * UNVERIFIED against the live service: no Yoti account or credentials exist for this build, so
 * everything below follows the public documentation as read on 2026-10-12 and has not been
 * exercised. What it relies on:
 *
 * - Create session: POST {AGE_VERIFICATION_API_URL}/api/v1/sessions with headers
 *   "Authorization: Bearer <API key>", "Yoti-SDK-Id: <SDK ID>", "Content-Type: application/json".
 *   Body fields used: type ("OVER"), ttl (seconds), reference_id, callback { url, auto },
 *   cancel_url, notification_url (https only), synchronous_checks, and the method objects
 *   age_estimation / doc_scan / digital_id { allowed, threshold, level, authenticity }.
 *   Response: { id, expires_at, status }. (https://developers.yoti.com/age-verification/create-a-session)
 * - Hosted page: https://age.yoti.com?sessionId=<id>&sdkId=<SDK ID>; on success Yoti redirects the
 *   user to callback.url with sessionId appended. (https://developers.yoti.com/age-verification/launch-the-user-view)
 * - Result: GET {API_URL}/api/v1/sessions/<id>/result, same headers. "status" is one of PENDING,
 *   IN_PROGRESS, PROCESSING, COMPLETE, FAIL, ERROR, CANCELLED, EXPIRED (more may be added);
 *   "method" names the method the user completed. (https://developers.yoti.com/age-verification/results)
 * - Notifications: POST JSON to notification_url with method, state (COMPLETE | FAIL | ERROR),
 *   session_key, reference_id, id, timestamp, evidence_id, sequence_number and signature. The
 *   signature is RSA-PSS with SHA-256 over the payload minus sequence_number and signature,
 *   serialized with all whitespace removed, salt length = signature bytes - 32 - 2, checked against
 *   Yoti's published Age Verification public key. (https://developers.yoti.com/age-verification/notifications)
 *
 * Methods enabled are the ones that meet the UK "highly effective" bar: facial age estimation,
 * identity document scan with liveness and authenticity checks, and Digital ID. The adapter never
 * requests, receives or stores the evidence (photos, documents, biometrics); Yoti keeps those on
 * its side and returns only the outcome, which is all we persist.
 */

/** Over-18 is the legal threshold; the estimation threshold carries a buffer so borderline faces go to a document check instead. */
const LEGAL_THRESHOLD = 18;
const ESTIMATION_THRESHOLD = 25;
const SESSION_TTL_S = 30 * 60;
const REQUEST_TIMEOUT_MS = 15_000;

const createdSession = z.object({ id: z.string().min(1), expires_at: z.string().optional(), status: z.string().optional() });

const sessionResult = z.object({ id: z.string().optional(), status: z.string(), method: z.string().optional(), reference_id: z.string().optional() });

const notification = z
  .object({
    session_key: z.string().min(1),
    state: z.string().optional(),
    method: z.string().optional(),
    reference_id: z.string().optional(),
    signature: z.string().min(1),
  })
  .passthrough();

function credentials() {
  const e = env();
  if (!e.AGE_VERIFICATION_API_KEY || !e.AGE_VERIFICATION_SDK_ID) throw new Error("Yoti age verification needs AGE_VERIFICATION_API_KEY and AGE_VERIFICATION_SDK_ID");
  return { apiKey: e.AGE_VERIFICATION_API_KEY, sdkId: e.AGE_VERIFICATION_SDK_ID, base: e.AGE_VERIFICATION_API_URL.replace(/\/$/, "") };
}

async function yotiRequest(path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<unknown> {
  const { apiKey, sdkId, base } = credentials();
  const res = await fetch(`${base}${path}`, {
    method: init.method,
    headers: { Authorization: `Bearer ${apiKey}`, "Yoti-SDK-Id": sdkId, "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    // Yoti's error body carries error_code and context; nothing personal, so it is safe to log.
    const text = (await res.text().catch(() => "")).slice(0, 300);
    logger.warn("yoti request failed", { path, status: res.status, body: text });
    throw new Error(`Yoti ${init.method} ${path} returned ${res.status}`);
  }
  return res.json();
}

/** Normalizes Yoti's session status to our three outcomes. Unknown states stay pending, which grants nothing. */
export function mapYotiStatus(status: string, method?: string): Omit<VerificationResult, "providerRef"> {
  const m = method?.toLowerCase();
  switch (status.toUpperCase()) {
    case "COMPLETE":
      return { outcome: "verified", method: m };
    case "FAIL":
      return { outcome: "failed", method: m, failureReason: "not_over_threshold" };
    case "ERROR":
      return { outcome: "failed", method: m, failureReason: "provider_error" };
    case "CANCELLED":
      return { outcome: "failed", method: m, failureReason: "cancelled" };
    case "EXPIRED":
      return { outcome: "failed", method: m, failureReason: "session_expired" };
    default:
      return { outcome: "pending", method: m };
  }
}

let cachedKey: { pem: string; key: KeyObject } | undefined;

function notificationKey(): KeyObject | null {
  const pem = env().AGE_VERIFICATION_NOTIFICATION_PUBLIC_KEY;
  if (!pem) return null;
  if (cachedKey?.pem !== pem) cachedKey = { pem, key: createPublicKey(pem) };
  return cachedKey.key;
}

/**
 * Checks a Yoti notification signature the way the docs describe: drop sequence_number and
 * signature, serialize the rest without whitespace, verify RSA-PSS/SHA-256 with the salt length
 * derived from the signature size.
 */
export function verifyYotiNotification(payload: Record<string, unknown>, publicKey: KeyObject): boolean {
  const { signature, sequence_number: _seq, ...rest } = payload;
  void _seq;
  if (typeof signature !== "string") return false;
  const sig = Buffer.from(signature, "base64");
  const saltLength = sig.length - 32 - 2;
  if (saltLength < 0) return false;
  const data = Buffer.from(JSON.stringify(rest).replace(/\s/g, ""), "utf8");
  try {
    return verifySignature("sha256", data, { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength }, sig);
  } catch {
    return false;
  }
}

export const yotiProvider: AgeVerificationProvider = {
  key: "yoti",
  label: "Yoti Age Verification",
  isSandbox: false,
  methods: ["facial_age_estimation", "document_scan_with_liveness", "digital_id"],
  isConfigured: () => Boolean(env().AGE_VERIFICATION_API_KEY && env().AGE_VERIFICATION_SDK_ID),

  async start({ verificationId, returnUrl }) {
    const { sdkId, base } = credentials();
    const appUrl = env().APP_URL;
    const notificationUrl = new URL("/api/webhooks/age-verification/yoti", appUrl).toString();
    const body: Record<string, unknown> = {
      type: "OVER",
      ttl: SESSION_TTL_S,
      // Our own row id only; Yoti echoes it back and the docs ask for nothing personal here.
      reference_id: verificationId,
      callback: { url: new URL("/api/age-verification/return", appUrl).toString(), auto: true },
      cancel_url: returnUrl,
      synchronous_checks: true,
      age_estimation: { allowed: true, threshold: ESTIMATION_THRESHOLD, level: "PASSIVE", authenticity: "AUTO" },
      doc_scan: { allowed: true, threshold: LEGAL_THRESHOLD, level: "PASSIVE", authenticity: "AUTO" },
      digital_id: { allowed: true, threshold: LEGAL_THRESHOLD },
      credit_card: { allowed: false },
      mobile: { allowed: false },
    };
    // Yoti only accepts an https notification URL; without one the return route's result fetch still completes the check.
    if (notificationUrl.startsWith("https:")) body.notification_url = notificationUrl;
    const created = createdSession.parse(await yotiRequest("/api/v1/sessions", { method: "POST", body }));
    const hosted = new URL(base);
    hosted.searchParams.set("sessionId", created.id);
    hosted.searchParams.set("sdkId", sdkId);
    return { url: hosted.toString(), providerRef: created.id };
  },

  async verifyCallback({ rawBody }) {
    const key = notificationKey();
    if (!key) throw new CallbackRejected("unconfigured", "AGE_VERIFICATION_NOTIFICATION_PUBLIC_KEY is not set, so Yoti notifications cannot be checked.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new CallbackRejected("malformed", "The notification body must be JSON.");
    }
    if (!parsed || typeof parsed !== "object") throw new CallbackRejected("malformed", "The notification body must be an object.");
    const payload = parsed as Record<string, unknown>;
    if (typeof payload.signature !== "string") throw new CallbackRejected("unsigned", "The notification carried no signature.");
    if (!verifyYotiNotification(payload, key)) throw new CallbackRejected("bad_signature", "The notification signature does not verify.");
    const n = notification.safeParse(payload);
    if (!n.success) throw new CallbackRejected("malformed", "The notification is missing its session key.");
    // The signed notification is authentic; the result endpoint is still the source of truth when we can reach it.
    if (yotiProvider.isConfigured() && yotiProvider.fetchResult) return yotiProvider.fetchResult(n.data.session_key);
    return { providerRef: n.data.session_key, ...mapYotiStatus(n.data.state ?? "PENDING", n.data.method) };
  },

  async fetchResult(providerRef) {
    const result = sessionResult.parse(await yotiRequest(`/api/v1/sessions/${encodeURIComponent(providerRef)}/result`, { method: "GET" }));
    return { providerRef, ...mapYotiStatus(result.status, result.method) };
  },
};
