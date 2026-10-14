import { Skeleton } from "@/components/ui";

/** One creation: the media beside its status, prompt and actions. */
export default function Loading() {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">Loading creation…</span>
      <div aria-hidden>
        <Skeleton className="mb-4 h-3.5 w-20 rounded" />
        <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr] lg:gap-10">
          <div className="petal skeleton aspect-[4/5] max-h-[78vh]" />
          <div>
            <Skeleton className="h-5 w-32 rounded" />
            <Skeleton className="mt-4 h-4 w-full rounded" />
            <Skeleton className="mt-2 h-4 w-3/4 rounded" />
            <div className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {Array.from({ length: 9 }, (_, i) => (
                <Skeleton key={i} className="h-10 rounded-full" />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
