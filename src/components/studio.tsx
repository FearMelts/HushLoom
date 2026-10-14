"use client";

import { Bookmark, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { CreationListItem } from "@/server/generation/views";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { STATUS_LABEL, elapsed, relativeTime } from "@/lib/format";
import { useJobEvents } from "./job-tray";
import { Badge, Button, useToast } from "./ui";

export function PresetList({ presets, kind }: { presets: { id: string; name: string; mode: string; modelKey: string; prompt: string }[]; kind: "image" | "video" }) {
  const router = useRouter();
  const toast = useToast();
  if (!presets.length) {
    return <p className="text-[13px] text-bone-500">Save a preset from any finished creation to start from it here.</p>;
  }
  return (
    <ul className="space-y-1.5">
      {presets.map((p) => {
        const video = p.mode.includes("video") || p.mode === "scene_continuation";
        return (
          <li key={p.id} className="flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-ink-850">
            <Bookmark size={14} className="shrink-0 text-ember-400" aria-hidden />
            <Link href={`/studio?kind=${video ? "video" : "image"}&preset=${p.id}`} className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-bone-100">{p.name}</span>
              <span className="block truncate font-mono text-[11px] text-bone-500">
                {video ? "video" : "image"} · {p.modelKey}
              </span>
            </Link>
            {(video ? "video" : "image") !== kind ? <Badge>switches</Badge> : null}
            <button
              type="button"
              className="grid size-9 shrink-0 place-items-center rounded-full text-bone-500 hover:bg-ink-800 hover:text-danger-400"
              aria-label={`Delete preset ${p.name}`}
              onClick={async () => {
                try {
                  await api(`/api/presets/${p.id}`, { method: "DELETE" });
                  router.refresh();
                } catch (e) {
                  toast({ message: e instanceof ApiError ? e.message : "Could not delete.", tone: "error" });
                }
              }}
            >
              <Trash2 size={13} aria-hidden />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Recent and running jobs with real timestamps from the server. The job tray is the only poller:
 * this list refreshes when the tray reports a job started, finished or changed state.
 */
export function JobMonitor({ items }: { items: CreationListItem[] }) {
  const router = useRouter();
  const toast = useToast();
  const [, tick] = useState(0);
  const running = items.some((i) => i.status === "queued" || i.status === "processing");
  useJobEvents(() => router.refresh());
  useEffect(() => {
    // Elapsed time only; no network.
    if (!running) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  if (!items.length) return <p className="text-[13px] text-bone-500">Nothing made yet.</p>;
  return (
    <ul className="divide-y divide-bone-50/5">
      {items.map((i) => {
        const active = i.status === "queued" || i.status === "processing";
        return (
          <li key={i.id} className="flex items-center gap-3 py-2">
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                i.status === "completed" ? "bg-sage-400" : i.status === "failed" ? "bg-danger-400" : active ? "bg-ember-500 animate-pulse" : "bg-bone-500",
              )}
              aria-hidden
            />
            <Link href={`/collection/${i.id}`} className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-bone-100">{i.prompt}</span>
              <span className="block font-mono text-[11px] text-bone-500">
                {STATUS_LABEL[i.status]} · {active ? elapsed(i.startedAt ?? i.queuedAt ?? i.createdAt) : relativeTime(i.finishedAt ?? i.createdAt)} · {i.costCredits} cr
                {i.isDemo ? " · demo" : ""}
              </span>
            </Link>
            {active ? (
              <Button
                size="sm"
                variant="quiet"
                aria-label="Cancel"
                onClick={async () => {
                  try {
                    await api(`/api/generations/${i.id}/cancel`, { body: {} });
                    toast({ message: i.status === "queued" ? "Cancelled. Credits returned." : "Stopping. Credits return when it stops." });
                    router.refresh();
                  } catch (e) {
                    toast({ message: e instanceof ApiError ? e.message : "Could not cancel.", tone: "error" });
                  }
                }}
              >
                <X size={14} aria-hidden />
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
