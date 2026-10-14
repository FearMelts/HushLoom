import { GridSkeleton } from "@/components/template-card";
import { Skeleton } from "@/components/ui";

/** A project: its title, the scene timeline, then the guide beside the takes. */
export default function Loading() {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">Loading project…</span>
      <div aria-hidden>
        <Skeleton className="mb-3 h-3.5 w-20 rounded" />
        <Skeleton className="mb-6 h-9 w-72 max-w-full rounded-lg" />
        <div className="-mx-4 mb-8 flex gap-3 overflow-hidden px-4 pb-2">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="w-44 shrink-0">
              <div className="petal skeleton aspect-video" />
              <div className="skeleton mt-2 h-3.5 w-24 rounded" />
            </div>
          ))}
        </div>
        <div className="grid gap-8 lg:grid-cols-[340px_1fr]">
          <Skeleton className="panel h-96" />
          <GridSkeleton count={3} />
        </div>
      </div>
    </div>
  );
}
