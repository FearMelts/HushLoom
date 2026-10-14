import { env } from "@/server/env";
import { HttpError } from "@/server/http";
import { ccbillProvider } from "./providers/ccbill";
import { sandboxProvider } from "./providers/sandbox";
import { segpayProvider } from "./providers/segpay";
import { stripeProvider } from "./providers/stripe";
import { assertCanCheckout } from "./service";
import type { PaymentProvider } from "./types";
import { checkoutItem } from "./util";

const PROVIDERS: Record<PaymentProvider["key"], PaymentProvider> = {
  sandbox: sandboxProvider,
  ccbill: ccbillProvider,
  segpay: segpayProvider,
  stripe: stripeProvider,
};

/** Own keys only: `in` would also accept names inherited from Object.prototype ("constructor", "toString"). */
export const isProviderKey = (k: string): k is PaymentProvider["key"] => Object.hasOwn(PROVIDERS, k);

/** A provider by key, whether or not it is the active one (webhooks for a previous processor still arrive). */
export function providerByKey(key: string): PaymentProvider | null {
  return isProviderKey(key) ? PROVIDERS[key] : null;
}

/** The processor chosen by PAYMENT_PROVIDER. */
export function paymentProvider(): PaymentProvider {
  return PROVIDERS[env().PAYMENT_PROVIDER];
}

export type PaymentsStatus = {
  provider: PaymentProvider["key"];
  label: string;
  isSandbox: boolean;
  configured: boolean;
  adultContentAllowed: boolean;
  /** Why checkout is off, when it is. */
  problem: string | null;
};

/** For the pricing page, the admin panel and health checks. Never includes secrets. */
export function paymentsStatus(): PaymentsStatus {
  const p = paymentProvider();
  return { provider: p.key, label: p.label, isSandbox: p.isSandbox, configured: p.isConfigured(), adultContentAllowed: p.capabilities.adultContentAllowed, problem: p.configurationProblem() };
}

export const paymentsConfigured = () => paymentProvider().isConfigured();

/**
 * Starts a checkout with the active processor. Server-side checks only: the item must exist,
 * the processor must be configured, and a chargeback-flagged account is refused (403).
 */
export async function startCheckout(user: { id: string; email: string }, itemKey: string): Promise<{ url: string; provider: PaymentProvider["key"]; isSandbox: boolean }> {
  const provider = paymentProvider();
  if (!provider.isConfigured()) throw new HttpError(503, "payments_unavailable", "Payments are not configured on this server yet.");
  await assertCanCheckout(user.id);
  const item = checkoutItem(itemKey);
  if (!item) throw new HttpError(422, "unknown_item", "That package does not exist.");
  if (item.kind === "plan" && !provider.capabilities.subscriptions) throw new HttpError(422, "unsupported_item", "Passes are not available with this processor.");
  const base = env().APP_URL;
  const { url } = await provider.createCheckout({ user, item, successUrl: `${base}/pricing?checkout=success`, cancelUrl: `${base}/pricing?checkout=cancelled` });
  return { url, provider: provider.key, isSandbox: provider.isSandbox };
}
