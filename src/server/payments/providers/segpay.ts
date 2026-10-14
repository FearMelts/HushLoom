import { env } from "@/server/env";
import type { PaymentEvent, PaymentProvider } from "../types";
import { WebhookRejected } from "../types";
import { checkoutItem, hmacHex, parseMoneyCents, safeEqual, webhookParams } from "../util";

/**
 * Segpay hosted pay page (packageId:pricePointId "eticket") and Segpay postbacks.
 *
 * UNVERIFIED against Segpay: no merchant account exists. Written from the public documentation
 * at gethelp.segpay.com (read 2026-10-12):
 *  - Base URL (DeveloperDocs/ProcessingAPI/01-BaseURL.htm): the join link is
 *    `https://secure2.segpay.com/billing/poset.cgi?x-eticketid=xxxxxx:xxxxx`, "based on the Package
 *    you're using and the selected Price Points".
 *  - Parameters for populating fields (02-Parameters-PopulateFields.htm): x-billemail, x-auth-link,
 *    x-decl-link; user-defined parameters (any name, values up to 32 characters, "cannot begin with a
 *    number") are stored in USERDATA.
 *  - Postbacks (06-Postbacks.htm) and Manage Postbacks (MPDocs/MyWebsites/ManagePostbacks.htm):
 *    postback types Inquiry, Enable, Disable, Cancellation, Reactivation (synchronous, must answer
 *    the configured Expected Response, e.g. "OK") and TransPost ("Any transaction (payment, refund,
 *    void, chargeback)", asynchronous, HTTP status only). URL templates use placeholders such as
 *    `<purchaseid>`, `<tranid>`, `<extra xxxx>` for user-defined values. Segpay documents no
 *    signature on postbacks; it tells merchants to allowlist Segpay's IPs and supports a
 *    username/password for password-protected scripts.
 *  - Postback parameters (07-PostbackParameters.htm): action, stage (Initial, Conversion, Rebill,
 *    Instantconversion), approved (Yes/No), trantype (Sale, Credit, Charge, CB Reversal, RDRreversal),
 *    tranid, relatedtranid ("original sale ID for refunds, voids, chargebacks"), purchaseid,
 *    eticketid, price, currencycode, transtime, `<extra xxxx>` for values passed to the pay page.
 *
 * Authentication, because Segpay signs nothing: the postback URL registered in the merchant portal
 * carries `key=<SEGPAY_POSTBACK_SECRET>` (or the portal's password protection sends HTTP Basic auth
 * whose password is SEGPAY_POSTBACK_SECRET or SEGPAY_USER_ACCESS_KEY). Every postback must present
 * one of these; the pay page also carries an HMAC (hlsig) over the user + item pair that Segpay
 * echoes back, so a tampered pair is detected. Replays are stopped by the event id
 * (`<action>:<tranid>`), which payment_events keeps unique per provider.
 *
 * What must be confirmed in Segpay's test setup before go-live:
 *  1. The postback URL template that returns the user-defined values (documented here as
 *     `&hluser=<extra hluser>&hlitem=<extra hlitem>&hlsig=<extra hlsig>`), and whether the
 *     "all parameters" default includes them.
 *  2. Whether Segpay delivers postbacks as GET query strings or POST bodies (both are read here).
 *  3. The price point ids per pack / plan (SEGPAY_PRICE_POINT_ID map, one per item) and that their prices
 *     match src/config/pricing.ts; Segpay, not this app, decides the amount charged. The postback template
 *     must carry <eticketid>, <price> and <currencycode>: a sale without them is held for manual review.
 *  4. The `transtime` format and the exact spelling of `trantype` values.
 */

const PAY_PAGE = "https://secure2.segpay.com/billing/poset.cgi";

type Cfg = { packageId: string; pricePoints: Map<string, string>; secret: string; accessKey: string | null };

/**
 * SEGPAY_PRICE_POINT_ID maps each pack / plan to its own price point: "pack_small=12345,plan_member=12346".
 * The price point Segpay charged is how a postback proves which item was bought, so there is no shared
 * fallback: an item without its own price point cannot be sold, and a bare value is ignored.
 */
function parsePricePoints(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [k, v] = part.split("=").map((s) => s.trim());
    if (k && v) map.set(k, v);
  }
  return map;
}

function cfg(): Cfg | null {
  const e = env();
  if (!e.SEGPAY_PACKAGE_ID || !e.SEGPAY_PRICE_POINT_ID || !e.SEGPAY_POSTBACK_SECRET) return null;
  return { packageId: e.SEGPAY_PACKAGE_ID, pricePoints: parsePricePoints(e.SEGPAY_PRICE_POINT_ID), secret: e.SEGPAY_POSTBACK_SECRET, accessKey: e.SEGPAY_USER_ACCESS_KEY ?? null };
}

const missing = () => (["SEGPAY_PACKAGE_ID", "SEGPAY_PRICE_POINT_ID", "SEGPAY_POSTBACK_SECRET"] as const).filter((k) => !env()[k]);

