import { GridSkeleton } from "@/components/template-card";
import { Skeleton } from "@/components/ui";

/** A creator profile: avatar and name, then their published templates. */
export default function Loading() {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">Loading profile…</span>
      <div className="mb-10 flex items-center gap-4" aria-hidden>
        <Skeleton className="size-[72px] rounded-[40%_12%_40%_12%]" />
        <div>
          <Skeleton className="h-9 w-56 max-w-full rounded-lg" />
          <Skeleton className="mt-2 h-3.5 w-24 rounded" />
        </div>
      </div>
      <div aria-hidden>
        <p className="tag text-ember-400">Published</p>
        <Skeleton className="mb-4 mt-1 h-8 w-40 rounded-lg" />
        <GridSkeleton count={10} />
      </div>
    </div>
  );
}
