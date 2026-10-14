import { createHash, createHmac } from "node:crypto";
import Stripe from "stripe";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { POST as paymentsWebhook } from "@/app/api/webhooks/payments/[provider]/route";
import { getBalance, listLedger } from "@/server/credits/ledger";
import { closeDb, getDb } from "@/server/db";
import { accountFlags, paymentEvents, subscriptions } from "@/server/db/schema";
import { activePlan } from "@/server/generation/service";
import { compactUserId } from "@/server/payments/providers/segpay";
import { openFlags } from "@/server/payments/service";
import { closeRedis } from "@/server/redis";
import { makeUser, resetDb } from "../helpers";

/**
 * Attacks on the payments fixes for R01 (critical), R02 and R10 (high). Each test tries to get credits or a pass
 * that was not paid for, or to keep credits whose payment was reversed. Tests that pass are regression tests: the
 * fix held. Tests marked `it.fails` reproduce a hole that is still open; each says which one.
 */

// The race tests hold one webhook's transaction open at its audit row so another delivery can run to completion in
// between, the interleaving two concurrent webhook deliveries can produce. Every other call goes straight through.
const gate = vi.hoisted(() => ({ hold: null as null | ((action: string, metadata: Record<string, unknown>) => Promise<void>) }));
vi.mock("@/server/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/audit")>();
  return {
    ...actual,
    audit: async (...args: Parameters<typeof actual.audit>) => {
      if (gate.hold) await gate.hold(args[1], args[4] ?? {});
      return actual.audit(...args);
    },
  };
});

const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const hmac = (secret: string, s: string) => createHmac("sha256", secret).update(s).digest("hex");
const CCBILL_SALT = process.env.CCBILL_SALT!;
const CCBILL_TOKEN = process.env.CCBILL_WEBHOOK_TOKEN!;
const SEGPAY_SECRET = process.env.SEGPAY_POSTBACK_SECRET!;
const STRIPE_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;
const FORM = { "content-type": "application/x-www-form-urlencoded" };

