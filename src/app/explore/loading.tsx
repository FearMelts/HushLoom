import { GridSkeleton } from "@/components/template-card";
import { Skeleton } from "@/components/ui";

export default function Loading() {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">Loading templates…</span>
      <div className="mb-5 flex flex-col gap-4" aria-hidden>
        <p className="font-display text-4xl">Explore</p>
        <div className="flex gap-5 border-b border-[var(--line)] pb-2.5">
          <Skeleton className="h-4 w-[72px] rounded" />
          <Skeleton className="h-4 w-10 rounded" />
          <Skeleton className="h-4 w-[76px] rounded" />
          <Skeleton className="h-4 w-[84px] rounded" />
        </div>
        <div className="flex gap-2 overflow-hidden">
          {Array.from({ length: 7 }, (_, i) => (
            <Skeleton key={i} className="h-8 w-20 shrink-0 rounded-full max-sm:h-10" />
          ))}
        </div>
      </div>
      <GridSkeleton count={12} />
    </div>
  );
}
