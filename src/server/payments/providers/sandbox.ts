import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { env } from "@/server/env";
import type { PaymentEvent, PaymentProvider } from "../types";
import { WebhookRejected } from "../types";
import { checkoutItem, safeEqual } from "../util";

/**
 * The sandbox processor. No money moves, ever. It exists so the whole path
 * (checkout → webhook → ledger → refund / chargeback clawback) runs end to end
 * on a developer machine or a staging server without any real processor.
 *
 * It refuses to run with NODE_ENV=production: a live site must name a real processor.
 * Everything it renders carries the "demo" tone and says so.
 */

/**
 * DEV-ONLY secret. It is a constant on purpose: the sandbox only runs outside production,
 * and anyone with this code can already run the sandbox. It signs the sandbox checkout
 * token and the sandbox webhook body (HMAC-SHA256), so the webhook route exercises the same
 * "reject unsigned / badly signed / stale" checks a real processor adapter has.
 */
export const SANDBOX_WEBHOOK_SECRET = "hushloom-sandbox-dev-only-secret-no-money-moves";
export const SANDBOX_SIGNATURE_HEADER = "x-sandbox-signature";
const TOKEN_TTL_S = 30 * 60;
const SIGNATURE_WINDOW_S = 5 * 60;

const hmac = (s: string) => createHmac("sha256", SANDBOX_WEBHOOK_SECRET).update(s).digest("base64url");

export function sandboxAllowed(): boolean {
  return env().NODE_ENV !== "production";
}

// ── Checkout token: carried in the /pricing/sandbox URL ──

const tokenSchema = z.object({ userId: z.string().uuid(), itemKey: z.string().max(40), exp: z.number().int(), nonce: z.string() });
export type SandboxToken = z.infer<typeof tokenSchema>;

export function createSandboxToken(userId: string, itemKey: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ userId, itemKey, exp: Math.floor(now / 1000) + TOKEN_TTL_S, nonce: randomUUID() } satisfies SandboxToken)).toString("base64url");
  return `${payload}.${hmac(payload)}`;
}

/** Returns the token's claims, or null when it is forged, malformed or expired. */
export function readSandboxToken(token: string | null | undefined, now = Date.now()): SandboxToken | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig || !safeEqual(hmac(payload), sig)) return null;
  try {
    const claims = tokenSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    return claims.exp * 1000 > now ? claims : null;
  } catch {
    return null;
  }
}

// ── Webhook body and signature ──

export const sandboxBodySchema = z.object({
  kind: z.enum(["sale", "failure", "renewal", "cancel", "refund", "chargeback"]),
  eventId: z.string().min(4).max(120),
  userId: z.string().uuid().optional(),
  itemKey: z.string().max(40).optional(),
  amountCents: z.number().int().nonnegative(),
  currency: z.string().min(3).max(3),
  transactionRef: z.string().min(1).max(120),
  subscriptionRef: z.string().max(120).optional(),
});
export type SandboxBody = z.infer<typeof sandboxBodySchema>;

/** `t=<unix seconds>,v1=<HMAC-SHA256(secret, "<t>.<body>")>`, the shape most processors use. */
export function signSandboxBody(rawBody: string, now = Date.now()): string {
  const t = Math.floor(now / 1000);
  return `t=${t},v1=${hmac(`${t}.${rawBody}`)}`;
}

export function newSandboxEventId(kind: SandboxBody["kind"]) {
  return `sbx_${kind}_${randomUUID()}`;
}

function verify(rawBody: string, header: string | null, now: number): SandboxBody {
  if (!header) throw new WebhookRejected("unsigned", "Missing sandbox signature.");
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) throw new WebhookRejected("bad_signature", "Malformed sandbox signature.");
  if (!safeEqual(hmac(`${t}.${rawBody}`), parts.v1)) throw new WebhookRejected("bad_signature", "Sandbox signature does not match the body.");
  if (Math.abs(now / 1000 - t) > SIGNATURE_WINDOW_S) throw new WebhookRejected("replayed", "Sandbox signature is outside the replay window.");
  try {
    return sandboxBodySchema.parse(JSON.parse(rawBody));
  } catch {
    throw new WebhookRejected("malformed", "Sandbox body is not a valid event.");
  }
}