function webhook(provider: string, body: string, opts: { headers?: Record<string, string>; query?: Record<string, string> } = {}, handler = paymentsWebhook) {
  const url = new URL(`http://localhost/api/webhooks/payments/${provider}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  return handler(new NextRequest(url, { method: "POST", body, headers: opts.headers ?? {} }), { params: Promise.resolve({ provider }) });
}

const flagsOf = (userId: string) => getDb().select().from(accountFlags).where(eq(accountFlags.userId, userId));
const subsOf = (userId: string) => getDb().select().from(subscriptions).where(eq(subscriptions.userId, userId));
const eventsOf = (provider: string) => getDb().select().from(paymentEvents).where(eq(paymentEvents.provider, provider));

beforeEach(async () => {
  gate.hold = null;
  await resetDb();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

// ── CCBill ───────────────────────────────────────────────────────────────────

const ccbillSig = (userId: string, itemKey: string) => hmac(CCBILL_SALT, `ccbill:${userId}:${itemKey}`);
const ccbillQuery = (eventType: string) => ({ clientAccnum: "900000", clientSubacc: "0000", eventType, eventGroupType: "Subscription", token: CCBILL_TOKEN });

/** A CCBill webhook whose body keeps the given field order, so a repeated field can be modelled. */
function ccbillRaw(eventType: string, pairs: [string, string][]) {
  const body = new URLSearchParams([["clientAccnum", "900000"], ["clientSubacc", "0000"], ["timestamp", "2026-10-12 20:15:00"], ...pairs]);
  return webhook("ccbill", body.toString(), { headers: FORM, query: ccbillQuery(eventType) });
}
const ccbill = (eventType: string, fields: Record<string, string>) => ccbillRaw(eventType, Object.entries(fields));

/** A digest-valid NewSaleSuccess carrying a pass-through pair this server signed for `itemKey`. */
function ccbillSale(userId: string, itemKey: string, subscriptionId: string, fields: Record<string, string>, echo: [string, string][] = []) {
  return ccbillRaw("NewSaleSuccess", [
    ["subscriptionId", subscriptionId],
    ["transactionId", `txn_${subscriptionId}`],
    ["billedCurrencyCode", "840"],
    ["dynamicPricingValidationDigest", md5(`${subscriptionId}1${CCBILL_SALT}`)],
    ["nextRenewalDate", "2026-11-11"],
    ...Object.entries(fields),
    ["X-hlUser", userId],
    ["X-hlItem", itemKey],
    ["X-hlSig", ccbillSig(userId, itemKey)],
    ...echo,
  ]);
}

// ── Segpay ───────────────────────────────────────────────────────────────────

const segpaySig = (userId: string, itemKey: string) => `s${hmac(SEGPAY_SECRET, `segpay:${userId}:${itemKey}`).slice(0, 31)}`;
const segpay = (fields: Record<string, string>, handler = paymentsWebhook) =>
  webhook("segpay", new URLSearchParams({ transtime: "10/12/2026 8:15:00 PM", ...fields }).toString(), { headers: FORM, query: { key: SEGPAY_SECRET } }, handler);
const PRICE_POINT: Record<string, string> = { pack_small: "20001", pack_medium: "20002", pack_large: "20003", plan_member: "30001", plan_studio: "30002" };
const PRICE: Record<string, string> = { pack_small: "9.99", pack_medium: "44.99", pack_large: "89.99", plan_member: "19.99", plan_studio: "59.99" };
const segpaySale = (userId: string, itemKey: string, tranid: string, purchaseid: string, extra: Record<string, string> = {}, handler = paymentsWebhook) =>
  segpay(
    {
      action: "Transaction",
      stage: "Initial",
      approved: "Yes",
      trantype: "Sale",
      tranid,
      purchaseid,
      eticketid: `100001:${PRICE_POINT[itemKey]}`,
      price: PRICE[itemKey]!,
      currencycode: "USD",
      hluser: compactUserId(userId),
      hlitem: itemKey,
      hlsig: segpaySig(userId, itemKey),
      ...extra,
    },
    handler,
  );
const outcome = (res: Response) => res.headers.get("x-payment-outcome");

// ── Stripe ───────────────────────────────────────────────────────────────────

const stripeSend = (event: object) => {
  const payload = JSON.stringify(event);
  return webhook("stripe", payload, { headers: { "stripe-signature": new Stripe("sk_test_unused").webhooks.generateTestHeaderString({ payload, secret: STRIPE_SECRET }) } });
};
const stripeCheckout = (id: string, userId: string, object: Record<string, unknown>) => ({
  id,
  object: "event",
  type: "checkout.session.completed",
  data: { object: { id: `cs_${id}`, object: "checkout.session", mode: "payment", payment_status: "paid", amount_total: 999, currency: "usd", payment_intent: "pi_atk", metadata: { userId, itemKey: "pack_small" }, ...object } },
});

// ─────────────────────────────────────────────────────────────────────────────
// R01: grant only what the processor actually charged for
// ─────────────────────────────────────────────────────────────────────────────

describe("attack R01: credits for less than the price", () => {
  it("a short billedInitialPrice cannot be topped up by accountingInitialPrice, garbage or a foreign currency", async () => {
    const buyer = await makeUser();
    // The Night Pass monthly form ($19.99) carrying the Studio Pass pair, with a higher accounting price alongside.
    expect(await (await ccbillSale(buyer.id, "plan_studio", "4100000001", { billedInitialPrice: "19.99", accountingInitialPrice: "59.99" })).json()).toMatchObject({ outcome: "ignored" });
    // Price spellings the parser does not take are a missing price, not a match.
    for (const [i, price] of ["59.99abc", "59.990", "5999", "$59.99", "59,99"].entries()) {
      expect(await (await ccbillSale(buyer.id, "plan_studio", `410000001${i}`, { billedInitialPrice: price })).json()).toMatchObject({ outcome: "ignored" });
    }
    // The right number in euros.
    expect(await (await ccbillSale(buyer.id, "plan_studio", "4100000020", { billedInitialPrice: "59.99", billedCurrencyCode: "978" })).json()).toMatchObject({ outcome: "ignored" });
    expect((await getBalance(buyer.id)).available).toBe(0);
    expect(await subsOf(buyer.id)).toHaveLength(0);
    expect((await flagsOf(buyer.id)).every((f) => f.kind === "manual_review")).toBe(true);
    expect(await flagsOf(buyer.id)).toHaveLength(7);
  });

  it("pass-through values that keep their X- prefix cannot overwrite what CCBill billed", async () => {
    const buyer = await makeUser();
    // The buyer appended X-billedInitialPrice=59.99 and X-nextRenewalDate to the Spark form URL; CCBill echoes them back prefixed.
    const res = await ccbillSale(buyer.id, "plan_studio", "4200000001", { billedInitialPrice: "9.99", nextRenewalDate: "" }, [
      ["X-billedInitialPrice", "59.99"],
      ["X-nextRenewalDate", "2099-01-01"],
      ["X-billedCurrencyCode", "840"],
    ]);
    expect(await res.json()).toMatchObject({ outcome: "ignored" });
    expect((await getBalance(buyer.id)).available).toBe(0);
    expect(await activePlan(buyer.id)).toBeNull();
  });

  // HOLE (conditional, unverified against CCBill): the adapter reads pass-through values under their bare names too
  // ("hlUser" for "X-hlUser", see `passthrough` in ccbill.ts), i.e. it allows for CCBill echoing them without the X-
  // prefix. If CCBill does, a buyer who appends X-billedInitialPrice=59.99 to the Night Pass form gets a body with two
  // billedInitialPrice fields, and webhookParams keeps the last one: the echoed value wins over what CCBill billed, and the
  // R01 check passes for a $19.99 payment. Processor fields and buyer-echoed fields share one namespace.
  // Closed: pass-through values are read only under their X- spelling, so the bare pair is not ours and nothing is granted.
  it("HOLE: a pass-through echoed without its X- prefix overrides CCBill's billedInitialPrice", async () => {
    const buyer = await makeUser();
    const res = await ccbillRaw("NewSaleSuccess", [
      ["subscriptionId", "4300000001"],
      ["transactionId", "txn_4300000001"],
      ["billedInitialPrice", "19.99"],
      ["billedCurrencyCode", "840"],
      ["nextRenewalDate", "2026-11-11"],
      ["dynamicPricingValidationDigest", md5(`43000000011${CCBILL_SALT}`)],
      // Echoed pass-through, prefix stripped: the genuine Studio Pass pair plus the buyer's own price.
      ["hlUser", buyer.id],
      ["hlItem", "plan_studio"],
      ["hlSig", ccbillSig(buyer.id, "plan_studio")],
      ["billedInitialPrice", "59.99"],
    ]);
    expect(res.status).toBeLessThan(500);
    expect((await getBalance(buyer.id)).available).toBe(0);
    expect(await activePlan(buyer.id)).toBeNull();
  });

  it("a renewal of a pass that was held for review grants nothing", async () => {
    const buyer = await makeUser();
    expect(await (await ccbillSale(buyer.id, "plan_studio", "4400000001", { billedInitialPrice: "19.99" })).json()).toMatchObject({ outcome: "ignored" });
    const renewal = await ccbill("RenewalSuccess", { subscriptionId: "4400000001", transactionId: "txn_4400000001_r", billedAmount: "59.99", billedCurrencyCode: "840", nextRenewalDate: "2026-12-11" });
    // Recorded and held for the operator beside its pass start (no longer refused with 500 on every retry), never granted.
    expect(renewal.status).toBe(200);
    expect(await renewal.json()).toMatchObject({ outcome: "ignored" });
    expect((await flagsOf(buyer.id)).map((f) => f.kind)).toEqual(["manual_review", "manual_review"]);
    expect((await getBalance(buyer.id)).available).toBe(0);
    expect(await activePlan(buyer.id)).toBeNull();
  });

  // REGRESSION (low): a pass start held for review (R01, R02, R38) leaves no subscriptions row, so every RenewalSuccess
  // the processor bills for it throws "not known yet" and rolls back: 500 forever, the charge never recorded and never
  // put in front of the operator. The R33 path shows the intended handling: record it and hold it for review.
  // Closed: a held pass start records its subscription, and each renewal billed for it is recorded and held the same way.
  it("HOLE: a renewal billed for a held pass is never recorded, only retried with 500", async () => {
    const buyer = await makeUser();
    await ccbillSale(buyer.id, "plan_studio", "4500000001", { billedInitialPrice: "19.99" });
    const renewal = await ccbill("RenewalSuccess", { subscriptionId: "4500000001", transactionId: "txn_4500000001_r", billedAmount: "19.99", billedCurrencyCode: "840" });
    expect(renewal.status).toBe(200);
    const recorded = (await eventsOf("ccbill")).find((e) => e.type === "subscription_renewed");
    expect(recorded).toMatchObject({ userId: buyer.id, amountCents: 1999, credits: null, transactionRef: "txn_4500000001_r" });
    expect(recorded!.metadata).toMatchObject({ reason: "needs_review", itemKey: "plan_studio", subscriptionRef: "4500000001" });
    const flags = await flagsOf(buyer.id);
    expect(flags.map((f) => f.kind)).toEqual(["manual_review", "manual_review"]);
    expect(flags.find((f) => f.details.paymentEventId === recorded!.id)!.details).toMatchObject({ subscriptionRef: "4500000001", amountCents: 1999 });
    expect((await getBalance(buyer.id)).available).toBe(0);
    expect(await activePlan(buyer.id)).toBeNull();
  });

  // HOLE (low, defence in depth): an unknown or missing billedCurrencyCode is read as USD (currencyFromNumeric's
  // fallback), so the currency half of the R01 check passes for a currency it does not know. A buyer cannot change the
  // form's currency (formDigest covers currencyCode), so this needs CCBill to bill in another currency.
  // Closed: an unknown or missing code is recorded as ISO 4217 "XXX" (no currency), which fails the price check and is held.
  it("HOLE: a sale billed in a currency the adapter does not know is treated as USD and granted", async () => {
    const buyer = await makeUser();
    // 752 is SEK: 59.99 SEK is about $5.50.
    const res = await ccbillSale(buyer.id, "plan_studio", "4600000001", { billedInitialPrice: "59.99", billedCurrencyCode: "752" });
    expect(res.status).toBeLessThan(500);
    expect((await getBalance(buyer.id)).available).toBe(0);
    expect(await activePlan(buyer.id)).toBeNull();
    // A sale with no currency code at all is not read as USD either.
    const bare = await ccbillRaw("NewSaleSuccess", [
      ["subscriptionId", "4600000002"],
      ["transactionId", "txn_4600000002"],
      ["billedInitialPrice", "9.99"],
      ["dynamicPricingValidationDigest", md5(`46000000021${CCBILL_SALT}`)],
      ["X-hlUser", buyer.id],
      ["X-hlItem", "pack_small"],
      ["X-hlSig", ccbillSig(buyer.id, "pack_small")],
    ]);
    expect(await bare.json()).toMatchObject({ outcome: "ignored" });
    expect((await getBalance(buyer.id)).available).toBe(0);
    // Both are held for an operator with a currency the payment history can still display, and the code CCBill sent.
    const held = await eventsOf("ccbill");
    expect(held.map((e) => e.currency)).toEqual(["xxx", "xxx"]);
    expect(held.map((e) => e.metadata.currencyCode ?? null).sort()).toEqual(["752", null]);
    expect((await flagsOf(buyer.id)).map((f) => f.kind)).toEqual(["manual_review", "manual_review"]);
  });

  // HOLE (low, defence in depth; Stripe is off by default): the Stripe adapter still substitutes the item's price and
  // currency when the session reports none (`s.amount_total ?? item.priceCents`), the fallback R02 removed from Segpay.
  // The provider-neutral guard then compares the item's price with itself. Stripe sets amount_total on every paid
  // payment-mode session, so this needs a payload without it.
  it.fails("HOLE: a Stripe session without amount_total is taken as paid in full", async () => {
    const s = await makeUser();
    const res = await stripeSend(stripeCheckout("evt_atk_null", s.id, { metadata: { userId: s.id, itemKey: "pack_large" }, amount_total: null, currency: null, payment_intent: "pi_atk_null" }));
    expect(res.status).toBeLessThan(500);
    expect((await getBalance(s.id)).available).toBe(0);
  });

  it("Segpay and Stripe go through the same price guard: short sales, short rebills and short invoices grant nothing", async () => {
    const u = await makeUser();
    // Segpay: the Studio Pass price point, but Segpay reports a smaller charge.
    expect(outcome(await segpaySale(u.id, "plan_studio", "TA1", "PA1", { price: "19.99" }))).toBe("ignored");
    // Segpay: a legitimate Night Pass, then a short rebill and a rebill in another currency.
    expect(outcome(await segpaySale(u.id, "plan_member", "TA2", "PA2"))).toBe("processed");
    expect((await getBalance(u.id)).available).toBe(400);
    expect(outcome(await segpay({ action: "Transaction", trantype: "Sale", stage: "Rebill", approved: "Yes", tranid: "TA3", purchaseid: "PA2", price: "1.99", currencycode: "USD" }))).toBe("ignored");
    expect(outcome(await segpay({ action: "Transaction", trantype: "Sale", stage: "Rebill", approved: "Yes", tranid: "TA4", purchaseid: "PA2", price: "19.99", currencycode: "EUR" }))).toBe("ignored");
    expect((await getBalance(u.id)).available).toBe(400);

    // Stripe: a session that says pack_large but charged $9.99, and one with no amount at all.
    const s = await makeUser();
    expect(await (await stripeSend(stripeCheckout("evt_atk1", s.id, { metadata: { userId: s.id, itemKey: "pack_large" }, payment_intent: "pi_atk1" }))).json()).toMatchObject({ outcome: "ignored" });
    expect(await (await stripeSend(stripeCheckout("evt_atk2", s.id, { metadata: { userId: s.id, itemKey: "pack_large" }, amount_total: 0, payment_intent: "pi_atk2" }))).json()).toMatchObject({ outcome: "ignored" });
    // Stripe: a pass whose invoice was paid short.
    const start = { id: "evt_atk3", object: "event", type: "checkout.session.completed", data: { object: { id: "cs_atk3", object: "checkout.session", mode: "subscription", payment_status: "paid", amount_total: 5999, currency: "usd", subscription: "sub_atk", customer: "cus_atk", metadata: { userId: s.id, itemKey: "plan_studio" } } } };
    expect(await (await stripeSend(start)).json()).toMatchObject({ outcome: "processed" });
    const invoice = { id: "evt_atk4", object: "event", type: "invoice.paid", data: { object: { id: "in_atk", object: "invoice", subscription: "sub_atk", amount_paid: 1999, currency: "usd", payment_intent: "pi_atk4", lines: { data: [] } } } };
    expect(await (await stripeSend(invoice)).json()).toMatchObject({ outcome: "ignored" });
    expect((await getBalance(s.id)).available).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R02: a Segpay sale must name a price point mapped to exactly that item
// ─────────────────────────────────────────────────────────────────────────────

describe("attack R02: Segpay price point", () => {
  it("spellings of eticketid that are not exactly ours are never granted", async () => {
    const u = await makeUser();
    const variants = [
      "100001:020003", // leading zero on the Blaze price point
      "100001: 20003", // whitespace
      "100001:20003 ",
      "100001:", // empty price point
      "100001::20003",
      " 100001:20003", // whitespace before the package
      "1000010:20003", // a package id that starts with ours
      "100001", // package only
      "20003", // price point only
      "100001:99999:20003", // an unknown price point ahead of a known one
    ];
    for (const [i, eticketid] of variants.entries()) {
      const res = await segpaySale(u.id, "pack_large", `TB${i}`, `PB${i}`, { eticketid, price: "9.99" });
      expect(res.status).toBe(200);
      expect(outcome(res)).toBe("ignored");
    }
    expect((await getBalance(u.id)).available).toBe(0);
  });

  it("the Enable membership postback and a JSON body with Basic auth get the same price point check", async () => {
    const u = await makeUser();
    expect(outcome(await segpaySale(u.id, "pack_large", "TC1", "PC1", { action: "Enable", trantype: "", stage: "", eticketid: "100001:99999", price: "9.99" }))).toBe("ignored");
    expect(outcome(await segpaySale(u.id, "pack_large", "TC2", "PC2", { action: "enable", trantype: "", stage: "", eticketid: "", price: "89.99" }))).toBe("ignored");
    const json = await webhook(
      "segpay",
      JSON.stringify({ action: "Transaction", stage: "Initial", approved: "Yes", trantype: "Sale", tranid: "TC3", purchaseid: "PC3", eticketid: "100001:99999", price: "89.99", currencycode: "USD", hluser: compactUserId(u.id), hlitem: "pack_large", hlsig: segpaySig(u.id, "pack_large") }),
      { headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`segpay:${SEGPAY_SECRET}`).toString("base64")}` } },
    );
    expect(outcome(json)).toBe("ignored");
    // A price point mapped to another item is refused outright, whatever the postback says it cost.
    const other = await segpaySale(u.id, "pack_large", "TC4", "PC4", { eticketid: "100001:20001", price: "89.99" });
    expect(other.status).toBe(400);
    expect((await getBalance(u.id)).available).toBe(0);
  });

  it("a price point the operator mapped to two items proves neither", async () => {
    vi.stubEnv("SEGPAY_PRICE_POINT_ID", "pack_small=20001,pack_large=20001,plan_member=30001");
    vi.resetModules();
    try {
      const { POST: fresh } = await import("@/app/api/webhooks/payments/[provider]/route");
      const u = await makeUser();
      const res = await segpaySale(u.id, "pack_large", "TD1", "PD1", { eticketid: "100001:20001", price: "89.99" }, fresh);
      expect(outcome(res)).toBe("ignored");
      expect((await getBalance(u.id)).available).toBe(0);
      expect((await flagsOf(u.id)).map((f) => f.kind)).toEqual(["manual_review"]);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("a first charge that arrives as a conversion or rebill for an unknown purchase grants nothing", async () => {
    const u = await makeUser();
    for (const stage of ["Instantconversion", "Conversion", "Rebill"]) {
      const res = await segpay({ action: "Transaction", trantype: "Sale", stage, approved: "Yes", tranid: `TE_${stage}`, purchaseid: "PE1", eticketid: "100001:30002", price: "59.99", currencycode: "USD", hluser: compactUserId(u.id), hlitem: "plan_studio", hlsig: segpaySig(u.id, "plan_studio") });
      expect(res.status).toBe(500);
    }
    expect((await getBalance(u.id)).available).toBe(0);
    expect(await activePlan(u.id)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R10: reversals that overtake their purchase
// ─────────────────────────────────────────────────────────────────────────────

describe("attack R10: reversals that overtake their purchase", () => {
  it("a Segpay Credit naming its sale by relatedtranid is applied when the sale lands", async () => {
    const u = await makeUser();
    const credit = await segpay({ action: "Transaction", trantype: "Credit", stage: "Initial", approved: "Yes", tranid: "TF2", relatedtranid: "TF1", purchaseid: "PF1", price: "89.99", currencycode: "USD" });
    expect(outcome(credit)).toBe("ignored");
    expect(outcome(await segpaySale(u.id, "pack_large", "TF1", "PF1"))).toBe("processed");
    expect((await getBalance(u.id)).available).toBe(0);
  });

  it("a Stripe refund ahead of its checkout session is applied when the session lands", async () => {
    const u = await makeUser();
    const refund = { id: "evt_rf_early", object: "event", type: "charge.refunded", data: { object: { id: "ch_early", object: "charge", payment_intent: "pi_early", amount: 999, amount_refunded: 999, currency: "usd" } } };
    expect(await (await stripeSend(refund)).json()).toMatchObject({ outcome: "ignored" });
    expect(await (await stripeSend(stripeCheckout("evt_cs_late", u.id, { payment_intent: "pi_early" }))).json()).toMatchObject({ outcome: "processed" });
    expect((await getBalance(u.id)).available).toBe(0);
  });

  it("an early refund and an early chargeback of one sale, each delivered twice, take it back once and flag the account", async () => {
    const u = await makeUser();
    for (let i = 0; i < 2; i++) {
      await ccbill("Refund", { subscriptionId: "4700000001", transactionId: "txn_4700000001", amount: "89.99", currencyCode: "840" });
      await ccbill("Chargeback", { subscriptionId: "4700000001", transactionId: "txn_4700000001", amount: "89.99", currencyCode: "840" });
    }
    expect(await (await ccbillSale(u.id, "pack_large", "4700000001", { billedInitialPrice: "89.99" })).json()).toMatchObject({ outcome: "processed" });
    expect((await getBalance(u.id)).available).toBe(0);
    const ledger = await listLedger(u.id);
    expect(ledger.filter((l) => l.kind === "refund" || l.kind === "chargeback").reduce((n, l) => n + l.availableDelta, 0)).toBe(-1200);
    expect((await openFlags(u.id)).map((f) => f.kind)).toEqual(["chargeback"]);
    // Redelivering the sale after that changes nothing.
    expect(await (await ccbillSale(u.id, "pack_large", "4700000001", { billedInitialPrice: "89.99" })).json()).toMatchObject({ outcome: "duplicate" });
    expect((await getBalance(u.id)).available).toBe(0);
  });

  it("an early partial refund takes back its share when the sale lands", async () => {
    const u = await makeUser();
    await ccbill("Refund", { subscriptionId: "4800000001", transactionId: "txn_4800000001", amount: "45.00", currencyCode: "840" });
    await ccbillSale(u.id, "pack_large", "4800000001", { billedInitialPrice: "89.99" });
    // ceil(1200 * 4500 / 8999) = 601
    expect((await getBalance(u.id)).available).toBe(1200 - 601);
  });

  it("an early chargeback whose sale is held for review is not spent on the buyer's next, different sale", async () => {
    const u = await makeUser();
    await ccbill("Chargeback", { subscriptionId: "4900000001", transactionId: "txn_4900000001", amount: "9.99", currencyCode: "840" });
    // The sale it reverses lands short and is held: nothing granted, nothing to take back.
    expect(await (await ccbillSale(u.id, "pack_large", "4900000001", { billedInitialPrice: "9.99" })).json()).toMatchObject({ outcome: "ignored" });
    // A different, properly paid sale is not charged for it.
    expect(await (await ccbillSale(u.id, "pack_small", "4900000002", { billedInitialPrice: "9.99" })).json()).toMatchObject({ outcome: "processed" });
    expect((await getBalance(u.id)).available).toBe(100);
  });

  // HOLE: findCreditedEvent falls back to the subscription / purchase id, so a reversal of a rebill that overtakes that
  // rebill is not kept pending: it is applied to the pass's first charge instead. The rebill then lands and grants in full,
  // and a later reversal of the first charge owes nothing ("already reversed"). Both charges are refunded and the buyer
  // keeps a period's credits. Segpay's relatedtranid is documented as the original transaction, so this is the expected
  // shape of a Credit for a rebill; the same fallback exists for CCBill and the sandbox.
  it.fails("HOLE: a refund of a rebill that overtakes the rebill is taken from the first charge, and the rebill still grants", async () => {
    const u = await makeUser();
    expect(outcome(await segpaySale(u.id, "plan_member", "TG1", "PG1"))).toBe("processed");
    expect((await getBalance(u.id)).available).toBe(400);
    // Segpay rebills TG2, the postback fails (deploy, timeout) and is queued for retry; the rebill is refunded meanwhile.
    expect((await segpay({ action: "Transaction", trantype: "Credit", stage: "Rebill", approved: "Yes", tranid: "TG3", relatedtranid: "TG2", purchaseid: "PG1", price: "19.99", currencycode: "USD" })).status).toBe(200);
    // The rebill postback is retried and lands.
    expect((await segpay({ action: "Transaction", trantype: "Sale", stage: "Rebill", approved: "Yes", tranid: "TG2", purchaseid: "PG1", price: "19.99", currencycode: "USD" })).status).toBe(200);
    // The first charge is refunded too.
    expect((await segpay({ action: "Transaction", trantype: "Credit", stage: "Initial", approved: "Yes", tranid: "TG4", relatedtranid: "TG1", purchaseid: "PG1", price: "19.99", currencycode: "USD" })).status).toBe(200);
    // Both charges were refunded: nothing paid, so nothing kept.
    expect((await getBalance(u.id)).available).toBe(0);
  });

  /** Holds the first matching audit write (and so its open transaction) until `release` is called. */
  function holdAt(action: string, outcomeWanted: string) {
    let reached!: () => void;
    let release!: () => void;
    const atHold = new Promise<void>((r) => (reached = r));
    const released = new Promise<void>((r) => (release = r));
    let used = false;
    gate.hold = async (a, meta) => {
      if (used || a !== action || meta.outcome !== outcomeWanted) return;
      used = true;
      reached();
      await released;
    };
    return { atHold, release };
  }
  const settle = <T>(p: Promise<T>, ms: number) => Promise.race([p.then(() => "done" as const), new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))]);

  // HOLE: the reversal path and the purchase path share no lock. A reversal whose transaction has looked for its purchase
  // (not committed yet, so not found) but not committed, and a purchase whose transaction looks for pending reversals
  // (the reversal is not committed yet, so none) both commit: the reversal stays pending for good and the purchase keeps
  // its credits. This is R10's own scenario (a sale retried after a 5xx and its refund) with the two deliveries in flight
  // together. Under READ COMMITTED neither SELECT sees the other's uncommitted row; FOR UPDATE does not wait for them.
  it.fails("HOLE: a refund and its sale processed at the same time leave the refund pending and the credits granted", async () => {
    const u = await makeUser();
    const { atHold, release } = holdAt("payment.refund", "ignored");
    const sendRefund = () => ccbill("Refund", { subscriptionId: "5000000001", transactionId: "txn_5000000001", amount: "89.99", currencyCode: "840" });
    const refund = sendRefund();
    await Promise.race([atHold, refund]); // the refund looked for its sale, found none, and is about to commit as pending
    const sale = ccbillSale(u.id, "pack_large", "5000000001", { billedInitialPrice: "89.99" });
    await settle(sale, 5000); // today the sale finishes here without waiting for the refund
    release();
    await Promise.all([refund, sale]);
    // The processor redelivers whatever it did not see acknowledged; an acknowledged one comes back as a duplicate.
    await sendRefund();
    await ccbillSale(u.id, "pack_large", "5000000001", { billedInitialPrice: "89.99" });
    expect((await getBalance(u.id)).available).toBe(0);
  });

  it.fails("HOLE: a cancellation and its pass start processed at the same time leave the pass active", async () => {
    const u = await makeUser();
    const { atHold, release } = holdAt("payment.subscription_cancelled", "ignored");
    const sendExpiration = () => ccbill("Expiration", { subscriptionId: "5100000001", timestamp: "2026-10-12 20:16:00" });
    const expiration = sendExpiration();
    await Promise.race([atHold, expiration]);
    const start = ccbillSale(u.id, "plan_member", "5100000001", { billedInitialPrice: "19.99" });
    await settle(start, 5000);
    release();
    await Promise.all([expiration, start]);
    await sendExpiration();
    await ccbillSale(u.id, "plan_member", "5100000001", { billedInitialPrice: "19.99" });
    expect(await activePlan(u.id)).toBeNull();
  });

  it("the same refund and sale delivered one after the other, either way round, end with the credits taken back", async () => {
    const u = await makeUser();
    await ccbill("Refund", { subscriptionId: "5200000001", transactionId: "txn_5200000001", amount: "89.99", currencyCode: "840" });
    await ccbillSale(u.id, "pack_large", "5200000001", { billedInitialPrice: "89.99" });
    expect((await getBalance(u.id)).available).toBe(0);
    const v = await makeUser();
    await ccbillSale(v.id, "pack_large", "5200000002", { billedInitialPrice: "89.99" });
    await ccbill("Refund", { subscriptionId: "5200000002", transactionId: "txn_5200000002", amount: "89.99", currencyCode: "840" });
    expect((await getBalance(v.id)).available).toBe(0);
    expect((await eventsOf("ccbill")).filter((e) => e.type === "refund" && e.metadata.pending === true)).toHaveLength(0);
  });
});
