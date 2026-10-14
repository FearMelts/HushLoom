import { RouteLoading } from "@/components/route-loading";

/**
 * In the (list) route group so this boundary wraps the Library list only, not /collection/[id]: a page under a
 * loading boundary has already streamed its 200 shell when it calls notFound(), so the 404 would be lost.
 */
export default function Loading() {
  return <RouteLoading kicker="Private to you" title="Library" count={12} />;
}