export function sandboxEventFromBody(body: SandboxBody): PaymentEvent {
  const item = body.itemKey ? checkoutItem(body.itemKey) : null;
  switch (body.kind) {
    case "sale": {
      if (!body.userId || !item) return { type: "ignored", providerEventId: body.eventId, raw: "sale without a user or item" };
      if (item.kind === "plan") {
        return {
          type: "subscription_started",
          providerEventId: body.eventId,
          userId: body.userId,
          itemKey: item.key,
          providerSubscriptionId: body.subscriptionRef ?? `sbxsub_${body.transactionRef}`,
          amountCents: body.amountCents,
          currency: body.currency,
          transactionRef: body.transactionRef,
          currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
          grantsFirstPeriod: true,
          metadata: { sandbox: true },
        };
      }
      return { type: "purchase_completed", providerEventId: body.eventId, userId: body.userId, itemKey: item.key, amountCents: body.amountCents, currency: body.currency, transactionRef: body.transactionRef, metadata: { sandbox: true } };
    }
    case "renewal":
      return {
        type: "subscription_renewed",
        providerEventId: body.eventId,
        providerSubscriptionId: body.subscriptionRef ?? "",
        amountCents: body.amountCents,
        currency: body.currency,
        transactionRef: body.transactionRef,
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
        metadata: { sandbox: true },
      };
    case "cancel":
      return { type: "subscription_cancelled", providerEventId: body.eventId, providerSubscriptionId: body.subscriptionRef ?? "", metadata: { sandbox: true } };
    case "refund":
      return { type: "refund", providerEventId: body.eventId, transactionRef: body.transactionRef, amountCents: body.amountCents, currency: body.currency, subscriptionRef: body.subscriptionRef, metadata: { sandbox: true } };
    case "chargeback":
      return { type: "chargeback", providerEventId: body.eventId, transactionRef: body.transactionRef, amountCents: body.amountCents, currency: body.currency, subscriptionRef: body.subscriptionRef, metadata: { sandbox: true } };
    case "failure":
      return { type: "ignored", providerEventId: body.eventId, raw: "sandbox: simulated failed payment", metadata: { sandbox: true } };
  }
}

export const sandboxProvider: PaymentProvider = {
  key: "sandbox",
  label: "Sandbox",
  isSandbox: true,
  // Not a processor: it allows everything because it charges nothing.
  capabilities: { packs: true, subscriptions: true, refunds: true, adultContentAllowed: true },
  isConfigured: () => sandboxAllowed() && env().PAYMENT_PROVIDER === "sandbox",
  webhookConfigured: () => sandboxAllowed() && env().PAYMENT_PROVIDER === "sandbox",
  configurationProblem() {
    if (!sandboxAllowed()) return "The payment sandbox refuses to run in production. Set PAYMENT_PROVIDER to ccbill or segpay with that processor's keys.";
    if (env().PAYMENT_PROVIDER !== "sandbox") return "PAYMENT_PROVIDER is not sandbox.";
    return null;
  },
  async createCheckout({ user, item }) {
    if (!sandboxAllowed()) throw new Error("sandbox checkout refused in production");
    const token = createSandboxToken(user.id, item.key);
    return { url: `${env().APP_URL}/pricing/sandbox?t=${encodeURIComponent(token)}`, providerRef: token.slice(-16) };
  },
  async verifyWebhook({ rawBody, headers }) {
    if (!sandboxAllowed()) throw new WebhookRejected("unsigned", "The sandbox is off in production.");
    return sandboxEventFromBody(verify(rawBody, headers.get(SANDBOX_SIGNATURE_HEADER), Date.now()));
  },
};
