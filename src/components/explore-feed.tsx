"use client";

import { Search } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { TemplateCard as Card } from "@/server/discovery/templates";
import { api } from "@/lib/api";
import { GridSkeleton, TemplateGrid } from "./template-card";
import { Chip, EmptyState, buttonClass } from "./ui";

const SORT_LABELS = [
  ["trending", "Trending"],
  ["new", "New"],
  ["top_rated", "Top rated"],
  ["most_favorited", "Most loved"],
] as const;

type Query = { q: string; category: string; media: string; sort: string };

export function ExploreFeed({
  initial,
  categories,
  query,
  signedIn,
}: {
  initial: { items: Card[]; hasMore: boolean };
  categories: { slug: string; name: string }[];
  query: Query;
  signedIn: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [items, setItems] = useState(initial.items);
  const [hasMore, setHasMore] = useState(initial.hasMore);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState(query.q);
  const sentinel = useRef<HTMLDivElement>(null);

  const go = (patch: Partial<Query>) => {
    const next = { ...query, ...patch };
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v && !(k === "sort" && v === "trending")) sp.set(k, v);
    router.push(`${pathname}${sp.size ? `?${sp}` : ""}`);
  };

  async function loadMore() {
    if (loading || !hasMore) return;
    setLoading(true);
    const sp = new URLSearchParams({ offset: String(items.length), limit: "24", sort: query.sort });
    if (query.q) sp.set("q", query.q);
    if (query.category) sp.set("category", query.category);
    if (query.media) sp.set("media", query.media);
    try {
      const page = await api<{ items: Card[]; hasMore: boolean }>(`/api/templates?${sp}`);
      setItems((prev) => [...prev, ...page.items.filter((c) => !prev.some((p) => p.id === c.id))]);
      setHasMore(page.hasMore);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && void loadMore(), { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  });

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
        <div role="tablist" aria-label="Sort" className="flex gap-5 border-b border-[var(--line)]">
          {SORT_LABELS.map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={query.sort === key}
              onClick={() => go({ sort: key })}
              className={
                query.sort === key
                  ? "-mb-px border-b-2 border-ember-500 pb-2.5 text-[14.5px] font-semibold text-bone-50"
                  : "-mb-px border-b-2 border-transparent pb-2.5 text-[14.5px] text-bone-400 hover:text-bone-50"
              }
            >
              {label}
            </button>
          ))}
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
          <span className="mx-1 w-px shrink-0 bg-[var(--line)]" aria-hidden />
          {categories.map((c) => (
            <Chip key={c.slug} active={query.category === c.slug} onClick={() => go({ category: query.category === c.slug ? "" : c.slug })}>
              {c.name}
            </Chip>
          ))}
        </div>
      </div>

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
    </div>
  );
}
