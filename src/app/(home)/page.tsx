import { ArrowRight, Film, ImageIcon } from "lucide-react";
import Link from "next/link";
import { TemplateGrid, TemplateRail } from "@/components/template-card";
import { ButtonLink, SectionHeading, SectionLink } from "@/components/ui";
import { viewerAccess } from "@/server/age/access";
import { getDb } from "@/server/db";
import { userPreferences } from "@/server/db/schema";
import { browseTemplates, followingFeed, forYou, listCategories, recentlyViewed, savedTemplates } from "@/server/discovery/templates";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

const categoryLink = "h-8 shrink-0 rounded-full px-3.5 text-[13px] leading-8 text-bone-300 hairline hover:bg-ink-800 hover:text-bone-50 max-sm:h-10 max-sm:leading-10";

function CategoryNav({ categories, className }: { categories: { id: string; slug: string; name: string }[]; className?: string }) {
  return (
    <nav aria-label="Categories" className={className}>
      <div className="scrollbar-none -mx-1 flex gap-2 overflow-x-auto px-1">
        {categories.map((c) => (
          <Link key={c.id} href={`/explore?category=${c.slug}`} className={categoryLink}>
            {c.name}
          </Link>
        ))}
      </div>
    </nav>
  );
}

export default async function HomePage() {
  // One age-rule decision for the whole page; cards for a viewer who still needs a check carry no media URLs.
  const { user, viewer } = await viewerAccess();
  const mine = user ? { ...viewer, id: user.id } : null;
  const [categories, trending, fresh, forMe, recent, saved, following, prefs] = await Promise.all([
    listCategories(),
    browseTemplates({ sort: "trending", limit: 15 }, viewer),
    browseTemplates({ sort: "new", limit: 12 }, viewer),
    mine ? forYou(mine, 12) : null,
    mine ? recentlyViewed(mine, 12) : [],
    mine ? savedTemplates(mine, 12) : [],
    mine ? followingFeed(mine, 12) : [],
    user ? getDb().select().from(userPreferences).where(eq(userPreferences.userId, user.id)) : [],
  ]);
  const autoplay = prefs[0]?.autoplayPreviews ?? false;
  const signedIn = Boolean(user);

  return (
    <div className="space-y-12">
      {/* On a phone the hero is a headline and two buttons, so the first templates show above the fold. */}
      <section className="relative overflow-hidden rounded-[28px_8px_28px_8px] bg-ink-900 px-5 py-6 hairline sm:px-9 sm:py-10">
        <div className="pointer-events-none absolute -right-24 -top-24 size-80 rounded-full bg-ember-600/25 blur-3xl" aria-hidden />
        <div className="pointer-events-none absolute -bottom-32 right-40 size-72 rounded-full bg-brass-400/10 blur-3xl" aria-hidden />
        <p className="tag text-ember-400">After dark, made by you</p>
        <h1 className="mt-2 max-w-2xl font-display text-[30px] leading-[1.05] sm:text-5xl">
          Pick a template. <em className="text-ember-300">Make it yours.</em>
        </h1>
        <p className="mt-3 hidden max-w-xl text-[15px] text-bone-300 sm:block">
          Browse what the community is making, open anything that catches your eye, and create your own version in a tap. Everything you make stays private unless you publish it.
        </p>
        <div className="mt-5 flex flex-wrap gap-2.5 sm:mt-6">
          <ButtonLink href="/generate/image" variant="ember" size="lg" className="max-sm:h-11 max-sm:px-5">
            <ImageIcon size={18} aria-hidden /> Make an image
          </ButtonLink>
          <ButtonLink href="/generate/video" variant="ghost" size="lg" className="max-sm:h-11 max-sm:px-5">
            <Film size={18} aria-hidden /> Make a video
          </ButtonLink>
        </div>
        <CategoryNav categories={categories} className="mt-7 hidden sm:block" />
      </section>

      {forMe && forMe.items.length ? (
        <section>
          <SectionHeading
            kicker={forMe.personalized ? "From what you love" : "Popular to start"}
            title="For you"
            action={
              <SectionLink href="/settings#discovery">
                Tune
              </SectionLink>
            }
          />
          <TemplateRail cards={forMe.items} signedIn={signedIn} />
        </section>
      ) : null}

      {recent.length ? (
        <section>
          <SectionHeading kicker="Pick up where you left off" title="Continue exploring" />
          <TemplateRail cards={recent} signedIn={signedIn} />
        </section>
      ) : null}

      {saved.length ? (
        <section>
          <SectionHeading
            kicker="Saved inspirations"
            title="Your favorites"
            action={
              <SectionLink href="/favorites">
                All saved <ArrowRight size={14} aria-hidden />
              </SectionLink>
            }
          />
          <TemplateRail cards={saved} signedIn={signedIn} />
        </section>
      ) : null}

      <section>
        <SectionHeading
          kicker="Most made this week"
          title="Trending tonight"
          action={
            <SectionLink href="/explore">
              Explore all <ArrowRight size={14} aria-hidden />
            </SectionLink>
          }
        />
        <TemplateGrid cards={trending.items} signedIn={signedIn} autoplay={autoplay} editorial />
      </section>

      {/* Phones get the category shortcuts here, after the first grid instead of inside the hero. */}
      <section className="sm:hidden">
        <SectionHeading kicker="Find your mood" title="Categories" />
        <CategoryNav categories={categories} />
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
            <SectionLink href="/explore?sort=new">
              See all <ArrowRight size={14} aria-hidden />
            </SectionLink>
          }
        />
        <TemplateRail cards={fresh.items} signedIn={signedIn} />
      </section>
    </div>
  );
}
