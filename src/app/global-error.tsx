"use client";

import { Wordmark } from "@/components/shell";
import { buttonClass } from "@/components/ui";
import "./globals.css";

/**
 * The root layout itself failed (for example the database was unreachable while loading the
 * account), so there is no shell to keep. Same look as the not-found page, on its own.
 * "Try again" is a full reload: the layout has to run again on the server.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en">
      <body>
        <main className="grid min-h-dvh place-items-center px-5">
          <div className="petal hairline w-full max-w-md bg-ink-900/80 p-7 text-center backdrop-blur animate-rise" role="alert">
            <Wordmark className="justify-center" />
            <p className="tag mt-6 text-ember-400">Something went wrong</p>
            <h1 className="mt-1 font-display text-3xl">A thread snapped</h1>
            <p className="mt-3 text-[15px] text-bone-300">Hushloom couldn&apos;t load just now. Nothing you made is lost.</p>
            <div className="mt-7 flex flex-col gap-2.5">
              <a href="" className={buttonClass("ember", "lg")}>
                Try again
              </a>
              {/* A full page load on purpose: the root layout has to render again from scratch. */}
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
              <a href="/" className={buttonClass("quiet", "lg")}>
                Go to Discover
              </a>
            </div>
            {error.digest ? <p className="mt-6 font-mono text-[11px] text-bone-500">Reference {error.digest}</p> : null}
          </div>
        </main>
      </body>
    </html>
  );
}
