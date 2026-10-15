"use client";

import { Heart, Play, ShieldCheck, Wand2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type KeyboardEvent } from "react";
import type { TemplateCard as Card } from "@/server/discovery/templates";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { compact } from "@/lib/format";
import { Badge, buttonClass, useToast } from "./ui";

/**
 * Shown in place of a template's media when the viewer still needs an age check (addendum §2).
 * The server issued no media URL, so there is nothing here to unblur; the title and creator stay.
 */
export const verifyHref = (signedIn: boolean) => (signedIn ? "/settings#age-verification" : "/auth?next=/settings%23age-verification");

export function WithheldMedia({ signedIn, compact, link = true, label }: { signedIn: boolean; compact?: boolean; link?: boolean; label?: string }) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-[radial-gradient(circle_at_30%_20%,color-mix(in_oklab,var(--color-ember-700)_28%,transparent),transparent_60%),linear-gradient(160deg,var(--color-ink-800),var(--color-ink-950))] p-3 text-center">
      <div>
        <ShieldCheck size={compact ? 20 : 28} className="mx-auto text-ember-300" aria-hidden />
        <p className={cn("mt-2 font-display leading-snug text-bone-100", compact ? "text-[13px]" : "text-base")}>{label ?? (signedIn ? "Verify your age to see previews" : "Sign in and verify to see previews")}</p>
        {link ? (
          // The cover's one action: a real button on a full-size cover, a 40 px text link on a small tile.
          <Link
            href={verifyHref(signedIn)}
            className={
              compact
                ? "mt-1 inline-flex min-h-10 items-center font-mono text-[11px] uppercase tracking-[0.08em] text-ember-400 underline-offset-2 hover:underline"
                : buttonClass("ember", "md", "mt-4")
            }
          >
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
export function TemplateCard({ card, feature, signedIn, autoplay, className }: { card: Card; feature?: boolean; signedIn: boolean; autoplay?: boolean; className?: string }) {
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
      className={cn("group relative animate-rise", feature && "sm:col-span-2 sm:row-span-2", className)}
      onMouseEnter={play}
      onMouseLeave={stop}
      onFocus={play}
      onBlur={stop}
    >
      <div className="petal relative overflow-hidden bg-ink-850 hairline transition-transform duration-[var(--duration-base)] ease-[var(--ease-weave)] group-hover:-translate-y-1">
        <Link
          href={`/templates/${card.slug}`}
          data-card-link
          className="block"
          aria-label={`${card.title} by ${card.creator.displayName}${card.isDemo ? ", demo media" : ""}`}
        >
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
          {/* The current version runs on a sandbox model: the result is a placeholder, never a real render. */}
          {card.isDemo ? <Badge tone="demo">Demo</Badge> : null}
        </div>

        <button
          type="button"
          onClick={toggleFavorite}
          aria-pressed={fav}
          aria-label={fav ? `Remove ${card.title} from favorites` : `Save ${card.title} to favorites`}
          className="absolute right-2 top-2 grid size-10 place-items-center rounded-full bg-ink-950/55 backdrop-blur transition-colors hover:bg-ink-950/80"
        >
          <Heart
            size={17}
            className={cn(fav ? "fill-ember-500 text-ember-500" : "text-bone-50", popping && "animate-pop")}
            onAnimationEnd={() => setPopping(false)}
          />
        </button>

        <div className="absolute inset-x-2.5 bottom-2.5 flex items-center justify-between gap-2">
          {card.mediaWithheld ? (
            <Link
              href={verifyHref(signedIn)}
              className="pointer-events-auto inline-flex h-10 shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-ink-950/60 px-2.5 text-[12px] text-ember-300 backdrop-blur hover:text-ember-200"
            >
              <ShieldCheck size={12} className="shrink-0" aria-hidden /> {signedIn ? "Verify now" : "Sign in"}
            </Link>
          ) : card.mediaType === "video" ? (
            <button
              type="button"
              onClick={() => (previewing ? stop() : play())}
              className="pointer-events-auto inline-flex h-10 min-w-10 items-center justify-center gap-1 rounded-full bg-ink-950/60 px-3 text-[12px] text-bone-50 backdrop-blur"
              aria-label={previewing ? "Pause preview" : `Preview ${card.title}`}
              disabled={!card.previewUrl}
            >
              <Play size={12} className="fill-current" aria-hidden /> {card.durationS ? `${card.durationS}s` : "Video"}
            </button>
          ) : (
            <span />
          )}
          {/* Withheld cards keep Make as an icon, so the verification pill beside it never has to wrap. */}
          <Link
            href={`/templates/${card.slug}#make`}
            aria-label={card.mediaWithheld ? `Make ${card.title}` : undefined}
            className={cn(
              "inline-flex h-10 shrink-0 translate-y-1 items-center gap-1.5 rounded-full bg-ember-500 text-[13px] font-semibold text-ink-950 opacity-0 transition-all duration-[var(--duration-base)] ease-[var(--ease-weave)] group-hover:translate-y-0 group-hover:opacity-100 focus:translate-y-0 focus:opacity-100 max-lg:translate-y-0 max-lg:opacity-100",
              card.mediaWithheld ? "w-10 justify-center" : "px-3.5",
            )}
          >
            <Wand2 size={14} aria-hidden />
            {card.mediaWithheld ? null : "Make"}
          </Link>
        </div>
      </div>

      <div className="mt-2.5 flex items-start justify-between gap-2 px-0.5">
        <div className="min-w-0">
          <h3 className="truncate font-display text-[17px] leading-snug">
            {/* Same destination as the media link above: one tab stop per card, still clickable. */}
            <Link href={`/templates/${card.slug}`} tabIndex={-1} className="hover:text-ember-300">
              {card.title}
            </Link>
          </h3>
          {/*
            A 40 px tap target that keeps the caption compact: the box reaches 4 px above the handle's line and 19 px
            below it (into the gap under the card), and the negative margins give that room back.
          */}
          <Link
            href={`/creators/${card.creator.handle}`}
            className="-mb-[19px] -mt-1 block min-h-10 truncate pt-1 font-mono text-[11.5px] leading-[17px] text-bone-400 hover:text-bone-200"
          >
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

/**
 * Arrow keys between cards in a grid. Left and Right step through reading order; Up and Down
 * jump to the nearest card in the row above or below, measured on screen so the dense layout
 * and its featured tiles do not confuse it. Tab still walks every control as before.
 */
function onGridKeys(e: KeyboardEvent<HTMLDivElement>) {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
  const current = (e.target as HTMLElement).closest<HTMLElement>("[data-card-link]");
  if (!current) return;
  const links = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-card-link]"));
  const index = links.indexOf(current);
  let next: HTMLElement | undefined;
  if (e.key === "ArrowLeft") next = links[index - 1];
  else if (e.key === "ArrowRight") next = links[index + 1];
  else {
    const from = current.getBoundingClientRect();
    const down = e.key === "ArrowDown";
    let best = Infinity;
    for (const link of links) {
      const r = link.getBoundingClientRect();
      const dy = down ? r.top - from.bottom : from.top - r.bottom;
      if (dy < -1) continue;
      const score = dy * 4 + Math.abs(r.left - from.left);
      if (link !== current && score < best) {
        best = score;
        next = link;
      }
    }
  }
  if (!next) return;
  e.preventDefault();
  next.focus();
  next.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/**
 * The grid's column count at each breakpoint (it must match TemplateGrid's classes), whether the editorial
 * feature tile (2x2 from sm) applies there, and the class that hides an item at that breakpoint only.
 */
const EDITORIAL_TRIM = [
  { cols: 2, featured: false, hide: "max-sm:hidden" },
  { cols: 3, featured: true, hide: "sm:max-md:hidden" },
  { cols: 4, featured: true, hide: "md:max-xl:hidden" },
  { cols: 5, featured: true, hide: "xl:max-2xl:hidden" },
  { cols: 6, featured: true, hide: "2xl:hidden" },
] as const;

/**
 * An editorial grid features its first card and ends on a whole row at every width: the cards that would
 * start a last, partial row are hidden at that width (never so many that no full row is left).
 */
function editorialTrim(index: number, count: number): string[] {
  return EDITORIAL_TRIM.filter(({ cols, featured }) => {
    const cells = count + (featured ? 3 : 0);
    const extra = cells % cols;
    return extra > 0 && cells - extra >= cols && index >= count - extra;
  }).map((t) => t.hide);
}

export function TemplateGrid({ cards, signedIn, autoplay, editorial }: { cards: Card[]; signedIn: boolean; autoplay?: boolean; editorial?: boolean }) {
  return (
    <div
      onKeyDown={onGridKeys}
      className="grid grid-flow-row-dense grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 sm:gap-x-4 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
      {cards.map((c, i) => (
        <TemplateCard
          key={c.id}
          card={c}
          signedIn={signedIn}
          autoplay={autoplay}
          feature={editorial && i === 0}
          className={editorial ? cn(editorialTrim(i, cards.length)) : undefined}
        />
      ))}
    </div>
  );
}

export function TemplateRail({ cards, signedIn }: { cards: Card[]; signedIn: boolean }) {
  return (
    // Scroll padding equal to the gutter: snap-start aligns cards to the snapport, which ignores the rail's own
    // padding, so without it the first card snaps flush to the screen edge instead of the content edge.
    // pb-5 holds the creator link's tap area, which reaches 19 px below each card's caption.
    <div className="scrollbar-none -mx-4 flex scroll-px-4 snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-5 sm:-mx-6 sm:scroll-px-6 sm:px-6" role="list">
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