/** User-defined values are capped at 32 characters and may not start with a digit: a uuid becomes "u" + 22 base64url chars. */
export const compactUserId = (uuid: string) => `u${Buffer.from(uuid.replace(/-/g, ""), "hex").toString("base64url")}`;
export function expandUserId(compact: string | undefined): string | null {
  if (!compact || !compact.startsWith("u")) return null;
  const hex = Buffer.from(compact.slice(1), "base64url").toString("hex");
  if (hex.length !== 32) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** "s" + 31 hex chars of HMAC-SHA256(secret, user:item): fits the 32-character cap and never starts with a digit. */
export const passthroughSignature = (secret: string, userId: string, itemKey: string) => `s${hmacHex(secret, `segpay:${userId}:${itemKey}`).slice(0, 31)}`;

export function segpayPricePoint(c: Cfg, itemKey: string): string | null {
  return c.pricePoints.get(itemKey) ?? null;
}

export function segpayCheckoutUrl(c: Cfg, user: { id: string; email: string }, itemKey: string, successUrl: string, cancelUrl: string): string | null {
  const item = checkoutItem(itemKey);
  const pricePoint = segpayPricePoint(c, itemKey);
  if (!item || !pricePoint) return null;
  const q = new URLSearchParams({
    "x-eticketid": `${c.packageId}:${pricePoint}`,
    "x-billemail": user.email,
    "x-auth-link": successUrl,
    "x-auth-text": "Back to Hushloom",
    "x-decl-link": cancelUrl,
    "x-decl-text": "Back to Hushloom",
    hluser: compactUserId(user.id),
    hlitem: item.key,
    hlsig: passthroughSignature(c.secret, user.id, item.key),
  });
  return `${PAY_PAGE}?${q.toString()}`;
}

const field = (p: Record<string, string>, ...names: string[]) => {
  for (const n of names) {
    const v = p[n.toLowerCase()];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
};

/** Values echoed from the pay page may come back as "hluser", "extra hluser", "extra_hluser" or "x-hluser". */
const extra = (p: Record<string, string>, name: string) => field(p, name, `extra ${name}`, `extra_${name}`, `x-${name}`);

function authenticate(c: Cfg, p: Record<string, string>, headers: Headers) {
  const key = field(p, "key", "postbackkey");
  const basic = headers.get("authorization");
  if (!key && !basic) throw new WebhookRejected("unsigned", "Missing postback key.");
  if (key) {
    if (safeEqual(key, c.secret)) return;
    throw new WebhookRejected("bad_signature", "Postback key does not match.");
  }
  const m = /^Basic\s+(.+)$/i.exec(basic ?? "");
  const password = m ? Buffer.from(m[1]!, "base64").toString("utf8").split(":").slice(1).join(":") : "";
  if (safeEqual(password, c.secret) || (c.accessKey && safeEqual(password, c.accessKey))) return;
  throw new WebhookRejected("bad_signature", "Postback credentials do not match.");
}

function parseTime(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function segpayEventFromParams(c: Cfg, p: Record<string, string>, headers: Headers): PaymentEvent {
  authenticate(c, p, headers);
  const action = (field(p, "action") ?? "").toLowerCase();
  const trantype = (field(p, "trantype") ?? "").toLowerCase().replace(/\s+/g, "");
  const stage = (field(p, "stage") ?? "").toLowerCase();
  const approved = (field(p, "approved") ?? "").toLowerCase();
  const tranId = field(p, "tranid");
  const relatedTranId = field(p, "relatedtranid");
  const purchaseId = field(p, "purchaseid");
  const eticket = field(p, "eticketid");
  const transtime = field(p, "transtime");
  if (!action && !trantype) throw new WebhookRejected("malformed", "Missing action and trantype.");
  if (!tranId && !purchaseId) throw new WebhookRejected("malformed", "Missing tranid and purchaseid.");
  const amountCents = Math.abs(parseMoneyCents(field(p, "price", "amount")) ?? 0);
  const currency = (field(p, "currencycode") ?? "usd").toLowerCase();
  const meta = { action, trantype, stage, approved, tranId, relatedTranId, purchaseId, eticket, transtime };

  const isSale = action === "enable" || (trantype === "sale" && (stage === "initial" || stage === ""));
  if (isSale) {
    const providerEventId = `sale:${tranId ?? purchaseId}`;
    if (approved === "no") return { type: "ignored", providerEventId: `declined:${tranId ?? purchaseId}`, raw: "segpay declined sale", metadata: meta };
    const userId = expandUserId(extra(p, "hluser"));
    const itemFromPass = extra(p, "hlitem");
    const sig = extra(p, "hlsig");
    if (!userId || !itemFromPass || !sig) return { type: "ignored", providerEventId, raw: "segpay sale without Hushloom values", metadata: meta };
    if (!safeEqual(sig, passthroughSignature(c.secret, userId, itemFromPass))) throw new WebhookRejected("bad_signature", "Pass-through signature does not match.");
    // The price point Segpay charged decides the item: it must map to exactly the item the pass-through names.
    // An edited x-eticketid, an unmapped price point or a postback without eticketid is never granted.
    if (eticket && !eticket.startsWith(`${c.packageId}:`)) return { type: "ignored", providerEventId, raw: "segpay sale for another package", metadata: meta };
    const pricePointId = eticket?.split(":")[1];
    const mapped = pricePointId ? [...c.pricePoints.entries()].filter(([, v]) => v === pricePointId).map(([k]) => k) : [];
    if (mapped.length === 1 && mapped[0] !== itemFromPass) throw new WebhookRejected("bad_signature", "Pass-through item does not match the price point charged.");
    const item = checkoutItem(itemFromPass);
    if (!item) return { type: "ignored", providerEventId, raw: `unknown item ${itemFromPass}`, metadata: meta };
    const review = !pricePointId
      ? "Segpay sent no price point (eticketid)"
      : mapped.length !== 1
        ? `price point ${pricePointId} is not mapped to exactly one item in SEGPAY_PRICE_POINT_ID`
        : undefined;
    if (item.kind === "plan") {
      return {
        type: "subscription_started",
        providerEventId,
        userId,
        itemKey: item.key,
        providerSubscriptionId: purchaseId ?? tranId!,
        amountCents,
        currency,
        transactionRef: tranId ?? purchaseId!,
        currentPeriodEnd: parseTime(field(p, "nextbilldate")),
        grantsFirstPeriod: true,
        review,
        metadata: meta,
      };
    }
    return { type: "purchase_completed", providerEventId, userId, itemKey: item.key, amountCents, currency, transactionRef: tranId ?? purchaseId!, review, metadata: { ...meta, subscriptionRef: purchaseId } };
  }

  if (trantype === "sale") {
    // Conversion, Rebill and Instantconversion are all period charges on an existing purchase.
    if (approved === "no") return { type: "ignored", providerEventId: `declined:${tranId}`, raw: "segpay declined rebill", metadata: meta };
    return { type: "subscription_renewed", providerEventId: `rebill:${tranId}`, providerSubscriptionId: purchaseId ?? "", amountCents, currency, transactionRef: tranId!, currentPeriodEnd: parseTime(field(p, "nextbilldate")), metadata: meta };
  }
  if (trantype === "credit" || trantype === "void") {
    return { type: "refund", providerEventId: `${trantype}:${tranId}`, transactionRef: relatedTranId ?? tranId!, subscriptionRef: purchaseId, amountCents, currency, metadata: meta };
  }
  if (trantype === "charge") {
    return { type: "chargeback", providerEventId: `chargeback:${tranId}`, transactionRef: relatedTranId ?? tranId!, subscriptionRef: purchaseId, amountCents, currency, metadata: meta };
  }
  if (action === "disable" || action === "cancel" || action === "cancellation") {
    // Cancellation stops rebilling; the pass stays paid until its period ends, when Segpay sends Disable.
    return { type: "subscription_cancelled", providerEventId: `${action}:${purchaseId ?? tranId}`, providerSubscriptionId: purchaseId ?? "", atPeriodEnd: action !== "disable", metadata: meta };
  }
  // Inquiry, Reactivation, CB Reversal, RDRreversal and anything new: recorded, not acted on. An operator re-grants after a reversal by hand.
  return { type: "ignored", providerEventId: `${action || trantype}:${tranId ?? purchaseId}`, raw: `segpay ${action || trantype}`, metadata: meta };
}

export const segpayProvider: PaymentProvider = {
  key: "segpay",
  label: "Segpay",
  isSandbox: false,
  capabilities: { packs: true, subscriptions: true, refunds: true, adultContentAllowed: true },
  isConfigured: () => env().PAYMENT_PROVIDER === "segpay" && cfg() !== null,
  webhookConfigured: () => cfg() !== null,
  configurationProblem() {
    if (env().PAYMENT_PROVIDER !== "segpay") return "PAYMENT_PROVIDER is not segpay.";
    const m = missing();
    return m.length ? `Missing ${m.join(", ")}.` : null;
  },
  async createCheckout({ user, item, successUrl, cancelUrl }) {
    const c = cfg();
    if (!c) throw new Error("segpay not configured");
    const url = segpayCheckoutUrl(c, user, item.key, successUrl, cancelUrl);
    if (!url) throw new Error(`no Segpay price point for ${item.key}; add it to SEGPAY_PRICE_POINT_ID`);
    return { url };
  },
  async verifyWebhook({ rawBody, headers, url }) {
    const c = cfg();
    if (!c) throw new WebhookRejected("unsigned", "Segpay is not configured.");
    let params: Record<string, string>;
    try {
      params = webhookParams(rawBody, headers, url);
    } catch {
      throw new WebhookRejected("malformed", "Body is not valid JSON or form data.");
    }
    return segpayEventFromParams(c, params, headers);
  },
};
