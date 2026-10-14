"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { Button, Field, inputClass, radioGroupKeys } from "./ui";

type Errors = Record<string, string | undefined>;
const MODES = ["signup", "signin"] as const;

function fieldErrors(e: unknown): Errors {
  if (!(e instanceof ApiError)) return { form: "Something went wrong. Try again." };
  const fe = (e.details as { fieldErrors?: Record<string, string[]> } | undefined)?.fieldErrors;
  if (fe && Object.keys(fe).length) return Object.fromEntries(Object.entries(fe).map(([k, v]) => [k, v[0]]));
  return { form: e.message };
}

export function AuthForms({ next, initialMode }: { next: string; initialMode: "signin" | "signup" }) {
  const [mode, setMode] = useState(initialMode);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(form: HTMLFormElement) {
    setBusy(true);
    setErrors({});
    const data = Object.fromEntries(new FormData(form));
    try {
      if (mode === "signin") {
        await api("/api/auth/login", { body: { email: data.email, password: data.password } });
      } else {
        await api("/api/auth/signup", {
          body: {
            email: data.email,
            password: data.password,
            handle: data.handle,
            displayName: data.displayName || data.handle,
            dateOfBirth: data.dateOfBirth,
            acceptTerms: data.acceptTerms === "on",
            confirmAdult: data.confirmAdult === "on",
          },
        });
      }
      router.replace(next);
      router.refresh();
    } catch (e) {
      setErrors(fieldErrors(e));
      setBusy(false);
    }
  }

  return (
    <div className="petal hairline bg-ink-900/80 p-6 sm:p-8">
      {/* One of two forms: a radio group with a roving tabindex, arrow keys switch. */}
      <div
        role="radiogroup"
        aria-label="Account"
        className="mb-6 grid grid-cols-2 rounded-full bg-ink-950 p-1"
        onKeyDown={radioGroupKeys(MODES, mode, (m) => {
          setMode(m);
          setErrors({});
        })}
      >
        {MODES.map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            tabIndex={mode === m ? 0 : -1}
            onClick={() => {
              setMode(m);
              setErrors({});
            }}
            className={cn("h-9 rounded-full text-sm transition-colors max-sm:h-10", mode === m ? "bg-bone-50 font-semibold text-ink-950" : "text-bone-300 hover:text-bone-50")}
          >
            {m === "signup" ? "Create account" : "Sign in"}
          </button>
        ))}
      </div>
      <form
        className="space-y-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit(e.currentTarget);
        }}
      >
        <Field label="Email" htmlFor="email" error={errors.email}>
          <input id="email" name="email" type="email" autoComplete="email" required className={inputClass} />
        </Field>
        <Field label="Password" htmlFor="password" error={errors.password} hint={mode === "signup" ? "At least 10 characters." : undefined}>
          <input id="password" name="password" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} required className={inputClass} />
        </Field>
        {mode === "signup" ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Handle" htmlFor="handle" error={errors.handle} hint="Public, e.g. velvet_fox">
                <input id="handle" name="handle" autoComplete="username" required className={inputClass} />
              </Field>
              <Field label="Display name" htmlFor="displayName" error={errors.displayName}>
                <input id="displayName" name="displayName" className={inputClass} />
              </Field>
            </div>
            <Field label="Date of birth" htmlFor="dateOfBirth" error={errors.dateOfBirth} hint="You must be 18 or older. Kept private.">
              <input id="dateOfBirth" name="dateOfBirth" type="date" required className={inputClass} />
            </Field>
            <label className="flex items-start gap-3 text-[13.5px] text-bone-300">
              <input type="checkbox" name="confirmAdult" className="mt-0.5 size-4 accent-[var(--color-ember-500)]" />
              <span>I am at least 18 and the age of majority where I live.</span>
            </label>
            {errors.confirmAdult ? <p className="text-[12.5px] text-danger-400" role="alert">{errors.confirmAdult}</p> : null}
            <label className="flex items-start gap-3 text-[13.5px] text-bone-300">
              <input type="checkbox" name="acceptTerms" className="mt-0.5 size-4 accent-[var(--color-ember-500)]" />
              <span>
                I agree to the{" "}
                <Link href="/policies" target="_blank" className="text-ember-300 underline">
                  Terms and Content Policy
                </Link>
                : only consenting adults, never minors, never anyone without their permission.
              </span>
            </label>
            {errors.acceptTerms ? <p className="text-[12.5px] text-danger-400" role="alert">{errors.acceptTerms}</p> : null}
          </>
        ) : null}
        {errors.form ? (
          <p className="rounded-xl bg-danger-400/10 px-3.5 py-2.5 text-[13px] text-danger-400" role="alert">
            {errors.form}
          </p>
        ) : null}
        <Button type="submit" variant="ember" size="lg" className="w-full" busy={busy}>
          {mode === "signup" ? "Create account" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}
