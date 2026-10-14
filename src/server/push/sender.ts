import webpush, { WebPushError } from "web-push";
import type { VapidConfig } from "./index";

export type PushTarget = { endpoint: string; p256dh: string; auth: string };

/** gone: the push service says the subscription no longer exists (404/410), so it is pruned. */
export type PushSendResult = { ok: true; statusCode: number } | { ok: false; statusCode: number | null; gone: boolean };

/** Sends one encrypted payload. Injectable so tests never reach a real push service. */
export type PushSender = (target: PushTarget, payload: string, vapid: VapidConfig) => Promise<PushSendResult>;

/** Push services keep an undelivered message this long; a "ready" note older than half a day is noise. */
export const PUSH_TTL_S = 12 * 60 * 60;

export function pushRequestOptions(vapid: VapidConfig): webpush.RequestOptions {
  // aes128gcm (RFC 8291) is what every current push service accepts, Apple's included.
  return { vapidDetails: vapid, TTL: PUSH_TTL_S, urgency: "normal", contentEncoding: "aes128gcm", timeout: 10_000 };
}

/** The real sender (web-push). Never throws: failures come back as a result. */
export const webPushSender: PushSender = async (target, payload, vapid) => {
  try {
    const res = await webpush.sendNotification({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, payload, pushRequestOptions(vapid));
    return { ok: true, statusCode: res.statusCode };
  } catch (err) {
    if (err instanceof WebPushError) return { ok: false, statusCode: err.statusCode, gone: err.statusCode === 404 || err.statusCode === 410 };
    return { ok: false, statusCode: null, gone: false };
  }
};
