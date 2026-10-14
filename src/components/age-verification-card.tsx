"use client";

import { ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { Badge, Button, useToast } from "./ui";

/** Mirrors `ageVerificationFor` in src/server/me.ts; kept structural so Settings only needs one line to mount the card. */
export type AgeVerificationSummary = {
  status: "unverified" | "pending" | "verified" | "failed" | "expired";
  jurisdiction: string | null;
  required: boolean;
  verifiedAt: string | null;
  expiresAt: string | null;
  verifyPath: string;
  provider: { key: string; label: string; sandbox: boolean; configured: boolean; methods: string[]; validDays: number; enforce: boolean };
  history: { id: string; provider: string; status: string; method: string | null; jurisdiction: string | null; failureReason: string | null; startedAt: string; completedAt: string | null; expiresAt: string | null }[];
};

const STATUS_LABEL: Record<AgeVerificationSummary["status"], string> = {
  unverified: "Not verified",
  pending: "In progress",
  verified: "Verified",
  failed: "Not passed",
  expired: "Expired",
};

const REASON_LABEL: Record<string, string> = {
  not_over_threshold: "the check did not confirm you are over 18",
  provider_error: "the provider reported an error",
  cancelled: "the check was cancelled",
  session_expired: "the check timed out",
  start_failed: "the provider did not respond",
  sandbox_simulated_failure: "a simulated failure (sandbox)",
};

function jurisdictionLabel(code: string | null) {
  if (!code) return "unknown";
  if (code === "GB") return "United Kingdom";
  if (code.startsWith("US-")) return `United States · ${code.slice(3)}`;
  if (code === "US") return "United States";
  return code;
}

/** `data` is the whole Settings payload; the card reads only its own slice, so Settings mounts it with one line and no type change. */
export function AgeVerificationCard({ data }: { data: { ageVerification?: AgeVerificationSummary } & Record<string, unknown> }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const v = data.ageVerification;
  if (!v) return null;

  const latest = v.history.at(-1) ?? null;
  const canStart = v.status !== "verified" && v.provider.configured;
  const tone = v.status === "verified" ? "new" : v.status === "pending" ? "plain" : v.required ? "warn" : "plain";

  async function start() {
    setBusy(true);
    try {
      const res = await api<{ url: string; sandbox: boolean }>("/api/age-verification/start", { method: "POST", body: {} });
      window.location.assign(res.url);
    } catch (e) {
      toast({ message: e instanceof ApiError ? e.message : "Could not start the age check.", tone: "error" });
      setBusy(false);
      router.refresh();
    }
  }

  return (
    <section id="age-verification" className="scroll-mt-24 rounded-[24px_8px_24px_8px] bg-ink-900/70 p-5 hairline sm:p-6">
      <p className="tag text-ember-400">Age verification</p>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 className="font-display text-2xl">Your age check</h2>
        <Badge tone={tone}>{STATUS_LABEL[v.status]}</Badge>
        {v.provider.sandbox ? <Badge tone="demo">Sandbox</Badge> : null}
      </div>

      <dl className="grid gap-x-6 gap-y-2 text-[13.5px] sm:grid-cols-2">
        <div>
          <dt className="text-bone-500">Where you seem to be</dt>
          <dd className="text-bone-100">{jurisdictionLabel(v.jurisdiction)}</dd>
        </div>
        <div>
          <dt className="text-bone-500">What that means</dt>
          <dd className="text-bone-100">
            {!v.provider.enforce
              ? "Age checks are switched off on this server."
              : v.required
                ? "Your region requires a provider age check before you create, upload or see previews."
                : "No provider check is required where you are. Your date of birth at signup is enough."}
          </dd>
        </div>
        {v.status === "verified" && v.verifiedAt ? (
          <div>
            <dt className="text-bone-500">Verified</dt>
            <dd className="text-bone-100" suppressHydrationWarning>
              {relativeTime(v.verifiedAt)}
              {v.expiresAt ? <span className="text-bone-400" suppressHydrationWarning> · good until {new Date(v.expiresAt).toLocaleDateString()}</span> : null}
            </dd>
          </div>
        ) : null}
        {v.status === "expired" ? (
          <div>
            <dt className="text-bone-500">Expired</dt>
            <dd className="text-bone-100">A check lasts {v.provider.validDays} days. Yours has lapsed, so please do it again.</dd>
          </div>
        ) : null}
        {v.status === "failed" && latest ? (
          <div>
            <dt className="text-bone-500">Last attempt</dt>
            <dd className="text-bone-100">Not passed: {REASON_LABEL[latest.failureReason ?? ""] ?? "the provider did not confirm your age"}. You can try again.</dd>
          </div>
        ) : null}
        <div>
          <dt className="text-bone-500">Provider</dt>
          <dd className="text-bone-100">
            {v.provider.label}
            {v.provider.sandbox ? <span className="text-iris-300"> · a labeled demo that proves nothing</span> : null}
            {!v.provider.configured ? <span className="text-bone-400"> · not set up on this server</span> : null}
          </dd>
        </div>
      </dl>

      <p className="mt-4 text-[12.5px] text-bone-400">
        {v.provider.sandbox
          ? "With the sandbox you pick the outcome yourself. A real provider offers a document scan with a liveness check or a facial age estimate; it keeps the images, we keep only the result, its reference and the dates."
          : "The check happens on the provider's site with a document scan and liveness check, or a facial age estimate. We never see or keep your ID images or biometrics, only the result, its reference and the dates."}
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        {canStart ? (
          <Button variant={v.required ? "ember" : "ghost"} busy={busy} onClick={start}>
            <ShieldCheck size={16} aria-hidden /> {v.status === "pending" ? "Continue the check" : v.status === "unverified" ? "Verify now" : "Verify again"}
          </Button>
        ) : null}
        {v.status === "verified" ? (
          <p className="inline-flex items-center gap-1.5 text-sm text-sage-400">
            <ShieldCheck size={16} aria-hidden /> You are all set.
          </p>
        ) : null}
      </div>

      {v.history.length ? (
        <details className="mt-4">
          <summary className="cursor-pointer text-[13px] text-bone-400">{v.history.length} {v.history.length === 1 ? "attempt" : "attempts"}</summary>
          <ul className="mt-2 space-y-1 text-[12.5px] text-bone-500">
            {v.history.map((h) => (
              <li key={h.id} suppressHydrationWarning>
                {h.status} · {h.provider}
                {h.method ? ` · ${h.method}` : ""} · started {relativeTime(h.startedAt)}
                {h.completedAt ? ` · finished ${relativeTime(h.completedAt)}` : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
