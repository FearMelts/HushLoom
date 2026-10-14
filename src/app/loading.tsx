import { RouteLoading } from "@/components/route-loading";
import { Skeleton } from "@/components/ui";

/** Fallback for any page without its own loading state: a hero-sized block, then a grid. */
export default function Loading() {
  return (
    <div className="space-y-10">
      <Skeleton className="panel h-48 sm:h-64" />
      <RouteLoading />
    </div>
  );
}
