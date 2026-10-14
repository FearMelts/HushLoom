/**
 * CSRF defense in depth (cookies are also SameSite=Lax): browser writes to the API must come from
 * this origin. Webhooks authenticate by signature instead. Used by the middleware, and by the upload
 * routes the middleware does not run on (src/middleware.ts). Edge-safe: no server-only imports.
 */
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isCrossSiteWrite(req: { method: string; headers: Headers; nextUrl: { origin: string; pathname: string } }): boolean {
  if (!req.nextUrl.pathname.startsWith("/api/") || !MUTATING.has(req.method) || req.nextUrl.pathname.startsWith("/api/webhooks/")) return false;
  const origin = req.headers.get("origin");
  // Behind a proxy the request URL may carry the internal host, so the public APP_URL also counts.
  const publicOrigin = process.env.APP_URL ? new URL(process.env.APP_URL).origin : null;
  return Boolean(origin && origin !== req.nextUrl.origin && origin !== publicOrigin);
}
