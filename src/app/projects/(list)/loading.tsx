import { RouteLoading } from "@/components/route-loading";

/**
 * In the (list) route group so this boundary wraps the project list only, not /projects/[id]: a page under a
 * loading boundary has already streamed its 200 shell when it calls notFound(), so the 404 would be lost.
 */
export default function Loading() {
  return <RouteLoading kicker="Scenes that belong together" title="Projects" grid="wide" count={6} />;
}
