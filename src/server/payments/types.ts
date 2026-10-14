import type { Tx } from "@/server/db";

/**
 * Payment processors sit behind this adapter, like the AI providers (addendum §1).
 * The active one is chosen by PAYMENT_PROVIDER. "sandbox" never charges anyone and
 * labels itself as such everywhere it appears.
 */
export type CheckoutItem = { key: string; kind: "pack" | "plan"; label: string; priceCents: number; currency: string; credits: number };

export type CheckoutRequest = { user: { id: string; email: string }; item: CheckoutItem; successUrl: string; cancelUrl: string };

export type CheckoutResult = { url: string; providerRef?: string };

/**
 * A processor event after signature verification, normalized so the ledger code is provider-agnostic.
 * `providerEventId` must be stable across redeliveries: it is the exactly-once key (payment_events is
 * unique on provider + providerEventId). `metadata` is stored on the event row verbatim.
 */
export type PaymentEvent = (
  | {
      type: "purchase_completed";
      providerEventId: string;
      userId: string;
      itemKey: string;
      amountCents: number;
      currency: string;
      transactionRef: string;
      /** Set when the processor confirmed a payment whose terms do not match what was sold: recorded and held for manual review, never granted. */
      review?: string;
    }
  | {
      type: "subscription_started";
      providerEventId: string;
      userId: string;
      itemKey: string;
      providerSubscriptionId: string;
      providerCustomerId?: string;
      amountCents: number;
      currency: string;
      transactionRef: string;
      currentPeriodEnd?: Date;
      /** True when this event is itself the charge for the first period (CCBill, Segpay, sandbox). Stripe sends a separate invoice. */
      grantsFirstPeriod?: boolean;
      /** As on purchase_completed: held for manual review, no pass and no credits. */
      review?: string;
    }
  | { type: "subscription_renewed"; providerEventId: string; providerSubscriptionId: string; amountCents: number; currency: string; transactionRef: string; currentPeriodEnd?: Date }
  | { type: "subscription_updated"; providerEventId: string; providerSubscriptionId: string; status: string; currentPeriodEnd?: Date }
  | { type: "subscription_cancelled"; providerEventId: string; providerSubscriptionId: string; currentPeriodEnd?: Date }
  | {
      type: "refund";
      providerEventId: string;
      transactionRef: string;
      amountCents: number;
      currency: string;
      /** The processor's subscription / purchase id, for processors whose refund carries a new transaction id. */
      subscriptionRef?: string;
      /** True when amountCents is the total refunded so far (Stripe), false when it is this refund alone. */
      cumulative?: boolean;
    }
  | { type: "chargeback"; providerEventId: string; transactionRef: string; amountCents: number; currency: string; subscriptionRef?: string }
  | { type: "ignored"; providerEventId: string; raw: string }
) & { metadata?: Record<string, unknown> };

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
  /** Shown to people, e.g. "CCBill". */
  readonly label: string;
  /** Sandbox providers never move money; the UI and verification report say so. */
  readonly isSandbox: boolean;
  readonly capabilities: PaymentCapabilities;
  /** True when this provider is the active one and has everything it needs to start a checkout. */
  isConfigured(): boolean;
  /** True when the secrets needed to verify this provider's webhooks are present, whether or not it is active. */
  webhookConfigured(): boolean;
  /** Why isConfigured() is false, for the UI and the health check. */
  configurationProblem(): string | null;
  createCheckout(req: CheckoutRequest): Promise<CheckoutResult>;
  /** Verifies the processor's signature / shared secret and rejects unsigned, malformed or replayed events. */
  verifyWebhook(input: { rawBody: string; headers: Headers; url: URL }): Promise<PaymentEvent>;
  /** Optional provider-side cancellation; the ledger side is handled by the shared service. */
  cancelSubscription?(providerSubscriptionId: string, tx?: Tx): Promise<void>;
}
