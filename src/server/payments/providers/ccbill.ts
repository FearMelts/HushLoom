import { env } from "@/server/env";
import type { PaymentEvent, PaymentProvider } from "../types";
import { WebhookRejected } from "../types";
import { checkoutItem, currencyFromNumeric, currencyToNumeric, hmacHex, md5, parseMoneyCents, safeEqual, toMoneyString, webhookParams } from "../util";

/**
 * CCBill FlexForms with Dynamic Pricing, and CCBill Webhooks.
 *
 * UNVERIFIED against CCBill: no merchant account or sandbox credentials exist. Written from
 * the public documentation (read 2026-10-12):
 *  - Dynamic Pricing User Guide, https://ccbill.com/doc/dynamic-pricing-user-guide
 *    FlexForms URL `https://api.ccbill.com/wap-frontflex/flexforms/{flexId}` with
 *    clientSubacc, initialPrice, initialPeriod, [recurringPrice, recurringPeriod, numRebills],
 *    currencyCode (ISO 4217 numeric, USD = 840) and formDigest. The response digest is
 *    "MD5 of subscriptionId, then 1 for approved or 0 for denied, then the salt".
 *  - Create a new formDigest value, https://ccbill.com/doc/formdigest-value
 *    single: md5(initialPrice + initialPeriod + currencyCode + salt)
 *    recurring: md5(initialPrice + initialPeriod + recurringPrice + recurringPeriod + numRebills + currencyCode + salt)
 *    (no separators; example pre-hash "10.003010.0030998407d901dad245fd0ff6bc20d06").
 *  - Webhooks User Guide, https://ccbill.com/doc/webhooks-user-guide
 *    HTTP POST, JSON or form-encoded body, query parameters clientAccnum, clientSubacc,
 *    eventType, eventGroupType; pass-through key/values are prefixed "X-".
 *  - NewSaleSuccess (https://ccbill.com/doc/?p=10409): subscriptionId, transactionId, timestamp,
 *    billedInitialPrice, billedCurrencyCode, accountingInitialPrice, nextRenewalDate,
 *    dynamicPricingValidationDigest ("blank string" without Dynamic Pricing), pass-through pairs.
 *  - RenewalSuccess (https://ccbill.com/doc/?p=10444): transactionId, subscriptionId, timestamp,
 *    billedAmount, billedCurrencyCode, nextRenewalDate; no digest.
 *  - Chargeback (https://ccbill.com/doc/?p=10448) and Return (https://ccbill.com/doc/?p=10450):
 *    transactionId, subscriptionId, timestamp, amount, currencyCode, reason; no digest.
 *
 * What must be confirmed in CCBill's sandbox before go-live:
 *  1. That FlexForms echoes URL parameters prefixed "X-" back in webhooks (pass-through), and
 *     under which key spelling (this adapter reads only "X-hlUser", in any case; never the bare "hlUser").
 *  2. Whether the Refund / Chargeback / Return `transactionId` is the original sale's id or a
 *     new id (this adapter tries the transaction id first, then the subscriptionId). If it is the
 *     refunded charge's id, drop subscriptionRef from reversals, as Segpay does with relatedtranid:
 *     otherwise a refund of a rebill that overtakes the rebill is taken from the pass's first charge.
 *  3. Whether the webhook URL keeps its own query string, which CCBILL_WEBHOOK_TOKEN relies on.
 *  4. The exact `timestamp` and `nextRenewalDate` formats (only the "YYYY-MM-DD HH:MM:SS" example is documented).
 *  5. `initialPeriod` for one-time packs (30 days here; CCBill allows 2–365).
 */

const FLEXFORMS_BASE = "https://api.ccbill.com/wap-frontflex/flexforms";
const PACK_PERIOD_DAYS = 30;
const PLAN_PERIOD_DAYS = 30;
const PLAN_REBILLS = 99;

type Cfg = { account: string; subaccount: string; flexId: string; salt: string; token: string };

