"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, Button, useToast } from "./ui";

type Signed = { body: string; signature: string };

/**
 * The sandbox provider's "hosted page" (addendum §2). The server pre-signed both possible
 * callbacks with the dev-only secret; a button only chooses which one to deliver to the real
 * callback route, so start → callback → signature check → status runs end to end. It proves
 * nothing about anyone's age and never runs in production.
 */
export function SandboxAgeCheck({ verified, failed, header, returnTo }: { verified: Signed; failed: Signed; header: string; returnTo: string }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<"verified" | "failed" | null>(null);

  async function deliver(kind: "verified" | "failed", signed: Signed) {
    setBusy(kind);
    try {
      const res = await fetch("/api/webhooks/age-verification/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json", [header]: signed.signature },
        body: signed.body,
        credentials: "same-origin",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        toast({ message: data?.error?.message ?? "The sandbox callback was refused.", tone: "error" });
        return;
      }
      toast({ message: kind === "verified" ? "Sandbox result delivered: verified (simulated)." : "Sandbox result delivered: failed (simulated).", tone: kind === "verified" ? "success" : "plain" });
      router.push(returnTo);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-lg">
      <div className="petal hairline bg-ink-900/80 p-6 sm:p-8">
        <Badge tone="demo">Sandbox</Badge>
        <h1 className="mt-4 font-display text-4xl leading-tight sm:text-5xl">
          This is a <em className="text-iris-300">sandbox</em> age check.
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-bone-300">
          It proves nothing about anyone&apos;s age. No document is read, no face is looked at, nothing leaves this server. It exists so the
          whole flow can be exercised before a real provider is connected, and it cannot run in production.
        </p>
        <div className="mt-7 flex flex-col gap-2.5 sm:flex-row">
          <Button variant="ember" size="lg" busy={busy === "verified"} disabled={busy !== null} onClick={() => deliver("verified", verified)}>
            Simulate verified
          </Button>
          <Button variant="ghost" size="lg" busy={busy === "failed"} disabled={busy !== null} onClick={() => deliver("failed", failed)}>
            Simulate failed
          </Button>
        </div>
        <p className="mt-6 font-mono text-[11px] uppercase tracking-[0.08em] text-bone-500">Demo · not age verification</p>
      </div>
    </div>
  );
}
