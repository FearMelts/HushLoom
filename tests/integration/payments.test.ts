import { createHash, createHmac } from "node:crypto";
import Stripe from "stripe";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { POST as sandboxRoute } from "@/app/api/pricing/sandbox/route";
import { POST as paymentsWebhook } from "@/app/api/webhooks/payments/[provider]/route";
import { adjustCredits } from "@/server/admin";
import { createSession } from "@/server/auth/session";
import { getBalance, listLedger } from "@/server/credits/ledger";
import { closeDb, getDb } from "@/server/db";
import { accountFlags, auditLogs, creditAccounts, paymentEvents, subscriptions } from "@/server/db/schema";
import { paymentsStatus, providerByKey, startCheckout } from "@/server/payments";
import { compactUserId } from "@/server/payments/providers/segpay";
import { readSandboxToken, SANDBOX_SIGNATURE_HEADER, signSandboxBody, type SandboxBody } from "@/server/payments/providers/sandbox";
import { clearFlag, listFlags, openFlags } from "@/server/payments/service";
import { closeRedis } from "@/server/redis";
import { key, makeUser, resetDb } from "../helpers";

// The sandbox "processor" route needs a signed-in person; the session cookie is faked here.
const session = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "hl_session" && session.token ? { value: session.token } : undefined) }),
  headers: async () => new Headers(),
}));

const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const hmac = (secret: string, s: string) => createHmac("sha256", secret).update(s).digest("hex");
const CCBILL_SALT = process.env.CCBILL_SALT!;
const CCBILL_TOKEN = process.env.CCBILL_WEBHOOK_TOKEN!;
const SEGPAY_SECRET = process.env.SEGPAY_POSTBACK_SECRET!;
const STRIPE_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;

