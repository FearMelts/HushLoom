import type { Tx } from "@/server/db";

/**
 * Payment processors sit behind this adapter, like the AI providers (addendum §1).
 * The active one is chosen by PAYMENT_PROVIDER. "sandbox" never charges anyone and
 * labels itself as such everywhere it appears.
 */
export type CheckoutItem = { key: string; kind: "pack" | "plan"; label: string; priceCents: number; currency: string; credits: number };

export type CheckoutRequest = { user: { id: string; email: string }; item: CheckoutItem; successUrl: string; cancelUrl: string };

export type CheckoutResult = { url: string; providerRef?: string };

/** A processor event after signature verification, normalized so the ledger code is provider-agnostic. */
export type PaymentEvent =
  | { type: "purchase_completed"; providerEventId: string; userId: string; itemKey: string; amountCents: number; currency: string; transactionRef: string }
  | { type: "subscription_started"; providerEventId: string; userId: string; itemKey: string; providerSubscriptionId: string; providerCustomerId?: string; amountCents: number; currency: string; transactionRef: string; currentPeriodEnd?: Date }
  | { type: "subscription_renewed"; providerEventId: string; providerSubscriptionId: string; amountCents: number; currency: string; transactionRef: string; currentPeriodEnd?: Date }
  | { type: "subscription_cancelled"; providerEventId: string; providerSubscriptionId: string; currentPeriodEnd?: Date }
  | { type: "refund"; providerEventId: string; transactionRef: string; amountCents: number; currency: string }
  | { type: "chargeback"; providerEventId: string; transactionRef: string; amountCents: number; currency: string }
  | { type: "ignored"; providerEventId: string; raw: string };

export type PaymentCapabilities = { packs: boolean; subscriptions: boolean; refunds: boolean; adultContentAllowed: boolean };

export class WebhookRejected extends Error {
  constructor(
    public readonly reason: "unsigned" | "bad_signature" | "replayed" | "malformed",
    message: string,
  ) {
    super(message);
  }
}

export interface PaymentProvider {
  readonly key: "sandbox" | "ccbill" | "segpay" | "stripe";
  /** Sandbox providers never move money; the UI and verification report say so. */
  readonly isSandbox: boolean;
  readonly capabilities: PaymentCapabilities;
  isConfigured(): boolean;
  createCheckout(req: CheckoutRequest): Promise<CheckoutResult>;
  /** Verifies the processor's signature / shared secret and rejects unsigned, malformed or replayed events. */
  verifyWebhook(input: { rawBody: string; headers: Headers; url: URL }): Promise<PaymentEvent>;
  /** Optional provider-side cancellation; the ledger side is handled by the shared service. */
  cancelSubscription?(providerSubscriptionId: string, tx?: Tx): Promise<void>;
}
