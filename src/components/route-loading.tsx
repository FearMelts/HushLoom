import { cn } from "@/lib/cn";
import { GridSkeleton } from "./template-card";
import { Skeleton } from "./ui";

/**
 * Route-level loading state (loading.tsx): the real page heading when it is known, then a
 * shimmer in the shape of what is coming. The shell stays interactive above it.
 */
export function RouteLoading({
  kicker,
  title,
  grid = "templates",
  count = 10,
  className,
}: {
  kicker?: string;
  title?: string;
  grid?: "templates" | "wide" | "none";
  count?: number;
  className?: string;
}) {
  return (
    <div className={cn("space-y-6", className)} role="status" aria-live="polite">
      <span className="sr-only">Loading{title ? ` ${title}` : ""}…</span>
      <div aria-hidden>
        {kicker ? <p className="tag text-ember-400">{kicker}</p> : <Skeleton className="h-3 w-28 rounded" />}
        {title ? <p className="font-display text-4xl">{title}</p> : <Skeleton className="mt-2 h-9 w-64 max-w-full rounded-lg" />}
      </div>
      {grid === "templates" ? <GridSkeleton count={count} /> : null}
      {grid === "wide" ? <WideSkeleton count={count} /> : null}
    </div>
  );
}

/** Project-style cards: 16:9 covers in one to three columns. */
export function WideSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div key={i}>
          <div className="petal skeleton aspect-video" />
          <div className="skeleton mt-3 h-5 w-1/2 rounded" />
          <div className="skeleton mt-1.5 h-3 w-1/3 rounded" />
        </div>
      ))}
    </div>
  );
}
