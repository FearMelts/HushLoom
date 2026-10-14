import { RouteLoading } from "@/components/route-loading";
import { Skeleton } from "@/components/ui";

/**
 * The home page's loading state: a hero-sized block, then a grid. It sits in the (home) route group so
 * its Suspense boundary wraps the home page only. A loading.tsx at the app root would wrap every route,
 * and a page under a loading boundary has already streamed its 200 shell when it calls notFound() or
 * redirect(): a missing template, creation or creator would answer 200 instead of 404 (or 307).
 */
export default function Loading() {
  return (
    <div className="space-y-10">
      <Skeleton className="panel h-48 sm:h-64" />
      <RouteLoading />
    </div>
  );
}
