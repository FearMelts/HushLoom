"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { STATUS_LABEL, elapsed } from "@/lib/format";
import { useOnline } from "@/lib/use-online";
import { useToast } from "./ui";

export type JobSummary = {
  id: string;
  status: string;
  mode: string;
  prompt: string;
  isDemo: boolean;
  createdAt: string;
  queuedAt: string | null;
  startedAt: string | null;
  failureMessage: string | null;
};

export const JOB_STARTED_EVENT = "hl:job-started";
/** Dispatched on window when a running job leaves the active list (completed, failed or cancelled). detail: { id } */
export const JOB_FINISHED_EVENT = "hl:job-finished";
/** Dispatched on window when a running job moves between queued and processing. detail: { id, status } */
export const JOB_UPDATED_EVENT = "hl:job-updated";

/**
 * Pages that show job state (Studio, a project) subscribe here instead of running their own
 * timers: the tray is the one poller, and it says when something changed. Calling preventDefault
 * on the finished event tells the tray this page refreshes itself, so it does not refresh twice.
 * Several changes from one poll are coalesced into one call.
 */
export function useJobEvents(onChange: () => void) {
  const handler = useRef(onChange);
  useEffect(() => {
    handler.current = onChange;
  });
  useEffect(() => {
    let queued = false;
    const fire = (e: Event) => {
      e.preventDefault();
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        handler.current();
      });
    };
    window.addEventListener(JOB_FINISHED_EVENT, fire);
    window.addEventListener(JOB_UPDATED_EVENT, fire);
    return () => {
      window.removeEventListener(JOB_FINISHED_EVENT, fire);
      window.removeEventListener(JOB_UPDATED_EVENT, fire);
    };
  }, []);
}

function subscribeVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/** Whether the tab is in the foreground. The server render assumes it is. */
function usePageVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, () => !document.hidden, () => true);
}

/**
 * Persistent status for running creations. Polls only while something is
 * running, and shows real states with elapsed time; there is no invented progress bar.
 * Offline it stops polling and says so; the jobs keep running on the server.
 * It polls every 3 s in the foreground and every 15 s in a background tab, and catches up at
 * once when the tab comes back.
 */
export function JobTray() {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [open, setOpen] = useState(true);
  const [, tick] = useState(0);
  const known = useRef(new Map<string, string>());
  const router = useRouter();
  const toast = useToast();
  const online = useOnline();
  const visible = usePageVisible();
  const tray = useRef<HTMLElement>(null);

  const poll = useCallback(async () => {
    try {
      const { items } = await api<{ items: JobSummary[] }>("/api/generations?active=1");
      let refresh = false;
      for (const [prev, prevStatus] of known.current) {
        const now = items.find((j) => j.id === prev);
        if (now && now.status !== prevStatus) window.dispatchEvent(new CustomEvent(JOB_UPDATED_EVENT, { detail: { id: prev, status: now.status }, cancelable: true }));
        if (!now) {
          // A listening page refreshes itself (it cancels the event); otherwise the tray refreshes the page.
          if (window.dispatchEvent(new CustomEvent(JOB_FINISHED_EVENT, { detail: { id: prev }, cancelable: true }))) refresh = true;
          // Look up the final state of jobs that just left the active list.
          api<{ job: JobSummary }>(`/api/generations/${prev}`)
            .then(({ job }) => {
              if (job.status === "completed") toast({ message: job.isDemo ? "Demo creation ready." : "Your creation is ready.", tone: "success", action: { label: "Open", href: `/collection/${job.id}` } });
              else if (job.status === "failed") toast({ message: job.failureMessage ?? "A creation failed.", tone: "error", action: { label: "View", href: `/collection/${job.id}` } });
            })
            .catch(() => undefined);
          known.current.delete(prev);
        }
      }
      for (const j of items) known.current.set(j.id, j.status);
      setJobs(items);
      if (refresh) router.refresh();
    } catch {
      // Signed out or offline: stay quiet; the next event retries.
    }
  }, [router, toast]);

  useEffect(() => {
    void poll();
    const onStart = () => {
      setOpen(true);
      void poll();
    };
    window.addEventListener(JOB_STARTED_EVENT, onStart);
    return () => window.removeEventListener(JOB_STARTED_EVENT, onStart);
  }, [poll]);

  const wasOnline = useRef(true);
  useEffect(() => {
    // Back online: catch up at once instead of waiting for the next tick.
    if (online && !wasOnline.current) void poll();
    wasOnline.current = online;
  }, [online, poll]);

  const wasVisible = useRef(true);
  useEffect(() => {
    // Back in the foreground: catch up now, then the interval below re-arms at the 3 s cadence.
    if (visible && !wasVisible.current && known.current.size) void poll();
    wasVisible.current = visible;
  }, [visible, poll]);

  useEffect(() => {
    if (jobs.length === 0 || !online) return;
    const p = setInterval(() => void poll(), visible ? 3000 : 15000);
    // The elapsed-time tick only matters while someone can see it.
    const t = visible ? setInterval(() => tick((n) => n + 1), 1000) : undefined;
    return () => {
      clearInterval(p);
      if (t) clearInterval(t);
    };
  }, [jobs.length, online, visible, poll]);

  // Publish the tray's height so toasts on phones (and small laptops) stack above it, not over it.
  useEffect(() => {
    const el = tray.current;
    const root = document.documentElement;
    if (!el) {
      root.style.removeProperty("--tray-h");
      return;
    }
    const set = () => root.style.setProperty("--tray-h", `${Math.ceil(el.getBoundingClientRect().height)}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--tray-h");
    };
  }, [jobs.length]);

  if (jobs.length === 0) return null;

  return (
    <section
      ref={tray}
      aria-label="Creations in progress"
      className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom)+var(--dock-h,0px))] right-3 z-40 w-[min(340px,calc(100vw-24px))] overflow-hidden rounded-2xl bg-ink-850/95 shadow-float hairline backdrop-blur lg:bottom-5 lg:right-5"
    >
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-3 px-4 py-3 text-left" aria-expanded={open}>
        <span className="relative h-1.5 w-8 overflow-hidden rounded-full bg-ink-700" aria-hidden>
          {online ? <span className="absolute inset-y-0 w-1/2 rounded-full bg-ember-500 animate-thread" /> : null}
        </span>
        <span className="flex-1 text-sm font-medium">
          {jobs.length} weaving
          {online ? null : <span className="block text-[11.5px] font-normal text-brass-300">Offline · status updates when you&apos;re back</span>}
        </span>
        <ChevronDown size={16} className={cn("text-bone-400 transition-transform", !open && "rotate-180")} aria-hidden />
      </button>
      {open ? (
        <ul className="max-h-72 space-y-1 overflow-auto px-2 pb-2">
          {jobs.map((j) => (
            <li key={j.id}>
              <Link href={`/collection/${j.id}`} className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-ink-800">
                <span className={cn("size-2 shrink-0 rounded-full", j.status === "processing" ? "bg-ember-400 animate-pulse" : "bg-bone-500")} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{j.prompt}</span>
                  <span className="block text-[11.5px] text-bone-400">
                    {STATUS_LABEL[j.status]} · {elapsed(j.startedAt ?? j.queuedAt ?? j.createdAt)}
                    {j.isDemo ? " · demo" : ""}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
