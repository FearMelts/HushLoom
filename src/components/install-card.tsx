"use client";

import { Download, Share } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { captureInstallPrompt, promptInstall, useInstallState, type InstallState } from "@/lib/pwa";
import { Badge, Button, useToast } from "./ui";

const COPY: Record<Exclude<InstallState, "ios">, string> = {
  installed: "You're using the app. It opens full screen from your home screen or app list.",
  available: "Opens full screen from your home screen or dock, like any app. No app store involved.",
  unavailable:
    "Your browser hasn't offered to install Hushloom here. If it's already installed, open it from your apps; otherwise look for Install app or Add to Home screen in the browser menu.",
};

/**
 * Settings › On this device. The only place Hushloom offers install (no popups): the browser's own
 * offer when it has one, the Share › Add to Home Screen steps on iPhone and iPad, and "Installed"
 * when running as the app. Other device settings (notifications) render inside as children.
 */
export function InstallCard({ children }: { children?: ReactNode }) {
  const state = useInstallState();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  useEffect(() => captureInstallPrompt(), []);

  async function install() {
    setBusy(true);
    try {
      const outcome = await promptInstall();
      if (outcome === "accepted") toast({ message: "Installing Hushloom.", tone: "success" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="device" className="scroll-mt-24 rounded-[24px_8px_24px_8px] bg-ink-900/70 p-5 hairline sm:p-6">
      <p className="tag text-ember-400">App and notifications</p>
      <h2 className="mb-4 font-display text-2xl">On this device</h2>
      <div className="flex flex-wrap items-start justify-between gap-3 py-1">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm text-bone-50">
            Install Hushloom
            {state === "installed" ? <Badge tone="new">Installed</Badge> : null}
          </p>
          {state === "ios" ? (
            <p className="mt-0.5 text-[12.5px] text-bone-400">
              On iPhone or iPad: tap <Share size={13} className="inline -translate-y-px" aria-hidden /> Share, then <span className="text-bone-200">Add to Home Screen</span>.
              Notifications work once Hushloom is on your Home Screen.
            </p>
          ) : (
            <p className="mt-0.5 text-[12.5px] text-bone-400">{COPY[state]}</p>
          )}
        </div>
        {state === "available" ? (
          <Button size="sm" variant="ember" busy={busy} onClick={install}>
            <Download size={14} aria-hidden /> Install Hushloom
          </Button>
        ) : null}
      </div>
      {children ? <div className="mt-3 border-t border-bone-50/5 pt-1">{children}</div> : null}
    </section>
  );
}
