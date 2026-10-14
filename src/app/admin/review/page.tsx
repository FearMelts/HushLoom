import Link from "next/link";
import { notFound } from "next/navigation";
import { ClosedList, EscalationQueue, TakedownQueue } from "@/components/admin-review";
import { Badge } from "@/components/ui";
import { getCurrentUser } from "@/server/auth/session";
import { scanSettings } from "@/server/safety/scan";
import { listEscalations } from "@/server/safety/review";
import { listTakedowns } from "@/server/safety/takedowns";

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

export default async function AbuseReviewPage() {
  const user = await getCurrentUser();
  // Same 404 as a missing page for everyone else, like /admin.
  if (user?.role !== "admin") notFound();
  const [open, closed, takedowns, closedTakedowns] = await Promise.all([
    listEscalations({ status: "open" }),
    listEscalations({ status: "resolved", limit: 20 }),
    listTakedowns({ status: "open" }),
    listTakedowns({ status: "closed", limit: 20 }),
  ]);
  const scanner = scanSettings();
  return (
    <div className="space-y-8">
      <div>
        <Link href="/admin" className="tag text-bone-500 hover:text-bone-300">
          ← Admin
        </Link>
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
      </Panel>
      <Panel title="Recently closed">
        <ClosedList escalations={closed} takedowns={closedTakedowns} />
      </Panel>
    </div>
  );
}
