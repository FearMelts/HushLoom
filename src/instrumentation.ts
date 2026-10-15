import type { Instrumentation } from "next";

/**
 * Next.js instrumentation: runs once when a server process starts, and on every error Next.js catches.
 *
 * register() installs the optional error webhook (ERROR_WEBHOOK_URL, src/server/observability.ts).
 * onRequestError() reports what Next.js catches itself: server component renders, server actions and
 * handlers that throw past route(). Errors route() turns into a 500 are logged there already, so none
 * is reported twice; notFound() and redirects never reach this hook. In production Next.js also prints
 * each error it reports here with console.error: for App Router pages and route handlers before this
 * hook runs (RouteModule.onRequestError), elsewhere after it. A Drizzle error scrubs its query
 * parameters itself when printed (scrubWhenInspected, installed by src/server/db), and the hook redacts
 * the reported error in place too (scrubQueryParams in src/server/log.ts), wrappers included.
 *
 * Both only act in the Node.js runtime. The imports sit inside the runtime check so the Edge bundle
 * (middleware) never pulls in the server modules.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { installErrorWebhook } = await import("@/server/observability");
    installErrorWebhook("web");
  }
}

export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { logger, scrubQueryParams } = await import("@/server/log");
    // The path without its query string: those can carry signed-link signatures and webhook tokens.
    logger.error("request error", {
      err,
      path: request.path.split("?")[0],
      method: request.method,
      route: context.routePath,
      routeType: context.routeType,
    });
    // Next.js may print this same error object again after this hook, so its query parameters (search
    // text, prompts, emails) are removed from it here too.
    scrubQueryParams(err);
  }
};