function webhook(provider: string, body: string, opts: { headers?: Record<string, string>; query?: Record<string, string> } = {}) {
  const url = new URL(`http://localhost/api/webhooks/payments/${provider}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  return paymentsWebhook(new NextRequest(url, { method: "POST", body, headers: opts.headers ?? {} }), { params: Promise.resolve({ provider }) });
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const FORM = { "content-type": "application/x-www-form-urlencoded" };

async function events(provider: string) {
  return getDb().select().from(paymentEvents).where(eq(paymentEvents.provider, provider));
}
async function flagsOf(userId: string) {
  return getDb().select().from(accountFlags).where(eq(accountFlags.userId, userId));
}

beforeEach(async () => {
  session.token = "";
  await resetDb();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

// ── Sandbox ──────────────────────────────────────────────────────────────────

describe("sandbox provider", () => {
  const send = (body: Partial<SandboxBody> & { kind: SandboxBody["kind"]; eventId: string }, opts: { signature?: string | null; raw?: string } = {}) => {
    const raw = opts.raw ?? JSON.stringify({ amountCents: 999, currency: "usd", transactionRef: "sbx_txn_1", ...body });
    const sig = opts.signature === undefined ? signSandboxBody(raw) : opts.signature;
    return webhook("sandbox", raw, { headers: { "content-type": "application/json", ...(sig ? { [SANDBOX_SIGNATURE_HEADER]: sig } : {}) } });
  };
  const sale = (userId: string, eventId = "sbx_sale_1", itemKey = "pack_small", extra: Partial<SandboxBody> = {}) => send({ kind: "sale", eventId, userId, itemKey, ...extra });

  it("is the default, labels itself, and sends checkout to the sandbox page", async () => {
    const u = await makeUser();
    expect(paymentsStatus()).toMatchObject({ provider: "sandbox", isSandbox: true, configured: true });
    const { url, isSandbox } = await startCheckout(u, "pack_small");
    expect(isSandbox).toBe(true);
    const t = new URL(url).searchParams.get("t");
    expect(url.startsWith("http://localhost:3000/pricing/sandbox?t=")).toBe(true);
    expect(readSandboxToken(t)).toMatchObject({ userId: u.id, itemKey: "pack_small" });
    expect(readSandboxToken(`${t}x`)).toBeNull();
    await expect(startCheckout(u, "pack_unknown")).rejects.toMatchObject({ status: 422, code: "unknown_item" });
  });

  it("grants a pack exactly once when the webhook is delivered twice", async () => {
    const u = await makeUser();
    const first = await sale(u.id);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ outcome: "processed" });
    expect(await (await sale(u.id)).json()).toMatchObject({ outcome: "duplicate" });
    expect((await getBalance(u.id)).available).toBe(100);
    expect((await listLedger(u.id)).filter((l) => l.kind === "purchase")).toHaveLength(1);
    const rows = await events("sandbox");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ providerEventId: "sbx_sale_1", type: "purchase_completed", transactionRef: "sbx_txn_1", credits: 100, amountCents: 999, userId: u.id });
    expect(rows[0]!.metadata).toMatchObject({ itemKey: "pack_small", sandbox: true });
    expect(rows[0]!.processedAt).not.toBeNull();
    const audit = await getDb().select().from(auditLogs).where(eq(auditLogs.action, "payment.purchase_completed"));
    expect(audit).toHaveLength(1);
  });

  it("rejects unsigned, badly signed, stale and malformed events without touching anything", async () => {
    const u = await makeUser();
    expect((await sale(u.id, "sbx_x1")).status).toBe(200); // control: a signed one works
    const none = await send({ kind: "sale", eventId: "sbx_x2", userId: u.id, itemKey: "pack_small" }, { signature: null });
    expect(none.status).toBe(400);
    expect(await none.json()).toMatchObject({ error: { code: "unsigned" } });
    const bad = await send({ kind: "sale", eventId: "sbx_x3", userId: u.id, itemKey: "pack_small" }, { signature: "t=1,v1=deadbeef" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "bad_signature" } });
    const raw = JSON.stringify({ kind: "sale", eventId: "sbx_x4", userId: u.id, itemKey: "pack_small", amountCents: 999, currency: "usd", transactionRef: "t" });
    const stale = await send({ kind: "sale", eventId: "sbx_x4" }, { raw, signature: signSandboxBody(raw, Date.now() - 11 * 60_000) });
    expect(stale.status).toBe(400);
    expect(await stale.json()).toMatchObject({ error: { code: "replayed" } });
    const malformed = await send({ kind: "sale", eventId: "m" }, { raw: "{not json", signature: signSandboxBody("{not json") });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: "malformed" } });
    expect((await getBalance(u.id)).available).toBe(100);
    expect(await events("sandbox")).toHaveLength(1);
  });

  it("a refund claws the credits back through the ledger, once", async () => {
    const u = await makeUser();
    await sale(u.id);
    const r = await send({ kind: "refund", eventId: "sbx_refund_1" });
    expect(await r.json()).toMatchObject({ outcome: "processed" });
    expect((await getBalance(u.id)).available).toBe(0);
    const ledger = await listLedger(u.id);
    const refund = ledger.find((l) => l.kind === "refund");
    expect(refund).toMatchObject({ availableDelta: -100, reservedDelta: 0, availableAfter: 0, idempotencyKey: "refund:sandbox:sbx_refund_1" });
    const [row] = (await events("sandbox")).filter((e) => e.type === "refund");
    expect(row).toMatchObject({ credits: -100, amountCents: -999, userId: u.id, transactionRef: "sbx_txn_1" });
    expect(row!.metadata).toMatchObject({ creditsReversed: 100, shortfall: 0 });
    expect(refund!.paymentEventId).toBe(row!.id);
    expect(await (await send({ kind: "refund", eventId: "sbx_refund_1" })).json()).toMatchObject({ outcome: "duplicate" });
    expect((await getBalance(u.id)).available).toBe(0);
    expect(await flagsOf(u.id)).toHaveLength(0);
  });

  it("partial refunds claw back pro rata and never more than was granted", async () => {
    const u = await makeUser();
    await sale(u.id, "sbx_sale_m", "pack_medium", { amountCents: 4499, transactionRef: "sbx_txn_m" });
    expect((await getBalance(u.id)).available).toBe(550);
    await send({ kind: "refund", eventId: "sbx_pr_1", amountCents: 2000, transactionRef: "sbx_txn_m" });
    expect((await getBalance(u.id)).available).toBe(550 - Math.ceil((550 * 2000) / 4499));
    await send({ kind: "refund", eventId: "sbx_pr_2", amountCents: 2499, transactionRef: "sbx_txn_m" });
    expect((await getBalance(u.id)).available).toBe(0);
    await send({ kind: "refund", eventId: "sbx_pr_3", amountCents: 4499, transactionRef: "sbx_txn_m" });
    expect((await getBalance(u.id)).available).toBe(0);
    expect((await listLedger(u.id)).filter((l) => l.kind === "refund")).toHaveLength(2);
  });

  it("a chargeback flags the account and blocks checkout until an admin clears the flag", async () => {
    const u = await makeUser();
    const admin = await makeUser({ role: "admin" });
    await sale(u.id);
    const cb = await send({ kind: "chargeback", eventId: "sbx_cb_1" });
    expect(await cb.json()).toMatchObject({ outcome: "processed" });
    expect((await getBalance(u.id)).available).toBe(0);
    expect((await listLedger(u.id)).find((l) => l.kind === "chargeback")).toMatchObject({ availableDelta: -100 });
    const open = await openFlags(u.id);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: "chargeback" });
    await expect(startCheckout(u, "pack_small")).rejects.toMatchObject({ status: 403, code: "account_flagged" });
    expect(await getDb().select().from(auditLogs).where(eq(auditLogs.action, "payment.chargeback"))).toHaveLength(1);

    const listed = await listFlags();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ kind: "chargeback", user: { id: u.id, handle: u.handle } });
    await clearFlag(admin.id, open[0]!.id, "spoke to the customer");
    await expect(clearFlag(admin.id, open[0]!.id, "again")).rejects.toMatchObject({ status: 404 });
    expect(await openFlags(u.id)).toHaveLength(0);
    expect((await startCheckout(u, "pack_small")).url).toContain("/pricing/sandbox");
    expect(await getDb().select().from(auditLogs).where(eq(auditLogs.action, "flag.clear"))).toHaveLength(1);
  });

  it("R18: two reversals of one payment processed at the same time claw the grant back once", async () => {
    const u = await makeUser();
    const admin = await makeUser({ role: "admin" });
    await sale(u.id, "sbx_sale_c", "pack_medium", { amountCents: 4499, transactionRef: "sbx_txn_c" });
    await adjustCredits(admin.id, { account: u.handle, amount: 450, reason: "credits from elsewhere", idempotencyKey: key() });
    expect((await getBalance(u.id)).available).toBe(1000);

    // Hold the account row so both reversals get as far as they can before either moves credits.
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = getDb().transaction(async (tx) => {
      await tx.select().from(creditAccounts).where(eq(creditAccounts.userId, u.id)).for("update");
      locked();
      await released;
    });
    await isLocked;
    const both = Promise.all([
      send({ kind: "refund", eventId: "sbx_c_refund", transactionRef: "sbx_txn_c", amountCents: 4499 }),
      send({ kind: "chargeback", eventId: "sbx_c_cb", transactionRef: "sbx_txn_c", amountCents: 4499 }),
    ]);
    const waiting = async () =>
      (await getDb().execute<{ n: number }>(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`))[0]!.n;
    for (let i = 0; i < 200 && (await waiting()) < 2; i++) await new Promise((r) => setTimeout(r, 25));
    expect(await waiting()).toBe(2);
    release();
    await holder;
    for (const res of await both) expect(res.status).toBe(200);

    expect((await getBalance(u.id)).available).toBe(450);
    const reversals = (await events("sandbox")).filter((e) => e.type === "refund" || e.type === "chargeback");
    expect(reversals.reduce((sum, e) => sum + (e.credits ?? 0), 0)).toBe(-550);
    expect((await flagsOf(u.id)).map((f) => f.kind)).toEqual(["chargeback"]);
  });

  it("records a credit_debt flag when the refunded credits were already spent", async () => {
    const u = await makeUser();
    const admin = await makeUser({ role: "admin" });
    await sale(u.id);
    await adjustCredits(admin.id, { account: u.handle, amount: -60, reason: "spent in a test", idempotencyKey: key() });
    expect((await getBalance(u.id)).available).toBe(40);
    await send({ kind: "refund", eventId: "sbx_refund_short" });
    expect((await getBalance(u.id)).available).toBe(0);
    const [row] = (await events("sandbox")).filter((e) => e.type === "refund");
    expect(row!.metadata).toMatchObject({ creditsReversed: 40, shortfall: 60 });
    expect(row!.credits).toBe(-40);
    const flags = await flagsOf(u.id);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ kind: "credit_debt" });
    expect(flags[0]!.details).toMatchObject({ shortfall: 60, reversed: 40 });
    // A debt is for an operator to look at; it does not stop the person buying again.
    expect((await startCheckout(u, "pack_small")).url).toContain("/pricing/sandbox");
  });

  it("R01: a payment short of the price or in another currency grants nothing, whatever the processor, and goes to manual review", async () => {
    const u = await makeUser();
    expect(await (await sale(u.id, "sbx_short_1", "pack_large", { amountCents: 999, transactionRef: "sbx_txn_s1" })).json()).toMatchObject({ outcome: "ignored" });
    expect(await (await sale(u.id, "sbx_short_2", "plan_studio", { amountCents: 1999, transactionRef: "sbx_txn_s2", subscriptionRef: "sbx_sub_s2" })).json()).toMatchObject({ outcome: "ignored" });
    expect(await (await sale(u.id, "sbx_short_3", "pack_small", { currency: "eur", transactionRef: "sbx_txn_s3" })).json()).toMatchObject({ outcome: "ignored" });
    expect((await getBalance(u.id)).available).toBe(0);
    expect(await getDb().select().from(subscriptions).where(eq(subscriptions.userId, u.id))).toHaveLength(0);
    expect((await flagsOf(u.id)).map((f) => f.kind)).toEqual(["manual_review", "manual_review", "manual_review"]);
    const held = (await events("sandbox")).find((e) => e.providerEventId === "sbx_short_1");
    expect(held).toMatchObject({ userId: u.id, amountCents: 999, credits: null });
    expect(held!.metadata).toMatchObject({ reason: "needs_review", itemKey: "pack_large" });

    // A renewal paid short grants nothing either.
    await sale(u.id, "sbx_plan_ok", "plan_member", { amountCents: 1999, transactionRef: "sbx_txn_ok", subscriptionRef: "sbx_sub_ok" });
    expect((await getBalance(u.id)).available).toBe(400);
    const shortRenewal = await send({ kind: "renewal", eventId: "sbx_renew_short", amountCents: 999, transactionRef: "sbx_txn_r", subscriptionRef: "sbx_sub_ok" });
    expect(await shortRenewal.json()).toMatchObject({ outcome: "ignored" });
    expect((await getBalance(u.id)).available).toBe(400);
    expect((await flagsOf(u.id)).filter((f) => f.kind === "manual_review")).toHaveLength(4);
  });

  it("R10: a refund or chargeback that arrives before its purchase is kept and applied when the purchase lands, once", async () => {
    const u = await makeUser();
    const early = await send({ kind: "refund", eventId: "sbx_early_refund", transactionRef: "sbx_txn_e1" });
    expect(early.status).toBe(200);
    expect(await early.json()).toMatchObject({ outcome: "ignored" });
    expect(await (await sale(u.id, "sbx_late_sale", "pack_small", { transactionRef: "sbx_txn_e1" })).json()).toMatchObject({ outcome: "processed" });
    expect((await getBalance(u.id)).available).toBe(0);
    expect((await listLedger(u.id)).find((l) => l.kind === "refund")).toMatchObject({ availableDelta: -100, idempotencyKey: "refund:sandbox:sbx_early_refund" });
    const [refundRow] = (await events("sandbox")).filter((e) => e.type === "refund");
    expect(refundRow).toMatchObject({ userId: u.id, credits: -100, amountCents: -999 });
    expect(refundRow!.metadata).toMatchObject({ pending: false, creditsReversed: 100 });
    // Redeliveries of either change nothing.
    expect(await (await send({ kind: "refund", eventId: "sbx_early_refund", transactionRef: "sbx_txn_e1" })).json()).toMatchObject({ outcome: "duplicate" });
    expect(await (await sale(u.id, "sbx_late_sale", "pack_small", { transactionRef: "sbx_txn_e1" })).json()).toMatchObject({ outcome: "duplicate" });
    expect((await getBalance(u.id)).available).toBe(0);
    expect((await listLedger(u.id)).filter((l) => l.kind === "refund")).toHaveLength(1);

    // A chargeback ahead of its sale flags the account once the sale is known.
    const u2 = await makeUser();
    await send({ kind: "chargeback", eventId: "sbx_early_cb", transactionRef: "sbx_txn_e3" });
    await sale(u2.id, "sbx_late_sale_2", "pack_small", { transactionRef: "sbx_txn_e3" });
    expect((await getBalance(u2.id)).available).toBe(0);
    expect((await openFlags(u2.id)).map((f) => f.kind)).toEqual(["chargeback"]);
    await expect(startCheckout(u2, "pack_small")).rejects.toMatchObject({ status: 403, code: "account_flagged" });

    // A cancellation ahead of its pass start leaves the pass ended.
    const u3 = await makeUser();
    await send({ kind: "cancel", eventId: "sbx_early_cancel", subscriptionRef: "sbx_sub_e4" });
    await sale(u3.id, "sbx_late_plan", "plan_member", { amountCents: 1999, transactionRef: "sbx_txn_e4", subscriptionRef: "sbx_sub_e4" });
    const [sub] = await getDb().select().from(subscriptions).where(eq(subscriptions.userId, u3.id));
    expect(sub!.status).toBe("canceled");
  });

  it("starts a pass, grants each renewal once, and ends it on cancellation", async () => {
    const u = await makeUser();
    await sale(u.id, "sbx_plan_1", "plan_member", { amountCents: 1999, transactionRef: "sbx_txn_p1", subscriptionRef: "sbx_sub_1" });
    expect((await getBalance(u.id)).available).toBe(400);
    const [sub] = await getDb().select().from(subscriptions).where(eq(subscriptions.userId, u.id));
    expect(sub).toMatchObject({ provider: "sandbox", providerSubscriptionId: "sbx_sub_1", planKey: "plan_member", status: "active" });
    const renew = () => send({ kind: "renewal", eventId: "sbx_renew_1", amountCents: 1999, transactionRef: "sbx_txn_p2", subscriptionRef: "sbx_sub_1" });
    expect(await (await renew()).json()).toMatchObject({ outcome: "processed" });
    expect(await (await renew()).json()).toMatchObject({ outcome: "duplicate" });
    expect((await getBalance(u.id)).available).toBe(800);
    const unknown = await send({ kind: "renewal", eventId: "sbx_renew_x", subscriptionRef: "sbx_sub_missing", transactionRef: "x" });
    expect(unknown.status).toBe(500);
    await send({ kind: "cancel", eventId: "sbx_cancel_1", subscriptionRef: "sbx_sub_1" });
    const [after] = await getDb().select().from(subscriptions).where(eq(subscriptions.userId, u.id));
    expect(after!.status).toBe("canceled");
    // Refunding a renewal finds that renewal's own grant.
    await send({ kind: "refund", eventId: "sbx_refund_p2", amountCents: 1999, transactionRef: "sbx_txn_p2" });
    expect((await getBalance(u.id)).available).toBe(400);
  });

  it("the sandbox page's buttons run checkout → webhook → ledger for the signed-in person only", async () => {
    const u = await makeUser();
    const other = await makeUser();
    session.token = (await createSession(u.id, null)).token;
    const post = (body: Record<string, unknown>) => sandboxRoute(new NextRequest("http://localhost/api/pricing/sandbox", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), undefined as never);
    const { url } = await startCheckout(u, "pack_small");
    const token = new URL(url).searchParams.get("t")!;
    const done = await post({ action: "complete", token });
    expect(done.status).toBe(200);
    const { outcome, transactionRef, next } = (await done.json()) as { outcome: string; transactionRef: string; next: string };
    expect(outcome).toBe("processed");
    expect(next).toBe("/pricing?checkout=success");
    expect((await getBalance(u.id)).available).toBe(100);

    const foreign = new URL((await startCheckout(other, "pack_small")).url).searchParams.get("t")!;
    expect((await post({ action: "complete", token: foreign })).status).toBe(403);
    expect((await post({ action: "fail", token })).status).toBe(200);
    expect((await getBalance(u.id)).available).toBe(100);

    expect((await post({ action: "refund", transactionRef: "not-mine" })).status).toBe(404);
    expect(await (await post({ action: "refund", transactionRef })).json()).toMatchObject({ outcome: "processed" });
    expect((await getBalance(u.id)).available).toBe(0);
    expect(await (await post({ action: "chargeback", transactionRef })).json()).toMatchObject({ outcome: "processed" });
    expect((await openFlags(u.id)).map((f) => f.kind)).toEqual(["chargeback"]);
  });
});

