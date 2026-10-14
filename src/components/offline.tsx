"use client";

import { WifiOff } from "lucide-react";
import Link from "next/link";
import { useEffect, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useOnline } from "@/lib/use-online";
import { Wordmark } from "./shell";
import { buttonClass } from "./ui";

export const OFFLINE_MESSAGE = "You're offline. Nothing is queued; try again when you're back.";

/** The slim bar under the top bar while the device is offline. */
export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div role="status" className="flex items-center justify-center gap-2 border-t border-[var(--line)] bg-brass-300/10 px-4 py-1.5 text-center text-[12.5px] text-brass-300">
      <WifiOff size={14} className="shrink-0" aria-hidden />
      {OFFLINE_MESSAGE}
    </div>
  );
}

/**
 * Wrap any Make / Confirm / Buy control: while offline every button and field inside is disabled
 * (a native disabled fieldset), so nothing chargeable is started or queued without a connection.
 * The server enforces everything else; this only keeps people from pressing a button that cannot work.
 *
 *   <OfflineGuard><Button onClick={confirm}>Confirm · 4 credits</Button></OfflineGuard>
 */
export function OfflineGuard({ children, className, note = true }: { children: ReactNode; className?: string; note?: boolean }) {
  const online = useOnline();
  return (
    <fieldset disabled={!online} className={cn("m-0 min-w-0 border-0 p-0", className)}>
      {children}
      {!online && note ? <p className="mt-2 text-[12.5px] text-brass-300">{OFFLINE_MESSAGE}</p> : null}
    </fieldset>
  );
}

/**
 * The /offline page, also what the service worker shows for a public page it cannot reach. It
 * renders without the signed-in shell, so the cached copy holds nothing about anyone. "Try again"
 * is a plain link to the current address, so it works before (or without) JavaScript.
 */
export function OfflineScreen() {
  useEffect(() => {
    // Shown in place of another page: load that page as soon as the connection is back.
    if (window.location.pathname === "/offline") return;
    const back = () => window.location.reload();
    window.addEventListener("online", back);
    return () => window.removeEventListener("online", back);
  }, []);
  return (
    <main className="grid min-h-dvh place-items-center px-5">
      <div className="petal hairline w-full max-w-md bg-ink-900/80 p-7 text-center backdrop-blur animate-rise">
        <Wordmark className="justify-center" />
        <p className="tag mt-6 text-ember-400">No connection</p>
        <h1 className="mt-1 font-display text-3xl">You&apos;re offline</h1>
        <p className="mt-3 text-[15px] text-bone-300">Nothing is queued; try again when you&apos;re back.</p>
        <p className="mt-2 text-[12.5px] text-bone-500">Your creations stay on the server. Nothing you make is stored on this device.</p>
        <div className="mt-7 flex flex-col gap-2.5">
          <a href="" className={buttonClass("ember", "lg")}>
            Try again
          </a>
          <Link href="/" className={buttonClass("quiet", "lg")}>
            Go to Discover
          </Link>
        </div>
      </div>
    </main>
  );
}
