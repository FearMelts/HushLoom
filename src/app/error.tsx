"use client";

import { useRouter } from "next/navigation";
import { startTransition, useEffect } from "react";
import { Button, ButtonLink } from "@/components/ui";

/**
 * A page threw while rendering. The shell (navigation, balance, tray) stays; only the page area is
 * replaced. Nothing from the error itself is shown: production errors carry no message to the
 * browser anyway, only a digest that matches the server log.
 */
export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  useEffect(() => {
    // Leaves a trace for whoever is debugging in the browser; the server already logged the details.
    console.error(error.digest ? `Page error ${error.digest}` : "Page error");
  }, [error.digest]);

  return (
    <div className="mx-auto max-w-md py-20 text-center" role="alert">
      <p className="tag text-ember-400">Something went wrong</p>
      <h1 className="font-display text-4xl">A thread snapped</h1>
      <p className="mt-2 text-sm text-bone-400">This page didn&apos;t load. Nothing you made is lost; try again, or head back to Discover.</p>
      <div className="mt-6 flex justify-center gap-2">
        <Button
          variant="ember"
          onClick={() =>
            // Re-fetch the server render as well as re-rendering the segment.
            startTransition(() => {
              router.refresh();
              reset();
            })
          }
        >
          Try again
        </Button>
        <ButtonLink href="/" variant="ghost">
          Back to Discover
        </ButtonLink>
      </div>
      {error.digest ? <p className="mt-6 font-mono text-[11px] text-bone-500">Reference {error.digest}</p> : null}
    </div>
  );
}
