"use client";

import { ExternalLink, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import type { Escalation } from "@/server/safety/review";
import type { TakedownItem } from "@/server/safety/takedowns";
import { Badge, Button, ButtonLink, Field, inputClass, useToast } from "./ui";

/** The admin page's way in to the abuse review queue. */
export function ReviewLink() {
  return (
    <ButtonLink href="/admin/review" size="sm" variant="ghost">
      <ShieldAlert size={14} aria-hidden /> Abuse review
    </ButtonLink>
  );
}

function useAct() {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  async function act(key: string, fn: () => Promise<unknown>, ok: string): Promise<boolean> {
    setBusy(key);
    try {
      await fn();
      toast({ message: ok, tone: "success" });
      router.refresh();
      return true;
    } catch (e) {
      toast({ message: e instanceof ApiError ? e.message : "That did not work.", tone: "error" });
      return false;
    } finally {
      setBusy(null);
    }
  }
  return { busy, act };
}

const REPORTED_TO = [
  ["ncmec_cybertipline", "NCMEC CyberTipline (US)"],
  ["iwf", "Internet Watch Foundation (UK)"],
  ["other_authority", "Another authority"],
] as const;

const ORIGIN: Record<string, string> = { upload: "upload", output: "creation", seed: "seed media", backfill: "backfill scan", takedown: "takedown request" };

function Mono({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <p className="break-all font-mono text-[11px] text-bone-500">
      <span className="text-bone-400">{label}</span> {value}
    </p>
  );
}

function EscalationCard({ e }: { e: Escalation }) {
  const { busy, act } = useAct();
  const [mode, setMode] = useState<"confirm" | "clear" | null>(null);
  const [reportRef, setReportRef] = useState("");
  const [reportedTo, setReportedTo] = useState<(typeof REPORTED_TO)[number][0]>("ncmec_cybertipline");
  const [note, setNote] = useState("");
  const drill = e.provider === "dev";
  return (
    <li className="rounded-xl bg-ink-850 p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="danger">{e.reason === "csam_report" ? "CSAM report" : "abuse match"}</Badge>
        <Badge>{ORIGIN[e.origin ?? ""] ?? e.subjectType}</Badge>
        {drill ? <Badge tone="demo">dev scanner drill</Badge> : null}
        {e.asset?.legalHold ? <Badge tone="warn">legal hold</Badge> : null}
        <span className="font-mono text-[11px] text-bone-500">{relativeTime(e.createdAt)}</span>
      </div>
      <p className="mt-1.5 text-[13px] text-bone-200">
        {e.owner ? (
          <>
            {e.owner.handle ? `@${e.owner.handle}` : "account"} · {e.owner.email} · <span className={e.owner.status === "suspended" ? "text-danger-400" : ""}>{e.owner.status}</span>
          </>
        ) : (
          "No owner on record"
        )}
        {e.asset ? ` · ${e.asset.kind} · ${e.asset.mime} · ${(e.asset.bytes / 1024).toFixed(0)} KB` : ""}
      </p>
      <div className="mt-1.5 space-y-0.5">
        <Mono label="asset" value={e.asset?.id ?? null} />
        <Mono label="sha256" value={e.asset?.sha256 ?? null} />
        <Mono label="scanner" value={[e.provider, e.ref].filter(Boolean).join(" · ") || null} />
        <Mono label="stored at" value={e.asset?.storageKey ?? null} />
        <Mono label="job" value={e.jobId} />
      </div>
      {mode === null ? (
        <div className="mt-2.5 flex flex-wrap gap-2">
          <Button size="sm" variant="danger" onClick={() => setMode("confirm")}>
            Confirm and record report
          </Button>
          <Button size="sm" variant="quiet" onClick={() => setMode("clear")}>
            Clear as false positive
          </Button>
        </div>
      ) : (
        <form
          className="mt-3 grid gap-3 rounded-xl bg-ink-900 p-3 hairline"
          onSubmit={async (ev) => {
            ev.preventDefault();
            const body = mode === "confirm" ? { action: "confirm", reportRef, reportedTo, note } : { action: "clear", note };
            const done = await act(
              `esc:${e.id}`,
              () => api(`/api/admin/review/${e.id}`, { body }),
              mode === "confirm" ? "Report recorded. The evidence stays on hold." : "Cleared. The file is viewable again and the account is reinstated.",
            );
            if (done) setMode(null);
          }}
        >
          {mode === "confirm" ? (
            <>
              <p className="text-[13px] text-bone-300">File the report first, then record its reference here. The file stays on legal hold and the account stays suspended.</p>
              <Field label="Report reference" htmlFor={`ref-${e.id}`} hint="For example the CyberTipline report number.">
                <input id={`ref-${e.id}`} className={inputClass} value={reportRef} onChange={(ev) => setReportRef(ev.target.value)} required minLength={3} maxLength={120} />
              </Field>
              <Field label="Reported to" htmlFor={`to-${e.id}`}>
                <select id={`to-${e.id}`} className={inputClass} value={reportedTo} onChange={(ev) => setReportedTo(ev.target.value as typeof reportedTo)}>
                  {REPORTED_TO.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          ) : (
            <p className="text-[13px] text-bone-300">
              Only for a confirmed false match. The file becomes viewable to its owner again, the hold lifts, the flag clears, and the account is reinstated if no other abuse flag is
              open.
            </p>
          )}
          <Field label={mode === "clear" ? "Why is this a false positive?" : "Note (optional)"} htmlFor={`note-${e.id}`}>
            <input id={`note-${e.id}`} className={inputClass} value={note} onChange={(ev) => setNote(ev.target.value)} required={mode === "clear"} minLength={mode === "clear" ? 3 : 0} maxLength={500} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" variant={mode === "confirm" ? "ember" : "ghost"} busy={busy === `esc:${e.id}`}>
              {mode === "confirm" ? "Record report" : "Clear and reinstate"}
            </Button>
            <Button type="button" size="sm" variant="quiet" onClick={() => setMode(null)}>
              Back
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}

export function EscalationQueue({ items }: { items: Escalation[] }) {
  if (!items.length) return <p className="text-sm text-bone-400">No open matches. Nothing is waiting on a report.</p>;
  return (
    <ul className="space-y-3">
      {items.map((e) => (
        <EscalationCard key={e.id} e={e} />
      ))}
    </ul>
  );
}

const CATEGORY: Record<TakedownItem["category"], string> = {
  ncii: "intimate image without consent",
  csam: "child sexual abuse",
  likeness: "my likeness",
  copyright: "copyright",
  other: "other",
};

function hoursOpen(iso: string) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
}

function TakedownCard({ t }: { t: TakedownItem }) {
  const { busy, act } = useAct();
  const [note, setNote] = useState("");
  const urgent = t.category === "ncii" || t.category === "csam" || t.category === "likeness";
  const hours = hoursOpen(t.createdAt);
  const send = (action: "action" | "dismiss") =>
    act(`td:${t.id}:${action}`, () => api(`/api/admin/takedowns/${t.id}`, { body: { action, note } }), action === "action" ? "Taken down." : "Dismissed.");
  return (
    <li className="rounded-xl bg-ink-850 p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={urgent ? "danger" : "plain"}>{CATEGORY[t.category]}</Badge>
        <Badge>{t.targetType}</Badge>
        <span className={`font-mono text-[11px] ${urgent && hours >= 24 ? "text-brass-300" : "text-bone-500"}`}>
          open {hours < 1 ? "under an hour" : `${hours}h`} · {t.requester}
        </span>
      </div>
      <p className="mt-1.5 break-all text-[13px] text-bone-100">
        {t.targetType === "template" ? (
          <Link href={`/templates/${t.targetRef}`} target="_blank" className="inline-flex items-center gap-1 hover:text-ember-400">
            {t.targetLabel ?? t.targetRef} <ExternalLink size={12} aria-hidden />
          </Link>
        ) : (
          <span className="font-mono text-[12px]">{t.targetRef}</span>
        )}
      </p>
      {t.details ? <p className="mt-1.5 whitespace-pre-line text-[13px] text-bone-300">{t.details}</p> : null}
      <div className="mt-2.5 grid gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <Field label="Note" htmlFor={`tdn-${t.id}`} hint="Required to dismiss.">
          <input id={`tdn-${t.id}`} className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </Field>
        <Button size="sm" variant="danger" busy={busy === `td:${t.id}:action`} onClick={() => void send("action")}>
          Action
        </Button>
        <Button size="sm" variant="quiet" busy={busy === `td:${t.id}:dismiss`} disabled={note.trim().length < 3} onClick={() => void send("dismiss")}>
          Dismiss
        </Button>
      </div>
    </li>
  );
}

export function TakedownQueue({ items }: { items: TakedownItem[] }) {
  if (!items.length) return <p className="text-sm text-bone-400">No open takedown requests.</p>;
  return (
    <ul className="space-y-3">
      {items.map((t) => (
        <TakedownCard key={t.id} t={t} />
      ))}
    </ul>
  );
}

const REPORTED_LABEL: Record<string, string> = Object.fromEntries(REPORTED_TO);

export function ClosedList({ escalations, takedowns }: { escalations: Escalation[]; takedowns: TakedownItem[] }) {
  if (!escalations.length && !takedowns.length) return <p className="text-sm text-bone-400">Nothing closed yet.</p>;
  return (
    <ul className="divide-y divide-bone-50/5 text-[12.5px]">
      {escalations.map((e) => (
        <li key={e.id} className="flex flex-wrap gap-x-3 gap-y-1 py-2">
          <span className="text-bone-500">{e.resolvedAt ? relativeTime(e.resolvedAt) : ""}</span>
          <span className="text-bone-100">{e.resolution?.kind === "false_positive" ? "Cleared as false positive" : "Report recorded"}</span>
          {e.resolution?.reportRef ? (
            <span className="font-mono text-bone-400">
              {REPORTED_LABEL[e.resolution.reportedTo ?? ""] ?? e.resolution.reportedTo} · {e.resolution.reportRef}
            </span>
          ) : null}
          <span className="font-mono text-bone-500">asset {e.asset?.id.slice(0, 8) ?? "?"}</span>
          {e.resolution?.by ? <span className="text-bone-500">by @{e.resolution.by}</span> : null}
        </li>
      ))}
      {takedowns.map((t) => (
        <li key={t.id} className="flex flex-wrap gap-x-3 gap-y-1 py-2">
          <span className="text-bone-500">{t.resolvedAt ? relativeTime(t.resolvedAt) : ""}</span>
          <span className="text-bone-100">Takedown {t.status}</span>
          <span className="text-bone-400">{CATEGORY[t.category]}</span>
          {t.resolutionNote ? <span className="text-bone-500">“{t.resolutionNote}”</span> : null}
        </li>
      ))}
    </ul>
  );
}
