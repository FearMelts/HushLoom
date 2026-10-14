"use client";

import { Crown, Search } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TemplateCard as Card } from "@/server/discovery/templates";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { GridSkeleton, TemplateGrid } from "./template-card";
import { Chip, EmptyState, buttonClass, radioGroupKeys, useToast } from "./ui";

const SORT_LABELS = [
  ["trending", "Trending"],
  ["new", "New"],
  ["top_rated", "Top rated"],
  ["most_favorited", "Most loved"],
] as const;
const SORT_KEYS = SORT_LABELS.map(([key]) => key);

export type ExploreQuery = { q: string; category: string; media: string; sort: string; vipOnly: string };

/**
 * Explore: search, sort and filters stay mounted while the results below change, so keyboard
 * focus stays on the control you just used. Every filter lives in the URL.
 */
export function ExploreFeed({
  initial,
  categories,
  query,
  signedIn,
}: {
  initial: { items: Card[]; hasMore: boolean };
  categories: { slug: string; name: string }[];
  query: ExploreQuery;
  signedIn: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [q, setQ] = useState(query.q);
  useEffect(() => setQ(query.q), [query.q]);

  const go = (patch: Partial<ExploreQuery>) => {
    const next = { ...query, ...patch };
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v && !(k === "sort" && v === "trending")) sp.set(k, v);
    router.push(`${pathname}${sp.size ? `?${sp}` : ""}`, { scroll: false });
  };

  return (
    <div>
      <div className="mb-5 flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h1 className="font-display text-4xl">{query.q ? <>Results for “{query.q}”</> : "Explore"}</h1>
          <form
            role="search"
            className="relative w-full sm:hidden"
            onSubmit={(e) => {
              e.preventDefault();
              go({ q });
            }}
          >
            <Search className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-bone-500" size={16} aria-hidden />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              type="search"
              aria-label="Search templates"
              placeholder="Search templates, moods, creators"
              className="h-11 w-full rounded-full bg-ink-900 pl-10 pr-4 text-sm hairline placeholder:text-bone-500 focus:outline-none focus:ring-2 focus:ring-ember-400/70"
            />
          </form>
        </div>
        {/* Sort is one choice of four: a radio group, arrow keys move between options. */}
        <div
          role="radiogroup"
          aria-label="Sort"
          className="flex gap-3 border-b border-[var(--line)]"
          onKeyDown={radioGroupKeys(SORT_KEYS, query.sort, (sort) => go({ sort }))}
        >
          {SORT_LABELS.map(([key, label]) => {
            const checked = query.sort === key;
            return (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={checked ? 0 : -1}
                onClick={() => go({ sort: key })}
                className={cn(
                  // At least 40x40: px-1 widens short labels ("New"), and the gap is narrowed to match.
                  "-mb-px inline-flex min-h-10 min-w-10 items-center justify-center border-b-2 px-1 pb-2.5 pt-1.5 text-[14.5px]",
                  checked ? "border-ember-500 font-semibold text-bone-50" : "border-transparent text-bone-400 hover:text-bone-50",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div className="scrollbar-none -mx-1 flex gap-2 overflow-x-auto px-1">
          <Chip active={!query.media} onClick={() => go({ media: "" })}>
            Everything
          </Chip>
          <Chip active={query.media === "image"} onClick={() => go({ media: "image" })}>
            Images
          </Chip>
          <Chip active={query.media === "video"} onClick={() => go({ media: "video" })}>
            Videos
          </Chip>
          <Chip active={query.vipOnly === "1"} onClick={() => go({ vipOnly: query.vipOnly === "1" ? "" : "1" })} className="inline-flex items-center gap-1.5">
            <Crown size={13} className={query.vipOnly === "1" ? "text-ink-950" : "text-brass-400"} aria-hidden /> VIP
          </Chip>
          <span className="mx-1 w-px shrink-0 bg-[var(--line)]" aria-hidden />
          {categories.map((c) => (
            <Chip key={c.slug} active={query.category === c.slug} onClick={() => go({ category: query.category === c.slug ? "" : c.slug })}>
              {c.name}
            </Chip>
          ))}
        </div>
      </div>

      <ExploreResults key={JSON.stringify([query.q, query.category, query.media, query.sort, query.vipOnly])} initial={initial} query={query} signedIn={signedIn} />
    </div>
  );
}

/** The grid for one query, with infinite scroll and a visible "Load more" fallback. */
function ExploreResults({ initial, query, signedIn }: { initial: { items: Card[]; hasMore: boolean }; query: ExploreQuery; signedIn: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [items, setItems] = useState(initial.items);
  const [hasMore, setHasMore] = useState(initial.hasMore);
  const [loading, setLoading] = useState(false);
  const busy = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);

  const loadMore = useCallback(async () => {
    if (busy.current || !hasMore) return;
    busy.current = true;
    setLoading(true);
    const sp = new URLSearchParams({ offset: String(items.length), limit: "24", sort: query.sort });
    if (query.q) sp.set("q", query.q);
    if (query.category) sp.set("category", query.category);
    if (query.media) sp.set("media", query.media);
    if (query.vipOnly) sp.set("vipOnly", query.vipOnly);
    try {
      const page = await api<{ items: Card[]; hasMore: boolean }>(`/api/templates?${sp}`);
      setItems((prev) => [...prev, ...page.items.filter((c) => !prev.some((p) => p.id === c.id))]);
      setHasMore(page.hasMore);
    } catch (e) {
      toast({ message: e instanceof ApiError ? e.message : "Couldn't load more. Check your connection and try again.", tone: "error" });
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [hasMore, items.length, query, toast]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && void loadMore(), { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadMore]);

  return (
    <>
      {items.length === 0 ? (
        <EmptyState
          title="Nothing matches yet"
          body="Try a broader word, another category, or clear the filters."
          action={
            <button className={buttonClass("ghost")} onClick={() => router.push("/explore")}>
              Clear filters
            </button>
          }
        />
      ) : (
        <TemplateGrid cards={items} signedIn={signedIn} />
      )}
      <div ref={sentinel} className="h-px" />
      {loading ? (
        <div className="mt-6">
          <GridSkeleton count={5} />
        </div>
      ) : null}
      {hasMore && !loading ? (
        <div className="mt-8 flex justify-center">
          <button className={buttonClass("ghost")} onClick={() => void loadMore()}>
            Load more
          </button>
        </div>
      ) : null}
    </>
  );
}
