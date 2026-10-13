"use client";

import { Heart, Play, ShieldCheck, Wand2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { TemplateCard as Card } from "@/server/discovery/templates";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { compact } from "@/lib/format";
import { Badge, useToast } from "./ui";

/**
 * Shown in place of a template's media when the viewer still needs an age check (addendum §2).
 * The server issued no media URL, so there is nothing here to unblur; the title and creator stay.
 */
export const verifyHref = (signedIn: boolean) => (signedIn ? "/settings#age-verification" : "/auth?next=/settings%23age-verification");

export function WithheldMedia({ signedIn, compact, link = true }: { signedIn: boolean; compact?: boolean; link?: boolean }) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-[radial-gradient(circle_at_30%_20%,color-mix(in_oklab,var(--color-ember-700)_28%,transparent),transparent_60%),linear-gradient(160deg,var(--color-ink-800),var(--color-ink-950))] p-3 text-center">
      <div>
        <ShieldCheck size={compact ? 20 : 28} className="mx-auto text-ember-300" aria-hidden />
        <p className={cn("mt-2 font-display leading-snug text-bone-100", compact ? "text-[13px]" : "text-base")}>{signedIn ? "Verify your age to see previews" : "Sign in and verify to see previews"}</p>
        {link ? (
          <Link href={verifyHref(signedIn)} className="mt-2 inline-block font-mono text-[11px] uppercase tracking-[0.08em] text-ember-400 underline-offset-2 hover:underline">
            {signedIn ? "Verify now" : "Sign in"}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The petal card: media first, a quiet caption underneath. Hover or focus plays
 * the muted preview and reveals Make; touch users get an explicit preview button.
 */
export function TemplateCard({ card, feature, signedIn, autoplay }: { card: Card; feature?: boolean; signedIn: boolean; autoplay?: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const [fav, setFav] = useState(card.isFavorited);
  const [favCount, setFavCount] = useState(card.favoriteCount);
  const [popping, setPopping] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const toast = useToast();
  const router = useRouter();

  const play = () => {
    if (!video.current) return;
    void video.current.play().catch(() => undefined);
    setPreviewing(true);
  };
  const stop = () => {
    if (!video.current || autoplay) return;
    video.current.pause();
    setPreviewing(false);
  };

  async function toggleFavorite() {
    if (!signedIn) {
      router.push(`/auth?next=/templates/${card.slug}`);
      return;
    }
    const next = !fav;
    setFav(next);
    setFavCount((c) => c + (next ? 1 : -1));
    if (next) setPopping(true);
    try {
      await api("/api/favorites", { method: next ? "POST" : "DELETE", body: { targetType: "template", targetId: card.id } });
    } catch (e) {
      setFav(!next);
      setFavCount((c) => c + (next ? -1 : 1));
      toast({ message: e instanceof ApiError ? e.message : "Could not save that.", tone: "error" });
    }
  }

  return (
    <article
      className={cn("group relative animate-rise", feature && "sm:col-span-2 sm:row-span-2")}
      onMouseEnter={play}
      onMouseLeave={stop}
      onFocus={play}
      onBlur={stop}
    >
      <div className="petal relative overflow-hidden bg-ink-850 hairline transition-transform duration-[var(--duration-base)] ease-[var(--ease-weave)] group-hover:-translate-y-1">
        <Link href={`/templates/${card.slug}`} className="block" aria-label={`${card.title} by ${card.creator.displayName}`}>
          <div className={cn("relative", feature ? "aspect-[4/5] sm:aspect-[4/5]" : "aspect-[4/5]")}>
            {card.mediaWithheld ? (
              // The card itself is a link, so the call to action lives in the bottom bar instead of nesting here.
              <WithheldMedia signedIn={signedIn} compact={!feature} link={false} />
            ) : card.posterUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URLs bypass the image optimizer on purpose
              <img src={card.posterUrl} alt="" loading="lazy" decoding="async" className="absolute inset-0 size-full object-cover" />
            ) : (
              <div className="skeleton absolute inset-0" />
            )}
            {card.previewUrl ? (
              <video
                ref={video}
                src={card.previewUrl}
                muted
                loop
                playsInline
                preload="none"
                autoPlay={autoplay}
                aria-hidden
                className={cn("absolute inset-0 size-full object-cover transition-opacity duration-[var(--duration-base)]", previewing || autoplay ? "opacity-100" : "opacity-0")}
              />
            ) : null}
            <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-ink-950/70 to-transparent" aria-hidden />
          </div>
        </Link>

        <div className="pointer-events-none absolute left-2.5 top-2.5 flex flex-wrap gap-1">
          {card.isVip ? <Badge tone="vip">VIP</Badge> : null}
          {card.isNew ? <Badge tone="new">New</Badge> : null}
          {card.quality === "4k" ? <Badge>4K</Badge> : null}
        </div>

        <button
          type="button"
          onClick={toggleFavorite}
          aria-pressed={fav}
          aria-label={fav ? `Remove ${card.title} from favorites` : `Save ${card.title} to favorites`}
          className="absolute right-2 top-2 grid size-9 place-items-center rounded-full bg-ink-950/55 backdrop-blur transition-colors hover:bg-ink-950/80"
        >
          <Heart
            size={17}
            className={cn(fav ? "fill-ember-500 text-ember-500" : "text-bone-50", popping && "animate-pop")}
            onAnimationEnd={() => setPopping(false)}
          />
        </button>

        <div className="absolute inset-x-2.5 bottom-2.5 flex items-center justify-between gap-2">
          {card.mediaWithheld ? (
            <Link href={verifyHref(signedIn)} className="pointer-events-auto inline-flex h-7 items-center gap-1 rounded-full bg-ink-950/60 px-2.5 text-[12px] text-ember-300 backdrop-blur hover:text-ember-200">
              <ShieldCheck size={12} aria-hidden /> {signedIn ? "Verify now" : "Sign in"}
            </Link>
          ) : card.mediaType === "video" ? (
            <button
              type="button"
              onClick={() => (previewing ? stop() : play())}
              className="pointer-events-auto inline-flex h-7 items-center gap-1 rounded-full bg-ink-950/60 px-2.5 text-[12px] text-bone-50 backdrop-blur"
              aria-label={previewing ? "Pause preview" : `Preview ${card.title}`}
              disabled={!card.previewUrl}
            >
              <Play size={12} className="fill-current" aria-hidden /> {card.durationS ? `${card.durationS}s` : "Video"}
            </button>
          ) : (
            <span />
          )}
          <Link
            href={`/templates/${card.slug}#make`}
            className="inline-flex h-8 translate-y-1 items-center gap-1.5 rounded-full bg-ember-500 px-3.5 text-[13px] font-semibold text-ink-950 opacity-0 transition-all duration-[var(--duration-base)] ease-[var(--ease-weave)] group-hover:translate-y-0 group-hover:opacity-100 focus:translate-y-0 focus:opacity-100 max-lg:translate-y-0 max-lg:opacity-100"
          >
            <Wand2 size={14} aria-hidden /> Make
          </Link>
        </div>
      </div>

      <div className="mt-2.5 flex items-start justify-between gap-2 px-0.5">
        <div className="min-w-0">
          <h3 className="truncate font-display text-[17px] leading-snug">
            <Link href={`/templates/${card.slug}`} className="hover:text-ember-300">
              {card.title}
            </Link>
          </h3>
          <Link href={`/creators/${card.creator.handle}`} className="block truncate font-mono text-[11.5px] text-bone-400 hover:text-bone-200">
            @{card.creator.handle}
          </Link>
        </div>
        <span className="shrink-0 pt-1 font-mono text-[11px] text-bone-500" title={`${favCount} favorites`}>
          ♥ {compact(favCount)}
        </span>
      </div>
    </article>
  );
}

export function TemplateGrid({ cards, signedIn, autoplay, editorial }: { cards: Card[]; signedIn: boolean; autoplay?: boolean; editorial?: boolean }) {
  return (
    <div className="grid grid-flow-row-dense grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 sm:gap-x-4 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
      {cards.map((c, i) => (
        <TemplateCard key={c.id} card={c} signedIn={signedIn} autoplay={autoplay} feature={editorial && i % 11 === 0} />
      ))}
    </div>
  );
}

export function TemplateRail({ cards, signedIn }: { cards: Card[]; signedIn: boolean }) {
  return (
    <div className="scrollbar-none -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6" role="list">
      {cards.map((c) => (
        <div key={c.id} role="listitem" className="w-[42vw] max-w-[220px] shrink-0 snap-start sm:w-[200px]">
          <TemplateCard card={c} signedIn={signedIn} />
        </div>
      ))}
    </div>
  );
}

export function GridSkeleton({ count = 10 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 sm:gap-x-4 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div key={i}>
          <div className="petal skeleton aspect-[4/5]" />
          <div className="skeleton mt-3 h-4 w-3/4 rounded" />
          <div className="skeleton mt-1.5 h-3 w-1/3 rounded" />
        </div>
      ))}
    </div>
  );
}
