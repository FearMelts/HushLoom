import { and, eq, gt } from "drizzle-orm";
import { redirect } from "next/navigation";
import { SandboxCheckout } from "@/components/pricing-sandbox";
import { Badge, ButtonLink } from "@/components/ui";
import { getCurrentUser } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { paymentEvents, subscriptions } from "@/server/db/schema";
import { paymentsStatus } from "@/server/payments";
import { readSandboxToken } from "@/server/payments/providers/sandbox";
import { checkoutItem } from "@/server/payments/util";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sandbox checkout" };

const money = (cents: number, currency: string) => new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);

/**
 * The sandbox processor's "payment page". No money moves here; the buttons below send signed
 * sandbox events through the same webhook route a real processor would use.
 */
export default async function SandboxCheckoutPage({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/auth?next=/pricing");
  const status = paymentsStatus();
  if (status.provider !== "sandbox" || !status.configured) redirect("/pricing");

  const t = (await searchParams).t ?? "";
  const claims = readSandboxToken(t);
  const item = claims && claims.userId === user.id ? checkoutItem(claims.itemKey) : null;
  const [purchases, passes] = await Promise.all([
    getDb()
      .select({ transactionRef: paymentEvents.transactionRef, amountCents: paymentEvents.amountCents, currency: paymentEvents.currency, credits: paymentEvents.credits, metadata: paymentEvents.metadata, createdAt: paymentEvents.createdAt })
      .from(paymentEvents)
      .where(and(eq(paymentEvents.provider, "sandbox"), eq(paymentEvents.userId, user.id), gt(paymentEvents.credits, 0)))
      .orderBy(paymentEvents.createdAt)
      .limit(20),
    getDb()
      .select({ providerSubscriptionId: subscriptions.providerSubscriptionId, planKey: subscriptions.planKey, status: subscriptions.status })
      .from(subscriptions)
      .where(and(eq(subscriptions.provider, "sandbox"), eq(subscriptions.userId, user.id)))
      .limit(10),
  ]);

  return (
    <div className="mx-auto max-w-2xl">
      <div className="petal mb-8 bg-iris-400/10 p-6 hairline">
        <Badge tone="demo">Sandbox · demo</Badge>
        <h1 className="mt-3 font-display text-4xl leading-tight sm:text-5xl">This is a sandbox. No money moves.</h1>
        <p className="mt-3 text-sm text-bone-300">
          No card is asked for and nothing is charged. The buttons below play the part of a payment processor so you can watch credits arrive, get refunded and get
          clawed back. A live site uses CCBill or Segpay instead and never shows this page.
        </p>
      </div>

      {item && claims ? (
        <section className="petal mb-8 bg-ink-900/60 p-6 hairline">
          <p className="tag text-ember-400">Sandbox order</p>
          <h2 className="font-display text-2xl">
            {item.label} {item.kind === "plan" ? "pass" : "pack"}
          </h2>
          <p className="mt-1 text-sm text-bone-400">
            {money(item.priceCents, item.currency)}
            {item.kind === "plan" ? " a month" : ""} · {item.credits.toLocaleString()} credits{item.kind === "plan" ? " each month" : ""} · nothing is charged
          </p>
          <div className="mt-5">
            <SandboxCheckout token={t} mode="order" purchases={[]} passes={[]} />
          </div>
        </section>
      ) : (
        <section className="petal mb-8 bg-ink-900/60 p-6 hairline">
          <h2 className="font-display text-2xl">This sandbox link has expired or is not yours.</h2>
          <p className="mt-1 text-sm text-bone-400">Sandbox links last 30 minutes. Start again from the pricing page.</p>
          <ButtonLink href="/pricing" variant="ghost" className="mt-4">
            Back to pricing
          </ButtonLink>
        </section>
      )}

      <section className="petal bg-ink-900/60 p-6 hairline">
        <p className="tag text-bone-500">Earlier sandbox payments</p>
        <h2 className="font-display text-2xl">Reverse something</h2>
        <p className="mt-1 text-sm text-bone-400">
          A refund takes the credits back through the ledger. A chargeback does the same and pauses buying on this account until an operator clears the flag.
        </p>
        <div className="mt-4">
          <SandboxCheckout
            mode="history"
            purchases={purchases
              .filter((p) => p.transactionRef)
              .map((p) => ({
                transactionRef: p.transactionRef!,
                label: typeof p.metadata.label === "string" ? p.metadata.label : "Purchase",
                amount: money(p.amountCents ?? 0, p.currency ?? "usd"),
                credits: p.credits ?? 0,
                when: p.createdAt.toISOString(),
              }))}
            passes={passes.map((s) => ({ ref: s.providerSubscriptionId, label: checkoutItem(s.planKey)?.label ?? s.planKey, status: s.status }))}
          />
        </div>
      </section>
    </div>
  );
}