// ── Stripe ───────────────────────────────────────────────────────────────────

describe("stripe provider", () => {
  const sign = (payload: string, secret = STRIPE_SECRET) => new Stripe("sk_test_unused").webhooks.generateTestHeaderString({ payload, secret });
  const send = (event: object, signature?: string) => {
    const payload = JSON.stringify(event);
    return webhook("stripe", payload, { headers: { "stripe-signature": signature ?? sign(payload) } });
  };
  const checkout = (id: string, userId: string) => ({
    id,
    object: "event",
    type: "checkout.session.completed",
    data: { object: { id: `cs_${id}`, object: "checkout.session", mode: "payment", payment_status: "paid", amount_total: 999, currency: "usd", payment_intent: "pi_1", metadata: { userId, itemKey: "pack_small" } } },
  });

  it("is off unless chosen, and says why", () => {
    const stripe = providerByKey("stripe")!;
    expect(stripe.isConfigured()).toBe(false);
    expect(stripe.capabilities.adultContentAllowed).toBe(false);
    expect(stripe.configurationProblem()).toMatch(/PAYMENT_PROVIDER/);
    expect(stripe.webhookConfigured()).toBe(true);
  });

  it("verifies on the generic route, grants once, and rejects a forged signature", async () => {
    const u = await makeUser();
    expect(await (await send(checkout("evt_g1", u.id))).json()).toMatchObject({ outcome: "processed" });
    expect(await (await send(checkout("evt_g1", u.id))).json()).toMatchObject({ outcome: "duplicate" });
    const forged = await send(checkout("evt_g2", u.id), "t=1,v1=deadbeef");
    expect(forged.status).toBe(400);
    expect(await forged.json()).toMatchObject({ error: { code: "bad_signature" } });
    const unsigned = await webhook("stripe", JSON.stringify(checkout("evt_g3", u.id)));
    expect(await unsigned.json()).toMatchObject({ error: { code: "unsigned" } });
    expect((await getBalance(u.id)).available).toBe(100);
    const [row] = await events("stripe");
    expect(row).toMatchObject({ transactionRef: "pi_1", credits: 100 });
  });

  it("charge.refunded claws back and charge.dispute.created flags the account", async () => {
    const u = await makeUser();
    await send(checkout("evt_r0", u.id));
    const refund = { id: "evt_r1", object: "event", type: "charge.refunded", data: { object: { id: "ch_1", object: "charge", payment_intent: "pi_1", amount: 999, amount_refunded: 999, currency: "usd" } } };
    expect(await (await send(refund)).json()).toMatchObject({ outcome: "processed" });
    expect((await getBalance(u.id)).available).toBe(0);
    expect((await listLedger(u.id)).find((l) => l.kind === "refund")).toMatchObject({ availableDelta: -100, idempotencyKey: "refund:stripe:evt_r1" });
    const dispute = { id: "evt_d1", object: "event", type: "charge.dispute.created", data: { object: { id: "dp_1", object: "dispute", charge: "ch_1", payment_intent: "pi_1", amount: 999, currency: "usd", reason: "fraudulent" } } };
    expect(await (await send(dispute)).json()).toMatchObject({ outcome: "processed" });
    expect((await openFlags(u.id)).map((f) => f.kind)).toEqual(["chargeback"]);
    await expect(startCheckout(u, "pack_small")).rejects.toMatchObject({ status: 403, code: "account_flagged" });
    // Nothing was left to claw back after the refund, so no chargeback ledger row and no debt flag.
    expect((await listLedger(u.id)).filter((l) => l.kind === "chargeback")).toHaveLength(0);
  });
});

