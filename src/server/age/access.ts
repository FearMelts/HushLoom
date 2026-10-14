import { cookies, headers } from "next/headers";
import { cache } from "react";
import { getCurrentUser } from "@/server/auth/session";
import { contextFromHeaders } from "./rules";
import { viewerAccessFor, type ViewerAccess } from "./service";

/** Set by the step-one age gate (POST /api/age-gate). A signed-in member passed the date-of-birth check at signup instead. */
export const AGE_GATE_COOKIE = "hl_age_ok";

/**
 * The viewer's explicit-content access for the current request: who they are, the jurisdiction
 * from the stored account value or the geo headers, and whether explicit media may be shown.
 * Cached per request, so every card loader on a page shares one decision. Pages and route
 * handlers pass `access.viewer` to the discovery queries, which then withhold media URLs
 * server-side rather than hiding them with CSS. An anonymous visitor who has not passed the
 * step-one gate gets no media anywhere: the root layout only swaps the page for the gate, while
 * the API and the page's own render data would still carry whatever URLs it was given.
 */
export const viewerAccess = cache(async (): Promise<ViewerAccess> => {
  const [user, h, c] = await Promise.all([getCurrentUser(), headers(), cookies()]);
  const access = await viewerAccessFor(user, contextFromHeaders(h));
  if (user || c.get(AGE_GATE_COOKIE)?.value === "1") return access;
  return { ...access, explicitAllowed: false, viewer: { ...access.viewer, explicitAllowed: false } };
});
