import { eq } from "drizzle-orm";
import { ArrowRight, GitBranch, Star } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CreatePanel } from "@/components/create-panel";
import { Avatar } from "@/components/shell";
import { FollowButton, MakeBar, RateStars, ReportButton, TemplateMedia } from "@/components/template-detail";
import { TemplateRail } from "@/components/template-card";
import { Badge, SectionHeading } from "@/components/ui";
import { viewerAccess } from "@/server/age/access";
import { createContext } from "@/server/create-context";
import { getDb } from "@/server/db";
import { discoveryEvents, userPreferences } from "@/server/db/schema";
import { browseTemplates, cardsByIds, isDemoModelKey, similarTemplates, type TemplateCard } from "@/server/discovery/templates";
import { compact } from "@/lib/format";
import { templateForViewer } from "@/server/templates/queries";
import type { GenerationParams } from "@/server/db/schema";
import { estimateCost, type GenerationMode } from "@/server/ai/registry";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const t = await templateForViewer((await params).id, null);
  return { title: t?.t.title ?? "Template" };
}

export default async function TemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { user, viewer } = await viewerAccess();
  const data = await templateForViewer((await params).id, user?.id ?? null);
  if (!data) notFound();
  const { t } = data;

  if (user) {
    const [prefs] = await getDb().select().from(userPreferences).where(eq(userPreferences.userId, user.id));
    if (prefs?.historyEnabled !== false) await getDb().insert(discoveryEvents).values({ userId: user.id, templateId: t.id, event: "view" });
  }
  const [ctx, related, [card]] = await Promise.all([createContext(user), similarTemplates(t.id, viewer, 10), cardsByIds([t.id], viewer)]);
  const locked = t.isVip && !ctx.vip && !data.own;
  const rating = t.ratingCount ? (t.ratingSum / t.ratingCount).toFixed(1) : null;
  const demo = isDemoModelKey(data.version.modelKey);

  // The price on the phone "Make it" bar: the same starting model the Create panel picks.
  const usable = ctx.models.filter((m) => m.output === t.mediaType);
  const startModel = usable.find((m) => m.key === data.version.modelKey && m.available) ?? usable.find((m) => m.available) ?? usable[0];
  const makeCost = startModel?.available ? estimateCost(startModel, data.version.defaults as GenerationParams, startModel.priceMultiplierPct) : null;

  // "More in #tag" for the first two tags; each rail skips what an earlier rail already shows.
  const seen = new Set([t.id, ...related.map((r) => r.id)]);
  const tagRails: { tag: string; cards: TemplateCard[] }[] = [];
  for (const tag of t.tags.slice(0, 2)) {
    const { items } = await browseTemplates({ tag, excludeIds: [...seen], sort: "trending", limit: 8 }, viewer);
    if (items.length) tagRails.push({ tag, cards: items });
    for (const c of items) seen.add(c.id);
  }

  return (
    <div className="space-y-12">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:gap-10">
        <div className="lg:sticky lg:top-20 lg:self-start">
          <TemplateMedia
            posterUrl={card?.posterUrl ?? null}
            previewUrl={card?.previewUrl ?? null}
            title={t.title}
            isVideo={t.mediaType === "video"}
            withheld={!viewer.explicitAllowed}
            signedIn={Boolean(user)}
          />
        </div>

        <div className="min-w-0">
          <div className="flex flex-wrap gap-1.5">
            {t.isVip ? <Badge tone="vip">VIP</Badge> : null}
            {t.quality === "4k" ? <Badge>4K</Badge> : null}
            {demo ? <Badge tone="demo">Demo media</Badge> : null}
            <Badge tone={t.mediaType === "video" ? "video" : "plain"}>{t.mediaType === "video" ? `Video${t.durationS ? ` · ${t.durationS}s` : ""}` : "Image"}</Badge>
            {data.category ? (
              <Link href={`/explore?category=${data.category.slug}`}>
                <Badge>{data.category.name}</Badge>
              </Link>
            ) : null}
            {t.status !== "published" ? <Badge tone="warn">{t.status}</Badge> : null}
          </div>
          <h1 className="mt-3 font-display text-4xl leading-tight sm:text-5xl">{t.title}</h1>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <Link href={`/creators/${data.handle}`} className="flex items-center gap-2.5">
              <Avatar name={data.displayName} size={36} />
              <span>
                <span className="block text-sm">{data.displayName}</span>
                <span className="block font-mono text-[11.5px] text-bone-400">@{data.handle}</span>
              </span>
            </Link>
            {!data.own ? <FollowButton creatorId={t.creatorId} initial={data.following} signedIn={Boolean(user)} /> : (
              <Link href={`/creators/${data.handle}?tab=manage`} className="text-[13px] text-ember-300 underline">Manage template</Link>
            )}
          </div>
          {t.description ? <p className="mt-4 text-[15px] leading-relaxed text-bone-300">{t.description}</p> : null}
          <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-[13px] text-bone-400">
            <div>
              <dt className="sr-only">Made</dt>
              <dd>Made {compact(t.generationCount)} times</dd>
            </div>
            <div>
              <dt className="sr-only">Favorites</dt>
              <dd>♥ {compact(t.favoriteCount)}</dd>
            </div>
            <div className="flex items-center gap-1">
              <dt className="sr-only">Rating</dt>
              <dd className="flex items-center gap-1">
                <Star size={13} className="fill-brass-400 text-brass-400" aria-hidden /> {rating ?? "Unrated"} {t.ratingCount ? `(${t.ratingCount})` : ""}
              </dd>
            </div>
            {data.remixedFrom ? (
              <div className="flex items-center gap-1">
                <GitBranch size={13} aria-hidden /> Remix of{" "}
                <Link href={`/templates/${data.remixedFrom.slug}`} className="text-bone-200 underline">
                  {data.remixedFrom.title}
                </Link>
              </div>
            ) : null}
          </dl>
          {t.tags.length ? (
            <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Tags">
              {t.tags.map((tag) => (
                <li key={tag}>
                  <Link href={`/explore?q=${encodeURIComponent(tag)}`} className="tag rounded-full px-2.5 py-1 text-bone-400 hairline hover:text-bone-50">
                    #{tag}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="panel mt-7 bg-ink-900/70 p-4 hairline sm:p-6">
            <CreatePanel
              output={t.mediaType}
              models={ctx.models}
              signedIn={Boolean(user)}
              balance={ctx.balance}
              characterRefs={ctx.characterRefs}
            copilot={ctx.copilot}
              projects={ctx.projects}
              template={{
                id: t.id,
                slug: t.slug,
                title: t.title,
                mode: t.mode as GenerationMode,
                // A VIP template's recipe is what the pass unlocks: without one, none of it is sent to the browser.
                prompt: locked ? "" : data.version.prompt,
                negativePrompt: locked ? "" : data.version.negativePrompt,
                modelKey: data.version.modelKey,
                defaults: locked ? {} : (data.version.defaults as GenerationParams),
                locked,
              }}
            />
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            {user && !data.own ? <RateStars templateId={t.id} initial={data.myRating} /> : <span />}
            {user && !data.own ? <ReportButton templateId={t.id} /> : null}
          </div>
          {data.versions.length > 1 ? (
            <details className="mt-4 text-[13px] text-bone-400">
              <summary className="cursor-pointer hover:text-bone-200">Version {t.currentVersion} · history</summary>
              <ul className="mt-2 space-y-1">
                {data.versions.map((v) => (
                  <li key={v.version}>
                    v{v.version} · {v.createdAt.toLocaleDateString()} {v.changelog ? `· ${v.changelog}` : ""}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      </div>

      {related.length ? (
        <section>
          <SectionHeading kicker="Same mood" title="You might also like" />
          <TemplateRail cards={related} signedIn={Boolean(user)} />
        </section>
      ) : null}

      {tagRails.map(({ tag, cards }) => (
        <section key={tag}>
          <SectionHeading
            kicker="Same tag"
            title={`More in #${tag}`}
            action={
              <Link href={`/explore?q=${encodeURIComponent(tag)}`} className="inline-flex items-center gap-1 text-[13px] text-bone-300 hover:text-bone-50">
                See all <ArrowRight size={14} aria-hidden />
              </Link>
            }
          />
          <TemplateRail cards={cards} signedIn={Boolean(user)} />
        </section>
      ))}

      <MakeBar cost={makeCost} locked={locked} demo={demo} />
      {/* Room for the phone "Make it" bar above the tab bar. */}
      <div className="h-14 lg:hidden" aria-hidden />
    </div>
  );
}
