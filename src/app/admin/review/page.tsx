import Link from "next/link";
import { notFound } from "next/navigation";
import { ClosedList, EscalationQueue, TakedownQueue } from "@/components/admin-review";
import { BackLink, Badge } from "@/components/ui";
import { getCurrentUser } from "@/server/auth/session";
import { scanSettings } from "@/server/safety/scan";
import { listEscalations } from "@/server/safety/review";
import { countTakedowns, listTakedowns, TAKEDOWN_PAGE } from "@/server/safety/takedowns";

export const dynamic = "force-dynamic";
export const metadata = { title: "Abuse review" };

function Panel({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[24px_8px_24px_8px] bg-ink-900/70 p-5 hairline">
      <h2 className="font-display text-2xl">{title}</h2>
      {hint ? <p className="mt-1 text-[13px] text-bone-400">{hint}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Where this page of open takedown requests sits in the whole queue, with links to the pages either side. */
function TakedownPager({ offset, total }: { offset: number; total: number }) {
  const link = (to: number, label: string) => (
    <Link href={to ? `/admin/review?takedowns=${to}` : "/admin/review"} className="text-ember-300 underline">
      {label}
    </Link>
  );
  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-bone-400">
      <span>
        {total ? `${Math.min(offset + 1, total)}–${Math.min(offset + TAKEDOWN_PAGE, total)}` : "0"} of {total} open
      </span>
      {offset > 0 ? link(Math.max(0, offset - TAKEDOWN_PAGE), "Previous") : null}
      {offset + TAKEDOWN_PAGE < total ? link(offset + TAKEDOWN_PAGE, "Next") : null}
    </div>
  );
}

export default async function AbuseReviewPage({ searchParams }: { searchParams: Promise<{ takedowns?: string }> }) {
  const user = await getCurrentUser();
  // Same 404 as a missing page for everyone else, like /admin.
  if (user?.role !== "admin") notFound();
  const offset = Math.min(1_000_000, Math.max(0, Number.parseInt((await searchParams).takedowns ?? "", 10) || 0));
  const [open, closed, takedowns, closedTakedowns, openTakedowns] = await Promise.all([
    listEscalations({ status: "open" }),
    listEscalations({ status: "resolved", limit: 20 }),
    listTakedowns({ status: "open", offset }),
    listTakedowns({ status: "closed", limit: 20 }),
    countTakedowns("open"),
  ]);
  const scanner = scanSettings();
  return (
    <div className="space-y-8">
      <div>
        <BackLink href="/admin">Admin</BackLink>
        <p className="tag mt-3 text-ember-400">Operators only</p>
        <h1 className="font-display text-4xl">Abuse review</h1>
        <p className="mt-2 max-w-2xl text-sm text-bone-400">
          Scanner matches and takedown requests wait here for a person. Matched files are never shown on this page: they stay on legal hold in storage, are never served, and are never
          purged. The process, and what is flagged for legal review, is in docs/abuse-response.md.
        </p>
      </div>

      <div className={`petal p-5 hairline ${scanner.isDev ? "bg-iris-400/10" : "bg-ink-900/60"}`}>
        <div className="flex flex-wrap items-center gap-2">
          {scanner.isDev ? <Badge tone="demo">Development scanner · not live</Badge> : <Badge>{scanner.provider}</Badge>}
          {!scanner.preStorage ? <Badge tone="warn">no pre-storage scan</Badge> : null}
          {!scanner.configured ? <Badge tone="danger">not configured</Badge> : null}
          <Badge tone={scanner.failClosed ? "plain" : "warn"}>fail-closed {scanner.failClosed ? "on" : "off"}</Badge>
        </div>
        <p className="mt-2 text-[13px] text-bone-300">
          {scanner.isDev
            ? "This demo scanner matches only test hashes and the drill fixture, so it protects no one. Production needs PhotoDNA (and, as a second layer, Cloudflare's edge tool)."
            : `${scanner.label}. ${
                scanner.failClosed
                  ? "Anything the scanner cannot check is not kept: uploads are refused for now and creations retry."
                  : "Fail-closed is off: content the scanner could not check is kept unserved until a rescan."
              }`}
        </p>
      </div>

      <Panel title="Scanner matches" hint="File the report with the authority first, then record its reference. Clear only a confirmed false match.">
        <EscalationQueue items={open} />
      </Panel>
      <Panel title="Takedown requests" hint="Intimate images shared without consent come first. “Take it down” removes what the request points at; dismissing needs a note.">
        <TakedownQueue items={takedowns} />
        {offset > 0 || openTakedowns > TAKEDOWN_PAGE ? <TakedownPager offset={offset} total={openTakedowns} /> : null}
      </Panel>
      <Panel title="Recently closed">
        <ClosedList escalations={closed} takedowns={closedTakedowns} />
      </Panel>
    </div>
  );
}
