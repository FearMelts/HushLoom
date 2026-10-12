"use client";

import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { Button, useToast } from "./ui";

export function BuyButton({ itemKey, signedIn, configured, label, featured }: { itemKey: string; signedIn: boolean; configured: boolean; label: string; featured?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant={featured ? "ember" : "ghost"}
      className="w-full"
      busy={busy}
      disabled={signedIn && !configured}
      title={signedIn && !configured ? "Payments are not configured on this server yet." : undefined}
      onClick={async () => {
        if (!signedIn) return router.push("/auth?next=/pricing");
        setBusy(true);
        try {
          const { url } = await api<{ url: string }>("/api/checkout", { body: { itemKey } });
          window.location.assign(url);
        } catch (e) {
          toast({ message: e instanceof ApiError ? e.message : "Checkout could not start.", tone: "error" });
          setBusy(false);
        }
      }}
    >
      {label}
    </Button>
  );
}

export function PerkList({ perks, className }: { perks: readonly string[]; className?: string }) {
  return (
    <ul className={cn("space-y-1.5 text-[13px] text-bone-300", className)}>
      {perks.map((p) => (
        <li key={p} className="flex items-start gap-2">
          <Check size={14} className="mt-0.5 shrink-0 text-sage-400" aria-hidden /> {p}
        </li>
      ))}
    </ul>
  );
}
