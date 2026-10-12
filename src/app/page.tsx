import { ArrowRight, Film, ImageIcon } from "lucide-react";
import Link from "next/link";
import { TemplateGrid, TemplateRail } from "@/components/template-card";
import { ButtonLink, SectionHeading } from "@/components/ui";
import { getCurrentUser } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { userPreferences } from "@/server/db/schema";
import { browseTemplates, followingFeed, forYou, listCategories, recentlyViewed } from "@/server/discovery/templates";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await getCurrentUser();
  const viewerId = user?.id ?? null;
  const [categories, trending, fresh, mine, recent, following, prefs] = await Promise.all([
    listCategories(),
    browseTemplates({ sort: "trending", limit: 15 }, viewerId),
    browseTemplates({ sort: "new", limit: 12 }, viewerId),
    user ? forYou(user.id, 12) : null,
    user ? recentlyViewed(user.id, 12) : [],
    user ? followingFeed(user.id, 12) : [],
    user ? getDb().select().from(userPreferences).where(eq(userPreferences.userId, user.id)) : [],
  ]);
  const autoplay = prefs[0]?.autoplayPreviews ?? false;
  const signedIn = Boolean(user);

  return (
    <div className="space-y-12">
      <section className="relative overflow-hidden rounded-[28px_8px_28px_8px] bg-ink-900 px-5 py-8 hairline sm:px-9 sm:py-10">
        <div className="pointer-events-none absolute -right-24 -top-24 size-80 rounded-full bg-ember-600/25 blur-3xl" aria-hidden />
        <div className="pointer-events-none absolute -bottom-32 right-40 size-72 rounded-full bg-brass-400/10 blur-3xl" aria-hidden />
        <p className="tag text-ember-400">After dark, made by you</p>
        <h1 className="mt-2 max-w-2xl font-display text-[34px] leading-[1.05] sm:text-5xl">
          Pick a template. <em className="text-ember-300">Make it yours.</em>
        </h1>
        <p className="mt-3 max-w-xl text-[15px] text-bone-300">
          Browse what the community is making, open anything that catches your eye, and create your own version in a tap. Everything you make stays private unless you publish it.
        </p>
        <div className="mt-6 flex flex-wrap gap-2.5">
          <ButtonLink href="/generate/image" variant="ember" size="lg">
            <ImageIcon size={18} aria-hidden /> Make an image
          </ButtonLink>
          <ButtonLink href="/generate/video" variant="ghost" size="lg">
            <Film size={18} aria-hidden /> Make a video
          </ButtonLink>
        </div>
        <nav aria-label="Categories" className="scrollbar-none -mx-1 mt-7 flex gap-2 overflow-x-auto px-1">
          {categories.map((c) => (
            <Link key={c.id} href={`/explore?category=${c.slug}`} className="h-8 shrink-0 rounded-full px-3.5 text-[13px] leading-8 text-bone-300 hairline hover:bg-ink-800 hover:text-bone-50">
              {c.name}
            </Link>
          ))}
        </nav>
      </section>

      {mine && mine.items.length ? (
        <section>
          <SectionHeading
            kicker={mine.personalized ? "From what you love" : "Popular to start"}
            title="For you"
            action={
              <Link href="/settings#discovery" className="text-[13px] text-bone-400 hover:text-bone-50">
                Tune
              </Link>
            }
          />
          <TemplateRail cards={mine.items} signedIn={signedIn} />
        </section>
      ) : null}

      {recent.length ? (
        <section>
          <SectionHeading kicker="Pick up where you left off" title="Continue exploring" />
          <TemplateRail cards={recent} signedIn={signedIn} />
        </section>
      ) : null}

      <section>
        <SectionHeading
          kicker="Most made this week"
          title="Trending tonight"
          action={
            <Link href="/explore" className="inline-flex items-center gap-1 text-[13px] text-bone-300 hover:text-bone-50">
              Explore all <ArrowRight size={14} aria-hidden />
            </Link>
          }
        />
        <TemplateGrid cards={trending.items} signedIn={signedIn} autoplay={autoplay} editorial />
      </section>

      {following.length ? (
        <section>
          <SectionHeading kicker="Creators you follow" title="Following" />
          <TemplateRail cards={following} signedIn={signedIn} />
        </section>
      ) : null}

      <section>
        <SectionHeading
          kicker="Fresh from creators"
          title="New"
          action={
            <Link href="/explore?sort=new" className="inline-flex items-center gap-1 text-[13px] text-bone-300 hover:text-bone-50">
              See all <ArrowRight size={14} aria-hidden />
            </Link>
          }
        />
        <TemplateRail cards={fresh.items} signedIn={signedIn} />
      </section>
    </div>
  );
}
