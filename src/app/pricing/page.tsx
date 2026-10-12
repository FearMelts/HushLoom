import { pricing } from "@/config/pricing";
import { BuyButton, PerkList } from "@/components/pricing";
import { Badge, SectionHeading } from "@/components/ui";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/format";
import { getCurrentUser } from "@/server/auth/session";
import { getBalance, listLedger } from "@/server/credits/ledger";
import { activePlan } from "@/server/generation/service";
import { paymentsConfigured } from "@/server/payments/stripe";

export const dynamic = "force-dynamic";
export const metadata = { title: "Credits and passes" };

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: pricing.currency.toUpperCase() }).format(cents / 100);

const KIND_LABEL: Record<string, string> = {
  signup_grant: "Welcome credits",
  purchase: "Purchase",
  subscription_grant: "Pass credits",
  reserve: "Held for a creation",
  release: "Returned",
  settle: "Spent",
  admin_adjust: "Adjustment",
};

export default async function PricingPage({ searchParams }: { searchParams: Promise<{ checkout?: string }> }) {
  const user = await getCurrentUser();
  const configured = paymentsConfigured();
  const checkout = (await searchParams).checkout;
  const [balance, ledger, plan] = user ? await Promise.all([getBalance(user.id), listLedger(user.id, 40), activePlan(user.id)]) : [null, [], null];

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-8">
        <p className="tag text-ember-400">Pay for what you make</p>
        <h1 className="font-display text-4xl">Credits and passes</h1>
        <p className="mt-2 max-w-2xl text-sm text-bone-400">
          A still costs {pricing.imageBase} credits. A clip costs {pricing.videoPerSecond} credits per second. 4K doubles either. You see the exact cost before anything starts, credits are held when you confirm,
          and they come back in full if a creation fails or you cancel it.
        </p>
      </div>

      {checkout === "success" ? (
        <p className="mb-6 rounded-xl bg-sage-400/10 px-4 py-3 text-sm text-sage-300" role="status">
          Payment sent. Credits are added when Stripe confirms the payment to this server, which is usually within seconds. Refresh to see them.
        </p>
      ) : checkout === "cancelled" ? (
        <p className="mb-6 rounded-xl bg-ink-850 px-4 py-3 text-sm text-bone-300" role="status">
          Checkout cancelled. Nothing was charged.
        </p>
      ) : null}
      {!configured ? (
        <p className="mb-6 rounded-xl bg-brass-300/10 px-4 py-3 text-sm text-brass-300" role="note">
          Payments are not connected on this server, so buying is switched off. The operator enables it by setting STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET. Prices below are placeholders.
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
              <BuyButton itemKey={p.key} signedIn={Boolean(user)} configured={configured} label={plan?.key === p.key ? "Your pass" : `Get ${p.label}`} featured={i === 1} />
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
              <BuyButton itemKey={p.key} signedIn={Boolean(user)} configured={configured} label="Buy" />
            </div>
          ))}
        </div>
      </section>

      {user ? (
        <section>
          <SectionHeading kicker="Every movement, newest first" title="Credit history" />
          {ledger.length ? (
            <div className="overflow-x-auto">
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
          ) : (
            <p className="text-sm text-bone-400">No credit movements yet.</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
