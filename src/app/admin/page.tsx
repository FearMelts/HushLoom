import { notFound } from "next/navigation";
import { CreditAdjust, ModelTable, ReportQueue } from "@/components/admin";
import { relativeTime } from "@/lib/format";
import { adminStats, moderationQueue, modelsForAdmin, recentAudit } from "@/server/admin";
import { getCurrentUser } from "@/server/auth/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin" };

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-2xl bg-ink-900/70 p-4 hairline">
      <p className="tag text-bone-500">{label}</p>
      <p className="mt-1 font-display text-3xl">{value}</p>
      {hint ? <p className="text-[12px] text-bone-500">{hint}</p> : null}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[24px_8px_24px_8px] bg-ink-900/70 p-5 hairline">
      <h2 className="mb-4 font-display text-2xl">{title}</h2>
      {children}
    </section>
  );
}

export default async function AdminPage() {
  const user = await getCurrentUser();
  // Non-admins get the same 404 as a missing page, so the route does not advertise itself.
  if (user?.role !== "admin") notFound();
  const [stats, reports, models, log] = await Promise.all([adminStats(), moderationQueue(), modelsForAdmin(), recentAudit()]);
  const secs = (n: number | null) => (n === null ? "–" : `${n.toFixed(1)}s`);
  return (
    <div className="space-y-8">
      <div>
        <p className="tag text-ember-400">Operators only</p>
        <h1 className="font-display text-4xl">Admin</h1>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Active users" value={stats.users} hint={`${stats.newUsers24h} new in 24h`} />
        <Stat label="Finished 24h" value={stats.jobs24h.completed} hint={`${stats.jobs24h.failed} failed · ${stats.jobs24h.cancelled} cancelled`} />
        <Stat label="Failure rate 24h" value={stats.failureRate24h === null ? "–" : `${(stats.failureRate24h * 100).toFixed(1)}%`} hint={`${stats.demoJobs24h} demo jobs`} />
        <Stat label="Run time p50 / p95" value={`${secs(stats.secondsP50)} / ${secs(stats.secondsP95)}`} hint="completed in 24h" />
        <Stat label="In flight" value={stats.jobs24h.queued + stats.jobs24h.processing} hint={`${stats.jobs24h.queued} queued`} />
        <Stat label="Credits spent 24h" value={stats.creditsSpent24h} />
        <Stat label="Revenue 30d" value={`$${(stats.revenueCents30d / 100).toFixed(2)}`} hint={`${stats.creditsSold30d} credits sold`} />
        <Stat label="Open reports" value={stats.openReports} />
      </div>
      <div className="grid gap-8 xl:grid-cols-2">
        <Panel title="Reports">
          <ReportQueue reports={reports} />
        </Panel>
        <div className="space-y-8">
          <Panel title="Models">
            <ModelTable models={models} />
          </Panel>
          <Panel title="Adjust credits">
            <CreditAdjust />
          </Panel>
        </div>
      </div>
      <Panel title="Audit log">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-[12.5px]">
            <tbody>
              {log.map((l) => (
                <tr key={l.id} className="border-b border-bone-50/5 align-top">
                  <td className="py-1.5 pr-3 text-bone-500">{relativeTime(l.createdAt)}</td>
                  <td className="py-1.5 pr-3">{l.actor ? `@${l.actor}` : "system"}</td>
                  <td className="py-1.5 pr-3 font-mono">{l.action}</td>
                  <td className="py-1.5 pr-3 font-mono text-bone-400">{l.target}</td>
                  <td className="py-1.5 font-mono text-bone-500">{Object.keys(l.metadata).length ? JSON.stringify(l.metadata).slice(0, 120) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