// ── CCBill ───────────────────────────────────────────────────────────────────

describe("ccbill provider (digests computed locally from the documented formulas; never run against CCBill)", () => {
  const ccbill = providerByKey("ccbill")!;
  const passSig = (userId: string, itemKey: string) => hmac(CCBILL_SALT, `ccbill:${userId}:${itemKey}`);
  const base = { clientAccnum: "900000", clientSubacc: "0000", timestamp: "2026-10-12 20:15:00" };
  const post = (eventType: string, fields: Record<string, string>, query: Record<string, string> = { token: CCBILL_TOKEN }) =>
    webhook("ccbill", form({ ...base, ...fields }), { headers: FORM, query: { clientAccnum: "900000", clientSubacc: "0000", eventType, eventGroupType: "Subscription", ...query } });
  const newSale = (userId: string, itemKey: string, subscriptionId: string, transactionId: string, extra: Record<string, string> = {}) =>
    post("NewSaleSuccess", {
      subscriptionId,
      transactionId,
      billedInitialPrice: itemKey.startsWith("plan") ? "19.99" : "9.99",
      billedCurrencyCode: "840",
      dynamicPricingValidationDigest: md5(`${subscriptionId}1${CCBILL_SALT}`),
      nextRenewalDate: "2026-11-11",
      "X-hlUser": userId,
      "X-hlItem": itemKey,
      "X-hlSig": passSig(userId, itemKey),
      ...extra,
    });

  it("builds a FlexForms URL with the documented formDigest", async () => {
    const u = { id: "11111111-1111-4111-8111-111111111111", email: "x@example.test" };
    const pack = new URL((await ccbill.createCheckout({ user: u, item: { key: "pack_small", kind: "pack", label: "Spark", priceCents: 999, currency: "usd", credits: 100 }, successUrl: "s", cancelUrl: "c" })).url);
    expect(pack.origin + pack.pathname).toBe("https://api.ccbill.com/wap-frontflex/flexforms/test-flex-form");
    expect(pack.searchParams.get("formDigest")).toBe(md5(`9.9930840${CCBILL_SALT}`));
    expect(pack.searchParams.get("currencyCode")).toBe("840");
    expect(pack.searchParams.get("recurringPrice")).toBeNull();
    expect(pack.searchParams.get("X-hlSig")).toBe(passSig(u.id, "pack_small"));
    const plan = new URL((await ccbill.createCheckout({ user: u, item: { key: "plan_member", kind: "plan", label: "Night Pass", priceCents: 1999, currency: "usd", credits: 400 }, successUrl: "s", cancelUrl: "c" })).url);
    expect(plan.searchParams.get("formDigest")).toBe(md5(`19.993019.993099840${CCBILL_SALT}`));
    expect(plan.searchParams.get("numRebills")).toBe("99");
    expect(ccbill.isConfigured()).toBe(false); // not the active provider in tests
    expect(ccbill.webhookConfigured()).toBe(true);
  });

  it("grants a NewSaleSuccess with a valid validation digest exactly once", async () => {
    const u = await makeUser();
    const first = await newSale(u.id, "pack_small", "1000000001", "0912191101000000159");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ outcome: "processed" });
    expect(await (await newSale(u.id, "pack_small", "1000000001", "0912191101000000159")).json()).toMatchObject({ outcome: "duplicate" });
    expect((await getBalance(u.id)).available).toBe(100);
    const [row] = await events("ccbill");
    expect(row).toMatchObject({ providerEventId: "NewSaleSuccess:1000000001", transactionRef: "0912191101000000159", amountCents: 999, currency: "usd", credits: 100 });
    expect(row!.metadata).toMatchObject({ subscriptionRef: "1000000001" });
  });

  it("rejects a missing digest, a wrong digest, a wrong token, a tampered pass-through and another account", async () => {
    const u = await makeUser();
    const expectRejected = async (res: Response, code: string) => {
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code } });
    };
    await expectRejected(await post("NewSaleSuccess", { subscriptionId: "1", transactionId: "2", "X-hlUser": u.id, "X-hlItem": "pack_small", "X-hlSig": passSig(u.id, "pack_small") }), "unsigned");
    await expectRejected(await newSale(u.id, "pack_small", "1", "2", { dynamicPricingValidationDigest: md5(`1 1${CCBILL_SALT}`) }), "bad_signature");
    await expectRejected(await post("NewSaleSuccess", { subscriptionId: "1", transactionId: "2", dynamicPricingValidationDigest: md5(`11${CCBILL_SALT}`) }, { token: "wrong" }), "bad_signature");
    await expectRejected(await post("NewSaleSuccess", { subscriptionId: "1", transactionId: "2", dynamicPricingValidationDigest: md5(`11${CCBILL_SALT}`) }, {}), "unsigned");
    await expectRejected(await newSale(u.id, "pack_large", "3", "4", { "X-hlSig": passSig(u.id, "pack_small") }), "bad_signature");
    await expectRejected(await post("Refund", { subscriptionId: "1", transactionId: "2", amount: "9.99" }, {}), "unsigned");
    await expectRejected(await post("NewSaleSuccess", { ...base, clientAccnum: "123456", subscriptionId: "1", transactionId: "2", dynamicPricingValidationDigest: md5(`11${CCBILL_SALT}`) }), "bad_signature");
    expect((await getBalance(u.id)).available).toBe(0);
    expect(await events("ccbill")).toHaveLength(0);
  });

  it("R01: a sale whose billed price or terms do not match the claimed item grants nothing and goes to manual review", async () => {
    const u = await makeUser();
    // Control: the Studio Pass bought on its own form.
    const ok = await newSale(u.id, "plan_studio", "3000000000", "txn_r01_0", { billedInitialPrice: "59.99" });
    expect(await ok.json()).toMatchObject({ outcome: "processed" });
    expect((await getBalance(u.id)).available).toBe(1500);

    // Each one is a real, digest-valid CCBill sale carrying a genuine pass-through pair this server issued for another item.
    const buyer = await makeUser();
    const spliced: { itemKey: string; sub: string; extra: Record<string, string> }[] = [
      // Spark's one-time $9.99 form carrying the Studio Pass pair.
      { itemKey: "plan_studio", sub: "3000000001", extra: { billedInitialPrice: "9.99", nextRenewalDate: "" } },
      // The Night Pass's $19.99 monthly form carrying the Studio Pass pair.
      { itemKey: "plan_studio", sub: "3000000002", extra: { billedInitialPrice: "19.99" } },
      // Spark's $9.99 form carrying the Blaze pair.
      { itemKey: "pack_large", sub: "3000000003", extra: { billedInitialPrice: "9.99" } },
      // Blaze's one-time $89.99 form carrying the Studio Pass pair: paid more, but no recurring terms, so the pass would never end.
      { itemKey: "plan_studio", sub: "3000000004", extra: { billedInitialPrice: "89.99", nextRenewalDate: "" } },
      // No billed price at all.
      { itemKey: "pack_small", sub: "3000000005", extra: { billedInitialPrice: "" } },
    ];
    for (const s of spliced) {
      const res = await newSale(buyer.id, s.itemKey, s.sub, `txn_${s.sub}`, s.extra);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ outcome: "ignored" });
    }
    expect((await getBalance(buyer.id)).available).toBe(0);
    expect(await getDb().select().from(subscriptions).where(eq(subscriptions.userId, buyer.id))).toHaveLength(0);
    const flags = await flagsOf(buyer.id);
    expect(flags.map((f) => f.kind)).toEqual(spliced.map(() => "manual_review"));
    expect(flags[0]!.details).toMatchObject({ provider: "ccbill", itemKey: expect.any(String) });
  });

  it("R20: without CCBILL_WEBHOOK_TOKEN CCBill reports itself unconfigured and takes no webhook, not sales without their refunds", async () => {
    vi.stubEnv("CCBILL_WEBHOOK_TOKEN", undefined);
    vi.stubEnv("PAYMENT_PROVIDER", "ccbill");
    vi.resetModules();
    try {
      const { providerByKey: fresh } = await import("@/server/payments");
      const { POST: freshWebhook } = await import("@/app/api/webhooks/payments/[provider]/route");
      const c = fresh("ccbill")!;
      expect(c.isConfigured()).toBe(false);
      expect(c.webhookConfigured()).toBe(false);
      expect(c.configurationProblem()).toMatch(/CCBILL_WEBHOOK_TOKEN/);

      const u = await makeUser();
      const digest = md5(`2000000077${"1"}${CCBILL_SALT}`);
      const send = (eventType: string, fields: Record<string, string>) => {
        const url = new URL("http://localhost/api/webhooks/payments/ccbill");
        for (const [k, v] of Object.entries({ clientAccnum: "900000", clientSubacc: "0000", eventType })) url.searchParams.set(k, v);
        return freshWebhook(new NextRequest(url, { method: "POST", body: form({ ...base, ...fields }), headers: FORM }), { params: Promise.resolve({ provider: "ccbill" }) });
      };
      const saleRes = await send("NewSaleSuccess", {
        subscriptionId: "2000000077",
        transactionId: "txn_r20_1",
        billedInitialPrice: "19.99",
        billedCurrencyCode: "840",
        nextRenewalDate: "2026-11-11",
        dynamicPricingValidationDigest: digest,
        "X-hlUser": u.id,
        "X-hlItem": "plan_member",
        "X-hlSig": passSig(u.id, "plan_member"),
      });
      expect(saleRes.status).toBe(503);
      // The sale's digest replayed on a lifecycle event in place of the token (R19) is refused too.
      for (const timestamp of ["2026-11-11 00:00:00", "2026-12-11 00:00:00"]) {
        const renewal = await send("RenewalSuccess", { subscriptionId: "2000000077", transactionId: `txn_${timestamp}`, billedAmount: "19.99", billedCurrencyCode: "840", timestamp, dynamicPricingValidationDigest: digest });
        expect(renewal.status).toBe(503);
      }
      expect((await getBalance(u.id)).available).toBe(0);
      expect(await events("ccbill")).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("R19: a signed sale re-posted with another timestamp or transaction id is the same sale, granted once", async () => {
    const u = await makeUser();
    expect(await (await newSale(u.id, "pack_small", "1000000019", "txn_r19_a")).json()).toMatchObject({ outcome: "processed" });
    // Only subscriptionId is covered by the digest; timestamp and transactionId are not.
    expect(await (await newSale(u.id, "pack_small", "1000000019", "txn_r19_a", { timestamp: "2026-10-13 09:00:00" })).json()).toMatchObject({ outcome: "duplicate" });
    expect(await (await newSale(u.id, "pack_small", "1000000019", "txn_r19_b")).json()).toMatchObject({ outcome: "duplicate" });
    expect((await getBalance(u.id)).available).toBe(100);
    expect(await events("ccbill")).toHaveLength(1);
    // The sale's digest on a lifecycle event does not stand in for the token.
    const renewal = await post("RenewalSuccess", { subscriptionId: "1000000019", transactionId: "txn_r19_r", billedAmount: "9.99", billedCurrencyCode: "840", dynamicPricingValidationDigest: md5(`10000000191${CCBILL_SALT}`) }, {});
    expect(renewal.status).toBe(400);
    expect(await renewal.json()).toMatchObject({ error: { code: "unsigned" } });
  });

  it("Refund claws back by transaction id, Chargeback finds the sale by subscription id and flags", async () => {
    const u = await makeUser();
    await newSale(u.id, "pack_small", "1000000002", "txn_sale_1");
    const refund = await post("Refund", { subscriptionId: "1000000002", transactionId: "txn_sale_1", amount: "9.99", currencyCode: "840", reason: "customer request" });
    expect(await refund.json()).toMatchObject({ outcome: "processed" });
    expect((await getBalance(u.id)).available).toBe(0);
    expect((await listLedger(u.id)).find((l) => l.kind === "refund")).toMatchObject({ availableDelta: -100 });

    const u2 = await makeUser();
    await newSale(u2.id, "pack_small", "1000000003", "txn_sale_2");
    const cb = await post("Chargeback", { subscriptionId: "1000000003", transactionId: "txn_cb_new", amount: "9.99", currencyCode: "840", reason: "fraud" });
    expect(await cb.json()).toMatchObject({ outcome: "processed" });
    expect((await getBalance(u2.id)).available).toBe(0);
    expect((await openFlags(u2.id)).map((f) => f.kind)).toEqual(["chargeback"]);
    await expect(startCheckout(u2, "pack_small")).rejects.toMatchObject({ status: 403 });
    // A Return (bounced debit) is a reversal without a flag.
    const u3 = await makeUser();
    await newSale(u3.id, "pack_small", "1000000004", "txn_sale_3");
    await post("Return", { subscriptionId: "1000000004", transactionId: "txn_sale_3", amount: "9.99", currencyCode: "840" });
    expect((await getBalance(u3.id)).available).toBe(0);
    expect(await flagsOf(u3.id)).toHaveLength(0);
  });

  it("R10: a Chargeback delivered before its NewSaleSuccess is applied when the sale lands", async () => {
    const u = await makeUser();
    const cb = await post("Chargeback", { subscriptionId: "1000000077", transactionId: "txn_cb_early", amount: "9.99", currencyCode: "840", reason: "fraud" });
    expect(await cb.json()).toMatchObject({ outcome: "ignored" });
    expect(await (await newSale(u.id, "pack_small", "1000000077", "txn_sale_77")).json()).toMatchObject({ outcome: "processed" });
    expect((await getBalance(u.id)).available).toBe(0);
    expect((await listLedger(u.id)).find((l) => l.kind === "chargeback")).toMatchObject({ availableDelta: -100 });
    expect((await openFlags(u.id)).map((f) => f.kind)).toEqual(["chargeback"]);
  });

  it("starts a pass on NewSaleSuccess, grants each RenewalSuccess once, and ends it on Expiration", async () => {
    const u = await makeUser();
    await newSale(u.id, "plan_member", "2000000001", "txn_plan_1");
    expect((await getBalance(u.id)).available).toBe(400);
    const [sub] = await getDb().select().from(subscriptions).where(eq(subscriptions.userId, u.id));
    expect(sub).toMatchObject({ provider: "ccbill", providerSubscriptionId: "2000000001", status: "active" });
    expect(sub!.currentPeriodEnd?.toISOString().slice(0, 10)).toBe("2026-11-11");
    const renew = () => post("RenewalSuccess", { subscriptionId: "2000000001", transactionId: "txn_plan_2", billedAmount: "19.99", billedCurrencyCode: "840", nextRenewalDate: "2026-12-11", timestamp: "2026-11-11 00:00:00" });
    expect(await (await renew()).json()).toMatchObject({ outcome: "processed" });
    expect(await (await renew()).json()).toMatchObject({ outcome: "duplicate" });
    expect((await getBalance(u.id)).available).toBe(800);
    expect(await (await post("NewSaleFailure", { subscriptionId: "2000000009", transactionId: "txn_fail", dynamicPricingValidationDigest: md5(`20000000090${CCBILL_SALT}`) })).json()).toMatchObject({ outcome: "ignored" });
    await post("Expiration", { subscriptionId: "2000000001" });
    const [after] = await getDb().select().from(subscriptions).where(eq(subscriptions.userId, u.id));
    expect(after!.status).toBe("canceled");
  });
});

// ── Segpay ───────────────────────────────────────────────────────────────────

describe("segpay provider (postbacks built from the documented parameters; never run against Segpay)", () => {
  const segpay = providerByKey("segpay")!;
  const passSig = (userId: string, itemKey: string) => `s${hmac(SEGPAY_SECRET, `segpay:${userId}:${itemKey}`).slice(0, 31)}`;
  const post = (fields: Record<string, string>, query: Record<string, string> = { key: SEGPAY_SECRET }, headers: Record<string, string> = FORM) =>
    webhook("segpay", form({ transtime: "10/12/2026 8:15:00 PM", ...fields }), { headers, query });
  const sale = (userId: string, itemKey: string, tranid: string, purchaseid: string, extra: Record<string, string> = {}) =>
    post({
      action: "Transaction",
      stage: "Initial",
      approved: "Yes",
      trantype: "Sale",
      tranid,
      purchaseid,
      eticketid: `100001:${itemKey === "pack_small" ? "20001" : itemKey === "plan_member" ? "30001" : "20003"}`,
      price: itemKey.startsWith("plan") ? "19.99" : "9.99",
      currencycode: "USD",
      hluser: compactUserId(userId),
      hlitem: itemKey,
      hlsig: passSig(userId, itemKey),
      ...extra,
    });

  it("builds the pay page link with the packageId:pricePointId eticket and a signed pass-through", async () => {
    const u = { id: "22222222-2222-4222-8222-222222222222", email: "y@example.test" };
    const url = new URL((await segpay.createCheckout({ user: u, item: { key: "pack_small", kind: "pack", label: "Spark", priceCents: 999, currency: "usd", credits: 100 }, successUrl: "http://s", cancelUrl: "http://c" })).url);
    expect(url.origin + url.pathname).toBe("https://secure2.segpay.com/billing/poset.cgi");
    expect(url.searchParams.get("x-eticketid")).toBe("100001:20001");
    expect(url.searchParams.get("hluser")).toBe(compactUserId(u.id));
    expect(url.searchParams.get("hluser")!.length).toBeLessThanOrEqual(32);
    expect(url.searchParams.get("hlsig")).toBe(passSig(u.id, "pack_small"));
    expect(url.searchParams.get("hlsig")!.length).toBe(32);
    expect(url.searchParams.get("x-auth-link")).toBe("http://s");
    expect(segpay.isConfigured()).toBe(false);
  });

  it("grants an authenticated sale postback once and answers the plain OK Segpay expects", async () => {
    const u = await makeUser();
    const first = await sale(u.id, "pack_small", "T1", "P1");
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toContain("text/plain");
    expect(await first.text()).toBe("OK");
    expect(first.headers.get("x-payment-outcome")).toBe("processed");
    const again = await sale(u.id, "pack_small", "T1", "P1");
    expect(again.headers.get("x-payment-outcome")).toBe("duplicate");
    expect((await getBalance(u.id)).available).toBe(100);
    const [row] = await events("segpay");
    expect(row).toMatchObject({ providerEventId: "sale:T1", transactionRef: "T1", amountCents: 999, currency: "usd", credits: 100 });
    // Basic auth with the postback secret as the password also counts.
    const basic = await post({ action: "Transaction", stage: "Initial", approved: "Yes", trantype: "Sale", tranid: "T2", purchaseid: "P2", eticketid: "100001:20001", price: "9.99", hluser: compactUserId(u.id), hlitem: "pack_small", hlsig: passSig(u.id, "pack_small") }, {}, { ...FORM, authorization: `Basic ${Buffer.from(`segpay:${SEGPAY_SECRET}`).toString("base64")}` });
    expect(basic.headers.get("x-payment-outcome")).toBe("processed");
    expect((await getBalance(u.id)).available).toBe(200);
  });

  it("rejects a missing key, a wrong key, a tampered item and a declined sale grants nothing", async () => {
    const u = await makeUser();
    expect((await sale(u.id, "pack_small", "T9", "P9")).status).toBe(200); // control: an authenticated one works
    const none = await post({ action: "Transaction", trantype: "Sale", stage: "Initial", approved: "Yes", tranid: "T10", purchaseid: "P10" }, {});
    expect(none.status).toBe(400);
    expect(await none.json()).toMatchObject({ error: { code: "unsigned" } });
    const wrong = await post({ action: "Transaction", trantype: "Sale", stage: "Initial", approved: "Yes", tranid: "T11", purchaseid: "P11" }, { key: "nope" });
    expect(await wrong.json()).toMatchObject({ error: { code: "bad_signature" } });
    const tampered = await sale(u.id, "pack_small", "T12", "P12", { hlitem: "pack_large", hlsig: passSig(u.id, "pack_large") });
    expect(await tampered.json()).toMatchObject({ error: { code: "bad_signature" } });
    const declined = await sale(u.id, "pack_small", "T13", "P13", { approved: "No" });
    expect(declined.headers.get("x-payment-outcome")).toBe("ignored");
    expect((await getBalance(u.id)).available).toBe(100);
    expect(await events("segpay")).toHaveLength(2);
  });

  it("R02: grants nothing unless the price point charged maps to exactly the item claimed", async () => {
    const u = await makeUser();
    // An edited x-eticketid with a price point the map does not know, on a postback that carries no price.
    const unmapped = await sale(u.id, "pack_large", "T50", "P50", { eticketid: "100001:99999", price: "" });
    expect(unmapped.status).toBe(200);
    expect(unmapped.headers.get("x-payment-outcome")).toBe("ignored");
    // A postback template without <eticketid>.
    const noTicket = await sale(u.id, "pack_large", "T51", "P51", { eticketid: "", price: "89.99" });
    expect(noTicket.headers.get("x-payment-outcome")).toBe("ignored");
    expect((await getBalance(u.id)).available).toBe(0);
    expect((await flagsOf(u.id)).map((f) => f.kind)).toEqual(["manual_review", "manual_review"]);
    // Control: Blaze's own price point and price.
    const ok = await sale(u.id, "pack_large", "T52", "P52", { price: "89.99" });
    expect(ok.headers.get("x-payment-outcome")).toBe("processed");
    expect((await getBalance(u.id)).available).toBe(1200);
  });

  it("R02: refuses checkout for an item without its own price point (no shared fallback)", async () => {
    vi.stubEnv("SEGPAY_PRICE_POINT_ID", "pack_small=20001,12345");
    vi.resetModules();
    try {
      const { segpayProvider: fresh } = await import("@/server/payments/providers/segpay");
      const user = { id: "33333333-3333-4333-8333-333333333333", email: "z@example.test" };
      const item = (key: string, priceCents: number) => ({ key, kind: "pack" as const, label: key, priceCents, currency: "usd", credits: 1 });
      await expect(fresh.createCheckout({ user, item: item("pack_large", 8999), successUrl: "http://s", cancelUrl: "http://c" })).rejects.toThrow(/price point/);
      const small = new URL((await fresh.createCheckout({ user, item: item("pack_small", 999), successUrl: "http://s", cancelUrl: "http://c" })).url);
      expect(small.searchParams.get("x-eticketid")).toBe("100001:20001");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("a Credit reverses the related sale, a Charge flags the account, a rebill grants per period", async () => {
    const u = await makeUser();
    await sale(u.id, "pack_small", "T20", "P20");
    const credit = await post({ action: "Transaction", trantype: "Credit", stage: "Initial", approved: "Yes", tranid: "T21", relatedtranid: "T20", purchaseid: "P20", price: "9.99", currencycode: "USD" });
    expect(credit.headers.get("x-payment-outcome")).toBe("processed");
    expect((await getBalance(u.id)).available).toBe(0);
    expect((await listLedger(u.id)).find((l) => l.kind === "refund")).toMatchObject({ availableDelta: -100, idempotencyKey: "refund:segpay:credit:T21" });

    const u2 = await makeUser();
    await sale(u2.id, "pack_small", "T30", "P30");
    const charge = await post({ action: "Transaction", trantype: "Charge", stage: "Initial", approved: "Yes", tranid: "T31", relatedtranid: "T30", purchaseid: "P30", price: "9.99", currencycode: "USD" });
    expect(charge.headers.get("x-payment-outcome")).toBe("processed");
    expect((await openFlags(u2.id)).map((f) => f.kind)).toEqual(["chargeback"]);
    await expect(startCheckout(u2, "pack_small")).rejects.toMatchObject({ status: 403, code: "account_flagged" });

    const u3 = await makeUser();
    await sale(u3.id, "plan_member", "T40", "P40");
    expect((await getBalance(u3.id)).available).toBe(400);
    const rebill = () => post({ action: "Transaction", trantype: "Sale", stage: "Rebill", approved: "Yes", tranid: "T41", purchaseid: "P40", price: "19.99", currencycode: "USD" });
    expect((await rebill()).headers.get("x-payment-outcome")).toBe("processed");
    expect((await rebill()).headers.get("x-payment-outcome")).toBe("duplicate");
    expect((await getBalance(u3.id)).available).toBe(800);
    await post({ action: "Disable", purchaseid: "P40" });
    const [sub] = await getDb().select().from(subscriptions).where(and(eq(subscriptions.userId, u3.id), eq(subscriptions.provider, "segpay")));
    expect(sub).toMatchObject({ providerSubscriptionId: "P40", status: "canceled" });
  });
});