/**
 * The webhook token is required: refunds, chargebacks, renewals and cancellations carry no signature,
 * so without it CCBill would take sales and silently drop every reversal. It stays off instead.
 */
function cfg(): Cfg | null {
  const e = env();
  if (!e.CCBILL_ACCOUNT || !e.CCBILL_SUBACCOUNT || !e.CCBILL_FLEXFORM_ID || !e.CCBILL_SALT || !e.CCBILL_WEBHOOK_TOKEN) return null;
  return { account: e.CCBILL_ACCOUNT, subaccount: e.CCBILL_SUBACCOUNT, flexId: e.CCBILL_FLEXFORM_ID, salt: e.CCBILL_SALT, token: e.CCBILL_WEBHOOK_TOKEN };
}

const missing = () => (["CCBILL_ACCOUNT", "CCBILL_SUBACCOUNT", "CCBILL_FLEXFORM_ID", "CCBILL_SALT", "CCBILL_WEBHOOK_TOKEN"] as const).filter((k) => !env()[k]);

/** Binds the signed-in user to the item so a tampered pass-through pair is detected on the webhook. */
export const passthroughSignature = (salt: string, userId: string, itemKey: string) => hmacHex(salt, `ccbill:${userId}:${itemKey}`);

export function ccbillCheckoutUrl(c: Cfg, userId: string, itemKey: string): string {
  const item = checkoutItem(itemKey);
  if (!item) throw new Error(`unknown item ${itemKey}`);
  const price = toMoneyString(item.priceCents);
  const currencyCode = currencyToNumeric(item.currency);
  const q = new URLSearchParams({ clientAccnum: c.account, clientSubacc: c.subaccount, initialPrice: price, initialPeriod: String(item.kind === "plan" ? PLAN_PERIOD_DAYS : PACK_PERIOD_DAYS) });
  if (item.kind === "plan") {
    q.set("recurringPrice", price);
    q.set("recurringPeriod", String(PLAN_PERIOD_DAYS));
    q.set("numRebills", String(PLAN_REBILLS));
    q.set("currencyCode", currencyCode);
    q.set("formDigest", md5(`${price}${PLAN_PERIOD_DAYS}${price}${PLAN_PERIOD_DAYS}${PLAN_REBILLS}${currencyCode}${c.salt}`));
  } else {
    q.set("currencyCode", currencyCode);
    q.set("formDigest", md5(`${price}${PACK_PERIOD_DAYS}${currencyCode}${c.salt}`));
  }
  q.set("X-hlUser", userId);
  q.set("X-hlItem", item.key);
  q.set("X-hlSig", passthroughSignature(c.salt, userId, item.key));
  return `${FLEXFORMS_BASE}/${encodeURIComponent(c.flexId)}?${q.toString()}`;
}

/** md5(subscriptionId + "1"|"0" + salt), per the Dynamic Pricing User Guide. */
export const validationDigest = (salt: string, subscriptionId: string, approved: boolean) => md5(`${subscriptionId}${approved ? "1" : "0"}${salt}`);

