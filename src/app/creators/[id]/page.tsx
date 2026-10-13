import { notFound } from "next/navigation";
import { CreatorManage } from "@/components/creator-manage";
import { Avatar } from "@/components/shell";
import { TemplateGrid, TemplateRail } from "@/components/template-card";
import { FollowButton } from "@/components/template-detail";
import { EmptyState, SectionHeading } from "@/components/ui";
import { compact } from "@/lib/format";
import { viewerAccess } from "@/server/age/access";
import { creatorAnalytics, creatorPage } from "@/server/creators";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  return { title: `@${decodeURIComponent((await params).id)}` };
}

export default async function CreatorPage({ params }: { params: Promise<{ id: string }> }) {
  const handle = decodeURIComponent((await params).id);
  const { user, viewer } = await viewerAccess();
  const data = await creatorPage(handle, viewer);
  if (!data) notFound();
  const analytics = data.isOwner ? await creatorAnalytics(data.profile.userId, viewer.explicitAllowed) : null;
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
              <div key={k}>
                <dd className="font-display text-2xl">{compact(Number(v))}</dd>
                <dt className="tag text-bone-500">{k}</dt>
              </div>
            ))}
          </dl>
          {data.isOwner ? null : <FollowButton creatorId={p.userId} initial={data.isFollowing} signedIn={Boolean(user)} />}
        </div>
      </header>

      {analytics ? (
        <section className="mb-12" aria-label="Manage your templates">
          <SectionHeading kicker="Only you see this" title="Your templates" />
          <CreatorManage rows={analytics} />
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
