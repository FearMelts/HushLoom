"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { Badge, Button, useToast } from "./ui";

type Purchase = { transactionRef: string; label: string; amount: string; credits: number; when: string };
type Pass = { ref: string; label: string; status: string };
type Action = "complete" | "fail" | "refund" | "chargeback" | "renew" | "cancel";

/** Buttons that stand in for a payment processor. Everything they do is labeled sandbox and moves no money. */
export function SandboxCheckout({ token, mode, purchases, passes }: { token?: string; mode: "order" | "history"; purchases: Purchase[]; passes: Pass[] }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  async function act(key: string, action: Action, extra: Record<string, string> = {}, ok?: string) {
    setBusy(key);
    try {
      const res = await api<{ outcome: string; next: string }>("/api/pricing/sandbox", { body: { action, token, ...extra } });
      if (ok) toast({ message: `${ok} (sandbox, ${res.outcome})`, tone: "success" });
      if (action === "complete" || action === "fail") router.push(res.next);
      else router.refresh();
    } catch (e) {
      toast({ message: e instanceof ApiError ? e.message : "The sandbox did not answer.", tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  if (mode === "order") {
    return (
      <div className="flex flex-wrap gap-3">
        <Button variant="ember" size="lg" busy={busy === "complete"} onClick={() => act("complete", "complete", {}, "Sandbox purchase completed")} data-testid="sandbox-complete">
          Complete sandbox purchase
        </Button>
        <Button variant="ghost" size="lg" busy={busy === "fail"} onClick={() => act("fail", "fail", {}, "Sandbox payment failed, as asked")} data-testid="sandbox-fail">
          Simulate failure
        </Button>
      </div>
    );
  }

  if (!purchases.length && !passes.length) return <p className="text-sm text-bone-500">No sandbox payments yet. Complete one above first.</p>;

  return (
    <div className="space-y-4">
      {purchases.length ? (
        <ul className="divide-y divide-bone-50/5">
          {purchases.map((p) => (
            <li key={p.transactionRef} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-40 flex-1">
                <p className="text-sm text-bone-100">
                  {p.label} <Badge tone="demo">sandbox</Badge>
                </p>
                <p className="font-mono text-[11px] text-bone-500">
                  {p.amount} · {p.credits} credits · {relativeTime(p.when)} · {p.transactionRef}
                </p>
              </div>
              <Button size="sm" variant="ghost" busy={busy === `refund:${p.transactionRef}`} onClick={() => act(`refund:${p.transactionRef}`, "refund", { transactionRef: p.transactionRef }, "Sandbox refund sent")}>
                Simulate refund
              </Button>
              <Button size="sm" variant="danger" busy={busy === `cb:${p.transactionRef}`} onClick={() => act(`cb:${p.transactionRef}`, "chargeback", { transactionRef: p.transactionRef }, "Sandbox chargeback sent")}>
                Simulate chargeback
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {passes.length ? (
        <ul className="divide-y divide-bone-50/5">
          {passes.map((s) => (
            <li key={s.ref} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-40 flex-1">
                <p className="text-sm text-bone-100">
                  {s.label} pass <Badge tone="demo">sandbox</Badge> <Badge>{s.status}</Badge>
                </p>
                <p className="font-mono text-[11px] text-bone-500">{s.ref}</p>
              </div>
              <Button size="sm" variant="ghost" busy={busy === `renew:${s.ref}`} onClick={() => act(`renew:${s.ref}`, "renew", { subscriptionRef: s.ref }, "Sandbox renewal sent")}>
                Simulate renewal
              </Button>
              <Button size="sm" variant="quiet" busy={busy === `cancel:${s.ref}`} onClick={() => act(`cancel:${s.ref}`, "cancel", { subscriptionRef: s.ref }, "Sandbox cancellation sent")}>
                Simulate cancellation
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
