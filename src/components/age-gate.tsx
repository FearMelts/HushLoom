"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import { Button, buttonClass } from "./ui";
import { Wordmark } from "./shell";

export function AgeGate() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <main className="grid min-h-dvh place-items-center px-5">
      <div className="petal hairline w-full max-w-md bg-ink-900/80 p-7 text-center backdrop-blur animate-rise">
        <Wordmark className="justify-center" />
        <h1 className="mt-6 font-display text-3xl">Adults only</h1>
        <p className="mt-3 text-[15px] text-bone-300">
          Hushloom contains sexually suggestive and explicit material made with AI. Enter only if you are 18 or older and it is legal where you
          are.
        </p>
        <div className="mt-7 flex flex-col gap-2.5">
          <Button
            variant="ember"
            size="lg"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              await api("/api/age-gate", { method: "POST", body: { confirm: true } });
              router.refresh();
            }}
          >
            I am 18 or older, enter
          </Button>
          <a href="https://www.google.com" className={buttonClass("quiet", "lg")} rel="noreferrer">
            Leave
          </a>
        </div>
        <p className="mt-6 text-[12.5px] text-bone-500">
          This screen is a notice, not age verification. Creating requires an account with a date of birth.{" "}
          <Link href="/policies" className="underline hover:text-bone-300">
            Content policy
          </Link>
        </p>
      </div>
    </main>
  );
}
