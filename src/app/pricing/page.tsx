import { pricing } from "@/config/pricing";
import { BuyButton, PerkList } from "@/components/pricing";
import { Badge, SectionHeading } from "@/components/ui";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/format";
import { getCurrentUser } from "@/server/auth/session";
import { getBalance, listLedger } from "@/server/credits/ledger";
import { activePlan } from "@/server/generation/service";
import { paymentsStatus } from "@/server/payments";
import { checkoutBlock, EVENT_LABEL, listPaymentHistory } from "@/server/payments/service";

export const dynamic = "force-dynamic";
export const metadata = { title: "Credits and passes" };

const money = (cents: number, currency: string = pricing.currency) => new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);

const KIND_LABEL: Record<string, string> = {
  signup_grant: "Welcome credits",
  purchase: "Purchase",
  subscription_grant: "Pass credits",
  reserve: "Held for a creation",
  release: "Returned",
  settle: "Spent",
  admin_adjust: "Adjustment",
  refund: "Refunded",
  chargeback: "Chargeback",
};

const PROVIDER_LABEL: Record<string, string> = { sandbox: "Sandbox", ccbill: "CCBill", segpay: "Segpay", stripe: "Stripe" };

export default async function PricingPage({ searchParams }: { searchParams: Promise<{ checkout?: string }> }) {
  const user = await getCurrentUser();
  const status = paymentsStatus();
  const configured = status.configured;
  const checkout = (await searchParams).checkout;
  const [balance, ledger, plan, payments, blocked] = user
    ? await Promise.all([getBalance(user.id), listLedger(user.id, 40), activePlan(user.id), listPaymentHistory(user.id, 40), checkoutBlock(user.id)])
    : [null, [], null, [], null];

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-8">
        <p className="tag text-ember-400">Pay for what you make</p>
        <h1 className="font-display text-4xl">Credits and passes</h1>
        <p className="mt-2 max-w-2xl text-sm text-bone-400">
          A still costs {pricing.imageBase} credits. A clip costs {pricing.videoPerSecond} credits per second. 4K doubles either. You see the exact cost before anything starts, credits are held when you confirm,
          and they come back in full if a creation fails or you cancel it.
        </p>
        <p className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-bone-400" data-testid="payments-processor">
          {status.isSandbox ? (
            <>
              <Badge tone="demo">Sandbox · no money moves</Badge>
              <span>Payments run in a sandbox on this server. Nothing is charged; purchases here only exercise the credit ledger.</span>
            </>
          ) : (
            <>
              <Badge>{status.label}</Badge>
              <span>Payments are handled by {status.label}. Your card details never touch this server.</span>
            </>
          )}
        </p>
      </div>

      {checkout === "success" ? (
        <p className="mb-6 rounded-xl bg-sage-400/10 px-4 py-3 text-sm text-sage-300" role="status">
          Payment sent. Credits are added when {status.label} confirms the payment to this server, which is usually within seconds. Refresh to see them.
        </p>
      ) : checkout === "cancelled" ? (
        <p className="mb-6 rounded-xl bg-ink-850 px-4 py-3 text-sm text-bone-300" role="status">
          Checkout cancelled. Nothing was charged.
        </p>
      ) : null}
      {!configured ? (
        <p className="mb-6 rounded-xl bg-brass-300/10 px-4 py-3 text-sm text-brass-300" role="note">
          Payments are not connected on this server, so buying is switched off. {status.problem} The operator picks a processor with PAYMENT_PROVIDER and sets its keys. Prices below are
          placeholders.
        </p>
      ) : null}
      {blocked ? (
        <p className="mb-6 rounded-xl bg-danger-400/10 px-4 py-3 text-sm text-danger-400" role="alert" data-testid="account-flagged">
          {blocked} You can still browse and use the credits you have.
        </p>
      ) : null}

      {balance ? (
        <div className="mb-10 flex flex-wrap gap-6 rounded-[24px_8px_24px_8px] bg-ink-900/70 p-5 hairline">
          <div>
            <p className="tag text-bone-500">Available</p>
            <p className="font-display text-4xl" data-testid="pricing-balance">{balance.available}</p>
          </div>
          <div>
            <p className="tag text-bone-500">Held for running creations</p>
            <p className="font-display text-4xl text-bone-400">{balance.reserved}</p>
          </div>
          {plan ? (
            <div>
              <p className="tag text-bone-500">Pass</p>
              <p className="font-display text-4xl text-brass-300">{plan.label}</p>
            </div>
          ) : null}
        </div>
      ) : null}

      <section className="mb-12">
        <SectionHeading kicker="Monthly" title="Passes" />
        <div className="grid gap-5 sm:grid-cols-2">
          {pricing.plans.map((p, i) => (
            <div key={p.key} className={cn("petal flex flex-col gap-4 p-6 hairline", i === 1 ? "bg-ember-500/[0.06]" : "bg-ink-900/60")}>
              <div className="flex items-center justify-between">
                <h3 className="font-display text-2xl">{p.label}</h3>
                <Badge tone="vip">VIP</Badge>
              </div>
              <p>
                <span className="font-display text-4xl">{money(p.priceCents)}</span> <span className="text-sm text-bone-400">/ month</span>
              </p>
              <PerkList perks={p.perks} className="flex-1" />
              <BuyButton
                itemKey={p.key}
                signedIn={Boolean(user)}
                configured={configured}
                blocked={blocked}
                sandbox={status.isSandbox}
                label={plan?.key === p.key ? "Your pass" : `Get ${p.label}`}
                featured={i === 1}
              />
            </div>
          ))}
        </div>
      </section>

      <section className="mb-12">
        <SectionHeading kicker="One-time" title="Credit packs" />
        <div className="grid gap-5 sm:grid-cols-3">
          {pricing.packs.map((p) => (
            <div key={p.key} className="petal flex flex-col gap-3 bg-ink-900/60 p-5 hairline">
              <h3 className="font-display text-xl">{p.label}</h3>
              <p className="font-display text-3xl">{p.credits.toLocaleString()} <span className="text-sm text-bone-400">credits</span></p>
              <p className="text-sm text-bone-400">{money(p.priceCents)} · never expire</p>
              <BuyButton itemKey={p.key} signedIn={Boolean(user)} configured={configured} blocked={blocked} sandbox={status.isSandbox} label="Buy" />
            </div>
          ))}
        </div>
      </section>

      {user ? (
        <section className="mb-12">
          <SectionHeading kicker="What the processor confirmed" title="Payments" />
          {payments.length ? (
            <div className="edge-fade overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-[13px]" data-testid="payments-history">
                <thead className="text-bone-500">
                  <tr className="border-b border-bone-50/10">
                    <th className="py-2 font-medium">When</th>
                    <th className="py-2 font-medium">What</th>
                    <th className="py-2 text-right font-medium">Amount</th>
                    <th className="py-2 text-right font-medium">Credits</th>
                    <th className="py-2 font-medium">Reference</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.id} className="border-b border-bone-50/5">
                      <td className="py-2 text-bone-400">{relativeTime(p.createdAt)}</td>
                      <td className="py-2">
                        {p.type === "subscription_cancelled" && p.metadata.status === "non_renewing" ? "Renewal stopped" : (EVENT_LABEL[p.type] ?? p.type)}
                        {typeof p.metadata.label === "string" ? <span className="text-bone-500"> · {p.metadata.label}</span> : null}{" "}
                        {p.provider === "sandbox" ? <Badge tone="demo">sandbox</Badge> : <span className="text-bone-500">· {PROVIDER_LABEL[p.provider] ?? p.provider}</span>}
                      </td>
                      <td className={cn("py-2 text-right font-mono", (p.amountCents ?? 0) < 0 ? "text-danger-400" : "")}>{p.amountCents === null ? "" : money(p.amountCents, p.currency ?? pricing.currency)}</td>
                      <td className={cn("py-2 text-right font-mono", (p.credits ?? 0) > 0 ? "text-sage-400" : (p.credits ?? 0) < 0 ? "text-danger-400" : "text-bone-500")}>
                        {p.credits ? (p.credits > 0 ? `+${p.credits}` : p.credits) : ""}
                        {typeof p.metadata.shortfall === "number" && p.metadata.shortfall > 0 ? <span className="text-bone-500"> ({p.metadata.shortfall} owed)</span> : null}
                      </td>
                      <td className="py-2 font-mono text-[11px] text-bone-500">{p.transactionRef ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-bone-400">No payments yet.</p>
          )}
        </section>
      ) : null}

      {user ? (
        <section>
          <SectionHeading kicker="Every movement, newest first" title="Credit history" />
          {ledger.length ? (
            <>
              {/* Phones: one entry per row, what and when on the left, the change and the balance after on the right. */}
              <ul className="divide-y divide-bone-50/5 border-y border-bone-50/10 text-[13px] sm:hidden" aria-label="Credit history">
                {ledger.map((l) => (
                  <li key={l.id} className="flex items-start justify-between gap-4 py-2.5">
                    <div className="min-w-0">
                      <p>
                        {KIND_LABEL[l.kind] ?? l.kind}
                        {l.note ? <span className="text-bone-500"> · {l.note}</span> : null}
                      </p>
                      <p className="mt-0.5 text-[12px] text-bone-400">{relativeTime(l.createdAt)}</p>
                    </div>
                    <div className="shrink-0 text-right font-mono">
                      <p className={l.availableDelta > 0 ? "text-sage-400" : l.availableDelta < 0 ? "text-bone-200" : "text-bone-500"}>
                        {l.availableDelta > 0 ? `+${l.availableDelta}` : l.availableDelta || "0"}
                        {l.reservedDelta ? <span className="text-bone-500"> ({l.reservedDelta > 0 ? "+" : ""}{l.reservedDelta} held)</span> : null}
                      </p>
                      <p className="mt-0.5 text-[12px] text-bone-500">{l.availableAfter} available</p>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="edge-fade hidden overflow-x-auto sm:block">
                <table className="w-full min-w-[520px] text-left text-[13px]">
                  <thead className="text-bone-500">
                    <tr className="border-b border-bone-50/10">
                      <th className="py-2 font-medium">When</th>
                      <th className="py-2 font-medium">What</th>
                      <th className="py-2 text-right font-medium">Change</th>
                      <th className="py-2 text-right font-medium">Available after</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.map((l) => (
                      <tr key={l.id} className="border-b border-bone-50/5">
                        <td className="py-2 text-bone-400">{relativeTime(l.createdAt)}</td>
                        <td className="py-2">
                          {KIND_LABEL[l.kind] ?? l.kind}
                          {l.note ? <span className="text-bone-500"> · {l.note}</span> : null}
                        </td>
                        <td className={cn("py-2 text-right font-mono", l.availableDelta > 0 ? "text-sage-400" : l.availableDelta < 0 ? "text-bone-200" : "text-bone-500")}>
                          {l.availableDelta > 0 ? `+${l.availableDelta}` : l.availableDelta || "0"}
                          {l.reservedDelta ? <span className="text-bone-500"> ({l.reservedDelta > 0 ? "+" : ""}{l.reservedDelta} held)</span> : null}
                        </td>
                        <td className="py-2 text-right font-mono">{l.availableAfter}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="text-sm text-bone-400">No credit movements yet.</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
