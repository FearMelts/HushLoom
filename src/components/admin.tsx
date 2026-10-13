"use client";

import { AlertOctagon, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError, newIdempotencyKey } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { Badge, Button, Field, Toggle, inputClass, useToast } from "./ui";

type Report = {
  id: string;
  subjectType: string;
  subjectId: string;
  reason: string;
  note: string;
  reporter: string | null;
  createdAt: string;
  severe: boolean;
  template: { id: string; slug: string; title: string; status: string; creatorId: string } | null;
};
type Model = { key: string; name: string; output: string; provider: string; isDemo: boolean; available: boolean; reason: string | null; priceMultiplierPct: number; enabled: boolean };

function useAct() {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  async function act(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    try {
      await fn();
      toast({ message: ok, tone: "success" });
      router.refresh();
    } catch (e) {
      toast({ message: e instanceof ApiError ? e.message : "That did not work.", tone: "error" });
    } finally {
      setBusy(null);
    }
  }
  return { busy, act };
}

export function ReportQueue({ reports }: { reports: Report[] }) {
  const { busy, act } = useAct();
  if (!reports.length) return <p className="text-sm text-bone-400">No open reports.</p>;
  return (
    <ul className="space-y-3">
      {reports.map((r) => (
        <li key={r.id} className="rounded-xl bg-ink-850 p-3.5">
          <div className="flex flex-wrap items-center gap-2">
            {r.severe ? (
              <Badge tone="danger">
                <AlertOctagon size={10} aria-hidden /> {r.reason.replace("_", " ")}
              </Badge>
            ) : (
              <Badge>{r.reason}</Badge>
            )}
            <span className="text-sm text-bone-100">
              {r.template ? (
                <Link href={`/templates/${r.template.slug}`} className="inline-flex items-center gap-1 hover:text-ember-400" target="_blank">
                  {r.template.title} <ExternalLink size={12} aria-hidden />
                </Link>
              ) : (
                `${r.subjectType} ${r.subjectId.slice(0, 8)}`
              )}
            </span>
            {r.template && r.template.status !== "published" ? <Badge>{r.template.status}</Badge> : null}
            <span className="font-mono text-[11px] text-bone-500">
              {r.reporter ? `@${r.reporter}` : "system"} · {relativeTime(r.createdAt)}
            </span>
          </div>
          {r.note ? <p className="mt-1.5 text-[13px] text-bone-300">“{r.note}”</p> : null}
          <div className="mt-2.5 flex flex-wrap gap-2">
            <Button size="sm" variant="danger" busy={busy === `rm:${r.id}`} onClick={() => act(`rm:${r.id}`, () => api(`/api/admin/reports/${r.id}`, { body: { action: "remove" } }), "Removed.")}>
              Remove content
            </Button>
            <Button size="sm" variant="quiet" busy={busy === `dis:${r.id}`} onClick={() => act(`dis:${r.id}`, () => api(`/api/admin/reports/${r.id}`, { body: { action: "dismiss" } }), "Dismissed.")}>
              Dismiss
            </Button>
            {r.template ? (
              <Button
                size="sm"
                variant="quiet"
                busy={busy === `sus:${r.id}`}
                onClick={() => {
                  const reason = window.prompt("Reason for suspending this creator?");
                  if (reason) void act(`sus:${r.id}`, () => api(`/api/admin/users/${r.template!.creatorId}/suspend`, { body: { reason } }), "Creator suspended and signed out.");
                }}
              >
                Suspend creator
              </Button>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ModelTable({ models }: { models: Model[] }) {
  const { busy, act } = useAct();
  const [mult, setMult] = useState<Record<string, number>>(Object.fromEntries(models.map((m) => [m.key, m.priceMultiplierPct])));
  return (
    <ul className="divide-y divide-bone-50/5">
      {models.map((m) => (
        <li key={m.key} className="flex flex-wrap items-center gap-4 py-3">
          <div className="min-w-48 flex-1">
            <p className="text-sm text-bone-100">
              {m.name} {m.isDemo ? <Badge tone="demo">demo</Badge> : null}
            </p>
            <p className="font-mono text-[11px] text-bone-500">
              {m.key} · {m.provider} · {m.output} · {m.available ? "live" : m.reason}
            </p>
          </div>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void act(`mult:${m.key}`, () => api(`/api/admin/models/${m.key}`, { method: "PATCH", body: { priceMultiplierPct: mult[m.key] } }), "Price updated.");
            }}
          >
            <label htmlFor={`m-${m.key}`} className="text-[12px] text-bone-400">
              Price %
            </label>
            <input id={`m-${m.key}`} type="number" min={10} max={1000} className={`${inputClass} w-20 py-1.5`} value={mult[m.key] ?? 100} onChange={(e) => setMult({ ...mult, [m.key]: Number(e.target.value) })} />
            <Button size="sm" variant="ghost" type="submit" busy={busy === `mult:${m.key}`} disabled={mult[m.key] === m.priceMultiplierPct}>
              Set
            </Button>
          </form>
          <div className="w-36">
            <Toggle label="Enabled" checked={m.enabled} onChange={(v) => act(`en:${m.key}`, () => api(`/api/admin/models/${m.key}`, { method: "PATCH", body: { enabled: v } }), v ? "Enabled." : "Disabled.")} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function CreditAdjust() {
  const { busy, act } = useAct();
  const [account, setAccount] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [key, setKey] = useState(newIdempotencyKey);
  return (
    <form
      className="grid gap-3 sm:grid-cols-[1fr_120px]"
      onSubmit={(e) => {
        e.preventDefault();
        void act("adjust", async () => {
          await api("/api/admin/credits", { body: { account, amount: Number(amount), reason, idempotencyKey: key } });
          setAccount("");
          setAmount("");
          setReason("");
          setKey(newIdempotencyKey());
        }, "Credits adjusted.");
      }}
    >
      <Field label="Email or handle" htmlFor="ca">
        <input id="ca" className={inputClass} value={account} onChange={(e) => setAccount(e.target.value)} required />
      </Field>
      <Field label="Amount" htmlFor="cm" hint="Negative removes.">
        <input id="cm" type="number" className={inputClass} value={amount} onChange={(e) => setAmount(e.target.value)} required />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Reason" htmlFor="cr" hint="Shown to the user in their credit history.">
          <input id="cr" className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} maxLength={200} />
        </Field>
      </div>
      <Button type="submit" variant="ember" size="sm" busy={busy === "adjust"} className="w-fit">
        Apply
      </Button>
    </form>
  );
}

export { AccountFlags } from "./admin-flags";
