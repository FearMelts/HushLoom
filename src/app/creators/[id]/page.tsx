import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { CreatorManage } from "@/components/creator-manage";
import { Avatar } from "@/components/shell";
import { TemplateGrid, TemplateRail } from "@/components/template-card";
import { FollowButton } from "@/components/template-detail";
import { EmptyState, SectionHeading } from "@/components/ui";
import { compact } from "@/lib/format";
import { viewerAccess } from "@/server/age/access";
import { creatorAnalytics, creatorPage } from "@/server/creators";
import { getDb } from "@/server/db";
import { templates, templateVersions } from "@/server/db/schema";

export const dynamic = "force-dynamic";

/** The owner's current prompt per template, for editing in place (a change publishes the next version). */
async function currentPrompts(creatorId: string) {
  const rows = await getDb()
    .select({ id: templates.id, prompt: templateVersions.prompt })
    .from(templates)
    .innerJoin(templateVersions, and(eq(templateVersions.templateId, templates.id), eq(templateVersions.version, templates.currentVersion)))
    .where(eq(templates.creatorId, creatorId));
  return new Map(rows.map((r) => [r.id, r.prompt]));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  return { title: `@${decodeURIComponent((await params).id)}` };
}

export default async function CreatorPage({ params }: { params: Promise<{ id: string }> }) {
  const handle = decodeURIComponent((await params).id);
  const { user, viewer } = await viewerAccess();
  const data = await creatorPage(handle, viewer);
  if (!data) notFound();
  const [analytics, prompts] = data.isOwner
    ? await Promise.all([creatorAnalytics(data.profile.userId, viewer.explicitAllowed), currentPrompts(data.profile.userId)])
    : [null, null];
  const p = data.profile;
  return (
    <div>
      <header className="mb-10 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex items-center gap-4">
          <Avatar name={p.displayName} size={72} />
          <div>
            <h1 className="font-display text-4xl leading-none">{p.displayName}</h1>
            <p className="mt-1 font-mono text-[13px] text-bone-400">@{p.handle}</p>
            {data.profile.headline || p.bio ? <p className="mt-2 max-w-xl text-sm text-bone-300">{data.profile.headline || p.bio}</p> : null}
          </div>
        </div>
        <div className="flex items-center gap-5">
          <dl className="flex gap-5 text-center">
            {[
              ["Followers", data.followers],
              ["Templates", data.templates.length],
              ["Uses", data.totals.generations],
            ].map(([k, v]) => (
              // Term first in the markup (valid dl order), number first on screen.
              <div key={k} className="flex flex-col-reverse">
                <dt className="tag text-bone-500">{k}</dt>
                <dd className="font-display text-2xl">{compact(Number(v))}</dd>
              </div>
            ))}
          </dl>
          {data.isOwner ? null : <FollowButton creatorId={p.userId} initial={data.isFollowing} signedIn={Boolean(user)} />}
        </div>
      </header>

      {analytics ? (
        <section className="mb-12" aria-label="Manage your templates">
          <SectionHeading kicker="Only you see this" title="Your templates" />
          <CreatorManage rows={analytics.map((r) => ({ ...r, prompt: prompts?.get(r.id) ?? "" }))} />
        </section>
      ) : null}

      {data.collections.map((c) => (
        <section key={c.id} className="mb-10">
          <SectionHeading kicker={c.isPublic ? "Collection" : "Private collection"} title={c.title} />
          <TemplateRail cards={c.cards} signedIn={Boolean(user)} />
        </section>
      ))}

      <section>
        <SectionHeading kicker="Published" title={data.isOwner ? "As others see it" : "Templates"} />
        {data.templates.length ? (
          <TemplateGrid cards={data.templates} signedIn={Boolean(user)} />
        ) : (
          <EmptyState title="Nothing published yet" body={data.isOwner ? "Publish a finished creation from your Library and it appears here." : "Check back later."} />
        )}
      </section>
    </div>
  );
}
