"use client";

import { AgeVerificationCard } from "./age-verification-card";
import { LogOut, ShieldCheck, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { Badge, Button, Chip, Field, Sheet, Toggle, inputClass, useToast } from "./ui";

type Settings = {
  profile: { displayName: string; handle: string; bio: string };
  preferences: { personalizationEnabled: boolean; historyEnabled: boolean; autoplayPreviews: boolean; copilotEnabled: boolean; interests: string[] };
  consents: { id: string; kind: string; statement: string; subjectLabel: string | null; grantedAt: string; withdrawnAt: string | null }[];
  activeSessions: number;
  popularTags: string[];
};

const CONSENT_LABEL: Record<string, string> = {
  terms: "Terms and content policy",
  adult_attestation: "Adult confirmation",
  upload_subject: "Upload",
  likeness: "Character likeness",
  training_data: "Training data",
};

function Section({ title, kicker, children }: { title: string; kicker?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[24px_8px_24px_8px] bg-ink-900/70 p-5 hairline sm:p-6">
      {kicker ? <p className="tag text-ember-400">{kicker}</p> : null}
      <h2 className="mb-4 font-display text-2xl">{title}</h2>
      {children}
    </section>
  );
}

export function SettingsView({ data, email }: { data: Settings; email: string }) {
  const router = useRouter();
  const toast = useToast();
  const [profile, setProfile] = useState(data.profile);
  const [profileErr, setProfileErr] = useState<Record<string, string[]>>({});
  const [prefs, setPrefs] = useState(data.preferences);
  const [busy, setBusy] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState<Settings["consents"][number] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [password, setPassword] = useState("");

  async function run(key: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(key);
    try {
      await fn();
      if (ok) toast({ message: ok, tone: "success" });
      router.refresh();
      return true;
    } catch (e) {
      toast({ message: e instanceof ApiError ? e.message : "That did not work.", tone: "error" });
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function setPref<K extends keyof Settings["preferences"]>(key: K, value: Settings["preferences"][K]) {
    const prev = prefs;
    setPrefs({ ...prefs, [key]: value });
    const ok = await run(`pref:${key}`, () => api("/api/me/preferences", { method: "PATCH", body: { [key]: value } }));
    if (!ok) setPrefs(prev);
  }

  const active = data.consents.filter((c) => !c.withdrawnAt);
  const past = data.consents.filter((c) => c.withdrawnAt);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <p className="tag text-ember-400">{email}</p>
        <h1 className="font-display text-4xl">Settings</h1>
      </div>

      <Section title="Profile">
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setProfileErr({});
            setBusy("profile");
            try {
              await api("/api/me", { method: "PATCH", body: profile });
              toast({ message: "Profile saved.", tone: "success" });
              router.refresh();
            } catch (err) {
              if (err instanceof ApiError) {
                const d = err.details as { fieldErrors?: Record<string, string[]> } | undefined;
                setProfileErr(d?.fieldErrors ?? {});
                toast({ message: err.message, tone: "error" });
              }
            } finally {
              setBusy(null);
            }
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Display name" htmlFor="dn" error={profileErr.displayName?.[0]}>
              <input id="dn" className={inputClass} value={profile.displayName} onChange={(e) => setProfile({ ...profile, displayName: e.target.value })} maxLength={40} required />
            </Field>
            <Field label="Handle" htmlFor="hd" error={profileErr.handle?.[0]} hint="Your public page lives at /creators/handle.">
              <input id="hd" className={inputClass} value={profile.handle} onChange={(e) => setProfile({ ...profile, handle: e.target.value })} maxLength={24} required />
            </Field>
          </div>
          <Field label="Bio" htmlFor="bio" error={profileErr.bio?.[0]}>
            <textarea id="bio" className={inputClass} rows={2} value={profile.bio} onChange={(e) => setProfile({ ...profile, bio: e.target.value })} maxLength={280} />
          </Field>
          <Button type="submit" variant="ember" size="sm" busy={busy === "profile"}>
            Save profile
          </Button>
        </form>
      </Section>

      <Section title="Discovery and privacy">
        <div className="divide-y divide-bone-50/5">
          <Toggle
            label="Personalize For You"
            description="Uses the categories and tags of templates you saved, made or viewed. Nothing about you is inferred beyond that. Off shows what is trending instead."
            checked={prefs.personalizationEnabled}
            onChange={(v) => setPref("personalizationEnabled", v)}
            disabled={busy === "pref:personalizationEnabled"}
          />
          <Toggle
            label="Keep viewing history"
            description="Powers Continue exploring. Turning it off also deletes the history recorded so far."
            checked={prefs.historyEnabled}
            onChange={(v) => setPref("historyEnabled", v)}
            disabled={busy === "pref:historyEnabled"}
          />
          <Toggle label="Autoplay previews" description="Plays video template previews on Discover without hovering." checked={prefs.autoplayPreviews} onChange={(v) => setPref("autoplayPreviews", v)} />
          <Toggle
            label="Creative assistant"
            description="Suggestions while you write a prompt. Off hides them, except warnings that would stop a creation from working."
            checked={prefs.copilotEnabled}
            onChange={(v) => setPref("copilotEnabled", v)}
          />
        </div>
        <div className="mt-4">
          <p className="mb-2 text-sm text-bone-200">Interests</p>
          <p className="mb-3 text-[12.5px] text-bone-400">Pick tags you want more of. They count toward For You even before you have history.</p>
          <div className="flex flex-wrap gap-2">
            {[...new Set([...prefs.interests, ...data.popularTags])].map((t) => (
              <Chip
                key={t}
                active={prefs.interests.includes(t)}
                onClick={() => setPref("interests", prefs.interests.includes(t) ? prefs.interests.filter((x) => x !== t) : [...prefs.interests, t].slice(0, 12))}
              >
                {t}
              </Chip>
            ))}
          </div>
        </div>
        <div className="mt-5">
          <Button size="sm" variant="ghost" busy={busy === "history"} onClick={() => run("history", () => api("/api/me/history", { method: "DELETE" }), "History cleared.")}>
            Clear history now
          </Button>
        </div>
      </Section>

      <Section title="Consents" kicker="What you agreed to, and when">
        <ul className="space-y-3">
          {active.map((c) => (
            <li key={c.id} className="flex items-start gap-3 rounded-xl bg-ink-850 p-3">
              <ShieldCheck size={16} className="mt-0.5 shrink-0 text-sage-400" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-bone-100">
                  {CONSENT_LABEL[c.kind] ?? c.kind}
                  {c.subjectLabel ? <span className="text-bone-400"> · {c.subjectLabel}</span> : null}
                </p>
                <p className="mt-0.5 text-[12.5px] text-bone-400">{c.statement}</p>
                <p className="mt-1 font-mono text-[11px] text-bone-500">granted {relativeTime(c.grantedAt)}</p>
              </div>
              {c.kind === "terms" || c.kind === "adult_attestation" ? null : (
                <Button size="sm" variant="quiet" onClick={() => setWithdrawing(c)}>
                  Withdraw
                </Button>
              )}
            </li>
          ))}
        </ul>
        {past.length ? (
          <details className="mt-4">
            <summary className="cursor-pointer text-[13px] text-bone-400">{past.length} withdrawn</summary>
            <ul className="mt-2 space-y-1 text-[12.5px] text-bone-500">
              {past.map((c) => (
                <li key={c.id}>
                  {CONSENT_LABEL[c.kind] ?? c.kind}
                  {c.subjectLabel ? ` · ${c.subjectLabel}` : ""} · withdrawn {relativeTime(c.withdrawnAt!)}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </Section>

      <AgeVerificationCard data={data} />

      <Section title="Account">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-bone-300">
            Signed in on {data.activeSessions} {data.activeSessions === 1 ? "device" : "devices"}.
          </p>
          <Button
            size="sm"
            variant="ghost"
            busy={busy === "sessions"}
            onClick={async () => {
              if (await run("sessions", () => api("/api/me/sessions", { method: "DELETE" }))) window.location.assign("/auth");
            }}
          >
            <LogOut size={14} aria-hidden /> Sign out everywhere
          </Button>
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-bone-50/5 pt-5">
          <p className="text-sm text-bone-300">Delete your account, creations, uploads and templates.</p>
          <Button size="sm" variant="danger" onClick={() => setDeleting(true)}>
            <Trash2 size={14} aria-hidden /> Delete account
          </Button>
        </div>
      </Section>

      <Sheet open={Boolean(withdrawing)} onClose={() => setWithdrawing(null)} title="Withdraw consent?">
        <p className="text-sm text-bone-300">
          Everything this consent covered is deleted: the {withdrawing?.kind === "likeness" ? "character reference" : "upload"} and every creation made from it, including the stored files. It cannot be undone.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="quiet" onClick={() => setWithdrawing(null)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            busy={busy === "withdraw"}
            onClick={async () => {
              if (withdrawing && (await run("withdraw", () => api(`/api/me/consents/${withdrawing.id}`, { method: "DELETE" }), "Consent withdrawn and content deleted."))) setWithdrawing(null);
            }}
          >
            Withdraw and delete
          </Button>
        </div>
      </Sheet>

      <Sheet open={deleting} onClose={() => setDeleting(false)} title="Delete your account?">
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await run("delete", () => api("/api/me", { method: "DELETE", body: { password } }))) window.location.assign("/");
          }}
        >
          <p className="text-sm text-bone-300">
            You are signed out everywhere, your public templates come down, and your creations and uploads are deleted. Unused credits are not refunded automatically. This cannot be undone.
          </p>
          <Badge tone="danger">Permanent</Badge>
          <Field label="Password" htmlFor="dp">
            <input id="dp" type="password" autoComplete="current-password" className={inputClass} value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <Button type="submit" variant="danger" className="w-full" busy={busy === "delete"}>
            Delete my account
          </Button>
        </form>
      </Sheet>
    </div>
  );
}
