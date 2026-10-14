"use client";

import { CheckCircle2 } from "lucide-react";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Button, Field, inputClass } from "./ui";

const CATEGORIES = [
  ["ncii", "An intimate image or video of me shared without my consent"],
  ["likeness", "My face or body used without my consent"],
  ["csam", "Someone who is or looks under 18"],
  ["copyright", "My copyrighted work"],
  ["other", "Something else"],
] as const;

type FieldErrors = Partial<Record<"target" | "email" | "goodFaith" | "category", string>>;

/** The public takedown request form. Works signed out; a person reviews every request. */
export function TakedownForm({ signedIn, initialTarget }: { signedIn: boolean; initialTarget: string }) {
  const [category, setCategory] = useState<(typeof CATEGORIES)[number][0]>("ncii");
  const [target, setTarget] = useState(initialTarget);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [details, setDetails] = useState("");
  const [goodFaith, setGoodFaith] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  if (sent) {
    return (
      <div className="petal bg-ink-900/70 p-6 hairline" role="status">
        <CheckCircle2 className="text-sage-400" size={22} aria-hidden />
        <h2 className="mt-3 font-display text-2xl">We have your request</h2>
        <p className="mt-2 text-sm text-bone-300">
          A person reviews every request, the most harmful ones first. If we need more from you, we will write{signedIn && !email ? " to your account email" : " to the address you gave"}.
          You do not need to send it again.
        </p>
      </div>
    );
  }

  return (
    <form
      className="petal space-y-5 bg-ink-900/70 p-6 hairline"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        setFailure(null);
        const next: FieldErrors = {};
        if (target.trim().length < 3) next.target = "Paste the link, or the id from the page.";
        if (!signedIn && !email.trim()) next.email = "Add an email so we can reach you.";
        if (!goodFaith) next.goodFaith = "Confirm the statement to send the request.";
        setErrors(next);
        if (Object.keys(next).length) return;
        setBusy(true);
        try {
          await api("/api/takedowns", { body: { category, target, email, name, details, goodFaith } });
          setSent(true);
        } catch (err) {
          const fe = err instanceof ApiError ? (err.details as { fieldErrors?: Record<string, string[]> } | undefined)?.fieldErrors : undefined;
          if (fe) setErrors(Object.fromEntries(Object.entries(fe).map(([k, v]) => [k, v[0]])) as FieldErrors);
          setFailure(err instanceof ApiError ? err.message : "That did not send. Try again in a moment.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset className="space-y-2">
        <legend className="mb-2 text-[13px] font-medium text-bone-200">What is it?</legend>
        {CATEGORIES.map(([value, label]) => (
          <label key={value} className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm hairline has-[:checked]:bg-ink-800">
            <input type="radio" name="category" value={value} checked={category === value} onChange={() => setCategory(value)} className="accent-[var(--color-ember-500)]" />
            {label}
          </label>
        ))}
      </fieldset>
      <Field label="Where is it?" htmlFor="td-target" hint="A link to the template or creation, or its id." error={errors.target}>
        <input id="td-target" className={inputClass} value={target} onChange={(e) => setTarget(e.target.value)} maxLength={500} placeholder="https://… or an id" aria-invalid={Boolean(errors.target)} />
      </Field>
      <Field label={signedIn ? "Email (optional)" : "Your email"} htmlFor="td-email" hint={signedIn ? "Leave it empty to use your account." : "Only to reach you about this request."} error={errors.email}>
        <input id="td-email" type="email" autoComplete="email" className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} aria-invalid={Boolean(errors.email)} />
      </Field>
      <Field label="Your name (optional)" htmlFor="td-name" hint="Counts as your signature on the request.">
        <input id="td-name" autoComplete="name" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
      </Field>
      <Field label="Anything that helps us find it (optional)" htmlFor="td-details">
        <textarea id="td-details" rows={3} className={inputClass} value={details} onChange={(e) => setDetails(e.target.value)} maxLength={2000} />
      </Field>
      <div className="space-y-1.5">
        <label className="flex items-start gap-3 text-sm text-bone-200">
          <input type="checkbox" checked={goodFaith} onChange={(e) => setGoodFaith(e.target.checked)} className="mt-0.5 accent-[var(--color-ember-500)]" aria-invalid={Boolean(errors.goodFaith)} />
          <span>I believe in good faith that this content is shared without consent or is unlawful, and what I wrote here is accurate.</span>
        </label>
        {errors.goodFaith ? (
          <p className="text-[12.5px] text-danger-400" role="alert">
            {errors.goodFaith}
          </p>
        ) : null}
      </div>
      {failure ? (
        <p className="text-[13px] text-danger-400" role="alert">
          {failure}
        </p>
      ) : null}
      <Button type="submit" variant="ember" busy={busy}>
        Send request
      </Button>
    </form>
  );
}
