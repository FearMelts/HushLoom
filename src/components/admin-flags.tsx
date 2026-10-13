"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { Badge, Button, useToast } from "./ui";

type Flag = {
  id: string;
  kind: "chargeback" | "csam_match" | "manual_review" | "credit_debt";
  reason: string;
  details: Record<string, unknown>;
  createdAt: string;
  user: { id: string; handle: string | null; email: string };
};

const TONE: Record<Flag["kind"], "danger" | "warn" | "plain"> = { chargeback: "danger", csam_match: "danger", manual_review: "warn", credit_debt: "warn" };
const LABEL: Record<Flag["kind"], string> = { chargeback: "chargeback", csam_match: "abuse match", manual_review: "review", credit_debt: "credit debt" };

/** Open account flags with a Clear action. Self-contained: it loads its own data from /api/admin/flags. */
export function AccountFlags() {
  const toast = useToast();
  const [flags, setFlags] = useState<Flag[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setFlags((await api<{ flags: Flag[] }>("/api/admin/flags")).flags);
    } catch (e) {
      toast({ message: e instanceof ApiError ? e.message : "Could not load flags.", tone: "error" });
      setFlags([]);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function clear(flag: Flag) {
    const note = window.prompt(`Clear the ${LABEL[flag.kind]} flag on @${flag.user.handle ?? flag.user.email}? Add a short note.`);
    if (note === null) return;
    setBusy(flag.id);
    try {
      await api("/api/admin/flags", { body: { action: "clear", flagId: flag.id, note } });
      toast({ message: "Flag cleared.", tone: "success" });
      await load();
    } catch (e) {
      toast({ message: e instanceof ApiError ? e.message : "That did not work.", tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  if (flags === null) return <p className="text-sm text-bone-500">Loading flags…</p>;
  if (!flags.length) return <p className="text-sm text-bone-400">No open flags.</p>;
  return (
    <ul className="space-y-3">
      {flags.map((f) => (
        <li key={f.id} className="rounded-xl bg-ink-850 p-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={TONE[f.kind]}>{LABEL[f.kind]}</Badge>
            <span className="text-sm text-bone-100">{f.user.handle ? `@${f.user.handle}` : f.user.email}</span>
            <span className="font-mono text-[11px] text-bone-500">{relativeTime(f.createdAt)}</span>
          </div>
          <p className="mt-1.5 text-[13px] text-bone-300">{f.reason}</p>
          {typeof f.details.shortfall === "number" && f.details.shortfall > 0 ? (
            <p className="mt-1 font-mono text-[11px] text-bone-500">shortfall {f.details.shortfall} credits · reversed {String(f.details.reversed ?? 0)}</p>
          ) : null}
          <div className="mt-2.5">
            <Button size="sm" variant="ghost" busy={busy === f.id} onClick={() => void clear(f)}>
              Clear flag
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
