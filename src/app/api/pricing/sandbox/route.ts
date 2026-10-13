import { randomUUID } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/server/db";
import { paymentEvents, subscriptions } from "@/server/db/schema";
import { env } from "@/server/env";
import { HttpError, parseJson, requireUser, route } from "@/server/http";
import { paymentProvider } from "@/server/payments";
import { newSandboxEventId, readSandboxToken, SANDBOX_SIGNATURE_HEADER, signSandboxBody, type SandboxBody } from "@/server/payments/providers/sandbox";
import { checkoutItem } from "@/server/payments/util";
import { handlePaymentWebhook } from "@/server/payments/webhook";

const schema = z.object({
  action: z.enum(["complete", "fail", "refund", "chargeback", "renew", "cancel"]),
  token: z.string().max(2000).optional(),
  transactionRef: z.string().max(120).optional(),
  subscriptionRef: z.string().max(120).optional(),
});

/**
 * The sandbox "processor" reporting back. It builds the event the sandbox would send, signs it
 * with the dev-only secret and posts it through the generic webhook handler, so checkout →
 * webhook → ledger runs the same code a real processor would. Only the signed-in person's own
 * sandbox purchases can be acted on, and only while the sandbox is the active provider.
 */
export const POST = route(async (req) => {
  const user = await requireUser();
  const provider = paymentProvider();
  if (provider.key !== "sandbox" || !provider.isConfigured()) throw new HttpError(503, "payments_unavailable", "The payment sandbox is not active on this server.");
  const input = await parseJson(req, schema);

  let body: SandboxBody;
  if (input.action === "complete" || input.action === "fail") {
    const claims = readSandboxToken(input.token);
    if (!claims || claims.userId !== user.id) throw new HttpError(403, "bad_token", "This sandbox link has expired or is not yours. Start again from pricing.");
    const item = checkoutItem(claims.itemKey);
    if (!item) throw new HttpError(422, "unknown_item", "That package does not exist.");
    const ref = randomUUID().slice(0, 12);
    body = {
      kind: input.action === "complete" ? "sale" : "failure",
      eventId: newSandboxEventId(input.action === "complete" ? "sale" : "failure"),
      userId: user.id,
      itemKey: item.key,
      amountCents: item.priceCents,
      currency: item.currency,
      transactionRef: `sbx_txn_${ref}`,
      subscriptionRef: item.kind === "plan" ? `sbx_sub_${ref}` : undefined,
    };
  } else if (input.action === "refund" || input.action === "chargeback") {
    if (!input.transactionRef) throw new HttpError(422, "invalid_input", "Pick a sandbox payment first.");
    const [original] = await getDb()
      .select()
      .from(paymentEvents)
      .where(and(eq(paymentEvents.provider, "sandbox"), eq(paymentEvents.userId, user.id), eq(paymentEvents.transactionRef, input.transactionRef), gt(paymentEvents.credits, 0)));
    if (!original) throw new HttpError(404, "not_found", "No sandbox payment with that reference on your account.");
    body = {
      kind: input.action,
      eventId: newSandboxEventId(input.action),
      amountCents: original.amountCents ?? 0,
      currency: original.currency ?? "usd",
      transactionRef: input.transactionRef,
      subscriptionRef: typeof original.metadata.subscriptionRef === "string" ? original.metadata.subscriptionRef : undefined,
    };
  } else {
    if (!input.subscriptionRef) throw new HttpError(422, "invalid_input", "Pick a sandbox pass first.");
    const [sub] = await getDb()
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.provider, "sandbox"), eq(subscriptions.userId, user.id), eq(subscriptions.providerSubscriptionId, input.subscriptionRef)));
    if (!sub) throw new HttpError(404, "not_found", "No sandbox pass with that reference on your account.");
    const plan = checkoutItem(sub.planKey);
    body = {
      kind: input.action === "renew" ? "renewal" : "cancel",
      eventId: newSandboxEventId(input.action === "renew" ? "renewal" : "cancel"),
      amountCents: plan?.priceCents ?? 0,
      currency: plan?.currency ?? "usd",
      transactionRef: `sbx_txn_${randomUUID().slice(0, 12)}`,
      subscriptionRef: sub.providerSubscriptionId,
    };
  }

  const raw = JSON.stringify(body);
  const webhook = new NextRequest(`${env().APP_URL}/api/webhooks/payments/sandbox`, {
    method: "POST",
    body: raw,
    headers: { "content-type": "application/json", [SANDBOX_SIGNATURE_HEADER]: signSandboxBody(raw) },
  });
  const res = await handlePaymentWebhook("sandbox", webhook);
  const { outcome } = (await res.json()) as { outcome: string };
  const next = input.action === "complete" ? "/pricing?checkout=success" : input.action === "fail" ? "/pricing?checkout=cancelled" : "/pricing";
  return NextResponse.json({ outcome, transactionRef: body.transactionRef, next });
});
