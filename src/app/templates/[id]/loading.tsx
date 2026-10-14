import { GridSkeleton } from "@/components/template-card";
import { Skeleton } from "@/components/ui";

/** A template: the cover beside its title, creator, stats and the make panel. */
export default function Loading() {
  return (
    <div className="space-y-12" role="status" aria-live="polite">
      <span className="sr-only">Loading template…</span>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:gap-10" aria-hidden>
        <div className="petal skeleton aspect-[4/5]" />
        <div className="min-w-0">
          <div className="flex gap-1.5">
            <Skeleton className="h-5 w-12 rounded-[4px]" />
            <Skeleton className="h-5 w-16 rounded-[4px]" />
          </div>
          <Skeleton className="mt-4 h-11 w-4/5 rounded-lg" />
          <div className="mt-5 flex items-center gap-2.5">
            <Skeleton className="size-9 rounded-full" />
            <div>
              <Skeleton className="h-3.5 w-28 rounded" />
              <Skeleton className="mt-1.5 h-3 w-20 rounded" />
            </div>
          </div>
          <Skeleton className="mt-5 h-4 w-full rounded" />
          <Skeleton className="mt-2 h-4 w-2/3 rounded" />
          <Skeleton className="panel mt-7 h-72" />
        </div>
      </div>
      <div aria-hidden>
        <Skeleton className="mb-4 h-8 w-56 rounded-lg" />
        <GridSkeleton count={6} />
      </div>
    </div>
  );
}