const field = (p: Record<string, string>, ...names: string[]) => {
  for (const n of names) {
    const v = p[n.toLowerCase()];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
};

/**
 * Pass-through values are read only under their documented "X-" spelling (any case). A bare "hlUser" would put the
 * buyer's form parameters in the same namespace as CCBill's own fields, so an echoed X-billedInitialPrice could
 * stand in for what CCBill billed. If CCBill turns out to strip the prefix, sales are not granted: fail closed.
 */
const passthrough = (p: Record<string, string>, name: string) => field(p, `X-${name}`);

function parseDate(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s.includes("T") ? s : `${s.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function ccbillEventFromParams(c: Cfg, p: Record<string, string>): PaymentEvent {
  const eventType = field(p, "eventType");
  if (!eventType) throw new WebhookRejected("malformed", "Missing eventType.");
  const account = field(p, "clientAccnum");
  if (account && !safeEqual(account, c.account)) throw new WebhookRejected("bad_signature", "Event is for another CCBill account.");
  const given = field(p, "token");
  if (!given) throw new WebhookRejected("unsigned", "Missing webhook token.");
  if (!safeEqual(given, c.token)) throw new WebhookRejected("bad_signature", "Webhook token does not match.");

  const subscriptionId = field(p, "subscriptionId");
  const transactionId = field(p, "transactionId");
  const timestamp = field(p, "timestamp") ?? "";
  const digest = field(p, "dynamicPricingValidationDigest");
  const isSale = eventType === "NewSaleSuccess" || eventType === "NewSaleFailure";
  if (isSale) {
    // Dynamic Pricing sales always carry the validation digest; a blank one means the form was not ours.
    if (!digest) throw new WebhookRejected("unsigned", "Missing dynamicPricingValidationDigest.");
    if (!subscriptionId) throw new WebhookRejected("malformed", "Missing subscriptionId.");
    if (!safeEqual(digest, validationDigest(c.salt, subscriptionId, eventType === "NewSaleSuccess"))) {
      throw new WebhookRejected("bad_signature", "dynamicPricingValidationDigest does not match.");
    }
  } else if (digest) {
    if (!subscriptionId || !safeEqual(digest, validationDigest(c.salt, subscriptionId, true))) throw new WebhookRejected("bad_signature", "dynamicPricingValidationDigest does not match.");
  }

  const ref = transactionId ?? subscriptionId;
  if (!ref) throw new WebhookRejected("malformed", "Missing transactionId and subscriptionId.");
  // A sale is keyed on the one field its digest signs: one subscription is one sale, so a signed sale
  // re-posted with another timestamp or transactionId is a duplicate, not a second grant.
  const providerEventId = isSale ? `${eventType}:${subscriptionId}` : `${eventType}:${ref}:${timestamp}`;
  const currencyCode = field(p, "billedCurrencyCode", "currencyCode");
  const meta = { eventType, subscriptionId, transactionId, timestamp, clientSubacc: field(p, "clientSubacc"), currencyCode };
  // A currency code this adapter does not know, or none, is never read as USD: it is recorded as ISO 4217 "XXX" (no
  // currency), so a sale or renewal in it fails the price check and is held for review with the code in its metadata.
  const currency = (field(p, "billedCurrency", "currency") ?? currencyFromNumeric(currencyCode) ?? "xxx").toLowerCase();

  switch (eventType) {
    case "NewSaleSuccess": {
      const userId = passthrough(p, "hlUser");
      const itemKey = passthrough(p, "hlItem");
      const sig = passthrough(p, "hlSig");
      if (!userId || !itemKey || !sig) return { type: "ignored", providerEventId, raw: "NewSaleSuccess without Hushloom pass-through values", metadata: meta };
      if (!safeEqual(sig, passthroughSignature(c.salt, userId, itemKey))) throw new WebhookRejected("bad_signature", "Pass-through signature does not match.");
      const item = checkoutItem(itemKey);
      if (!item) return { type: "ignored", providerEventId, raw: `unknown item ${itemKey}`, metadata: meta };
      // The pass-through pair is not tied to the form's price, so a pair issued for one item can ride on another
      // item's form. What CCBill billed decides: it must be exactly the item's price, and a pass needs recurring terms.
      const billed = parseMoneyCents(field(p, "billedInitialPrice", "accountingInitialPrice", "initialPrice"));
      const amountCents = billed ?? 0;
      const nextRenewal = parseDate(field(p, "nextRenewalDate"));
      const review =
        billed === null
          ? "CCBill sent no billed price"
          : billed !== item.priceCents || currency !== item.currency
            ? `billed ${toMoneyString(billed)} ${currency.toUpperCase()}, ${item.label} costs ${toMoneyString(item.priceCents)} ${item.currency.toUpperCase()}`
            : item.kind === "plan" && !nextRenewal
              ? `${item.label} was bought on a form without recurring terms`
              : undefined;
      if (item.kind === "plan") {
        return {
          type: "subscription_started",
          providerEventId,
          userId,
          itemKey,
          providerSubscriptionId: subscriptionId!,
          amountCents,
          currency,
          transactionRef: transactionId ?? subscriptionId!,
          currentPeriodEnd: nextRenewal,
          grantsFirstPeriod: true,
          review,
          metadata: meta,
        };
      }
      return { type: "purchase_completed", providerEventId, userId, itemKey, amountCents, currency, transactionRef: transactionId ?? subscriptionId!, review, metadata: { ...meta, subscriptionRef: subscriptionId } };
    }
    case "RenewalSuccess":
      return {
        type: "subscription_renewed",
        providerEventId,
        providerSubscriptionId: subscriptionId ?? "",
        amountCents: parseMoneyCents(field(p, "billedAmount", "billedRecurringPrice", "accountingAmount")) ?? 0,
        currency,
        transactionRef: transactionId ?? `${subscriptionId}:${timestamp}`,
        currentPeriodEnd: parseDate(field(p, "nextRenewalDate", "renewalDate")),
        metadata: meta,
      };
    case "Cancellation":
    case "Expiration":
      // Cancellation stops rebilling; the pass stays paid until its period ends, when CCBill sends Expiration.
      return { type: "subscription_cancelled", providerEventId, providerSubscriptionId: subscriptionId ?? "", atPeriodEnd: eventType === "Cancellation", metadata: meta };
    case "Refund":
    case "Void":
    case "Return":
      return {
        type: "refund",
        providerEventId,
        transactionRef: transactionId ?? subscriptionId!,
        subscriptionRef: subscriptionId,
        amountCents: Math.abs(parseMoneyCents(field(p, "amount", "accountingAmount")) ?? 0),
        currency,
        metadata: { ...meta, reason: field(p, "reason") },
      };
    case "Chargeback":
      return {
        type: "chargeback",
        providerEventId,
        transactionRef: transactionId ?? subscriptionId!,
        subscriptionRef: subscriptionId,
        amountCents: Math.abs(parseMoneyCents(field(p, "amount", "accountingAmount")) ?? 0),
        currency,
        metadata: { ...meta, reason: field(p, "reason") },
      };
    default:
      // NewSaleFailure, RenewalFailure, BillingDateChange, CustomerDataUpdate, UserReactivation, Upgrade*, UpSale*, CrossSale*, ManualAdd
      return { type: "ignored", providerEventId, raw: `ccbill ${eventType}`, metadata: meta };
  }
}

export const ccbillProvider: PaymentProvider = {
  key: "ccbill",
  label: "CCBill",
  isSandbox: false,
  capabilities: { packs: true, subscriptions: true, refunds: true, adultContentAllowed: true },
  isConfigured: () => env().PAYMENT_PROVIDER === "ccbill" && cfg() !== null,
  webhookConfigured: () => cfg() !== null,
  configurationProblem() {
    if (env().PAYMENT_PROVIDER !== "ccbill") return "PAYMENT_PROVIDER is not ccbill.";
    const m = missing();
    return m.length ? `Missing ${m.join(", ")}.` : null;
  },
  async createCheckout({ user, item }) {
    const c = cfg();
    if (!c) throw new Error("ccbill not configured");
    return { url: ccbillCheckoutUrl(c, user.id, item.key) };
  },
  async verifyWebhook({ rawBody, headers, url }) {
    const c = cfg();
    if (!c) throw new WebhookRejected("unsigned", "CCBill is not configured.");
    let params: Record<string, string>;
    try {
      params = webhookParams(rawBody, headers, url);
    } catch {
      throw new WebhookRejected("malformed", "Body is not valid JSON or form data.");
    }
    return ccbillEventFromParams(c, params);
  },
};
