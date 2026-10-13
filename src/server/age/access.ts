import { headers } from "next/headers";
import { cache } from "react";
import { getCurrentUser } from "@/server/auth/session";
import { contextFromHeaders } from "./rules";
import { viewerAccessFor, type ViewerAccess } from "./service";

/**
 * The viewer's explicit-content access for the current request: who they are, the jurisdiction
 * from the stored account value or the geo headers, and whether explicit media may be shown.
 * Cached per request, so every card loader on a page shares one decision. Pages and route
 * handlers pass `access.viewer` to the discovery queries, which then withhold media URLs
 * server-side rather than hiding them with CSS.
 */
export const viewerAccess = cache(async (): Promise<ViewerAccess> => {
  const [user, h] = await Promise.all([getCurrentUser(), headers()]);
  return viewerAccessFor(user, contextFromHeaders(h));
});
