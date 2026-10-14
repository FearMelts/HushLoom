import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { format } from "node:util";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, test, vi } from "vitest";
import { closeDb, getDb } from "@/server/db";
import { generationJobs, users } from "@/server/db/schema";
import { logger, scrubQueryParams, setErrorSink } from "@/server/log";
import { createErrorWebhook } from "@/server/observability";
import { notifyJobFinished } from "@/server/push/notify";
import { closeRedis } from "@/server/redis";
import { makeUser, resetDb } from "../helpers";

/**
 * Attack tests for the infra cluster's fixes of I01 (Drizzle query parameters in log lines and error
 * webhook events) and I02 (Next.js printing a reported error after onRequestError). Tests that pass are
 * kept as regression tests. A test marked test.fails is a hole that is still open: its comment names it.
 */

const require_ = createRequire(import.meta.url);
const URL_ = "https://monitor.example.test/hooks/hushloom";

type Call = { body: string };
function fakeFetch() {
  const calls: Call[] = [];
  const fn = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    calls.push({ body: String(init?.body) });
    return new Response(null, { status: 202 });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Everything console.error printed, formatted at the moment of the call as a real console would write it. */
let printed: string[];
beforeEach(() => {
  printed = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void printed.push(format(...args)));
});
afterEach(() => {
  setErrorSink(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await closeDb();
  await closeRedis();
});

const QUERY = `insert into "generation_jobs" ("prompt", "negative_prompt") values ($1, $2)`;
const timeout = () => new Error("canceling statement due to statement timeout");

describe("I01: every Drizzle query parameter is redacted in log lines and webhook events", () => {
  // Each prompt hides a secret behind something a line-based redactor could mistake for the end of
  // the parameters: stack-frame lines with other whitespace and line endings, a spoofed redaction
  // marker, Unicode line separators.
  const prompts: [string, string][] = [
    ["SECRET_LF_FRAME", "two adults\n    at Object.<anonymous> (/app/server.js:1:1)\nSECRET_LF_FRAME"],
    ["SECRET_CRLF_FRAME", "two adults\r\n    at a masquerade\r\nSECRET_CRLF_FRAME"],
    ["SECRET_TAB_FRAME", "two adults\n\tat a masquerade\nSECRET_TAB_FRAME"],
    ["SECRET_SPOOFED_MARKER", "two adults\nparams: [redacted]\n    at x (y:1:1)\nSECRET_SPOOFED_MARKER"],
    ["SECRET_UNICODE_SEP", "two adults     at a masquerade SECRET_UNICODE_SEP"],
    ["SECRET_REPEATED_QUERY", `Failed query: ${QUERY}\nparams: x\n    at fake (/app/x.js:1:1)\nSECRET_REPEATED_QUERY`],
  ];

  it("holds: parameters that imitate frames, markers or line separators never reach stdout or the webhook", async () => {
    const { fetch, calls } = fakeFetch();
    setErrorSink(createErrorWebhook({ url: URL_, source: "web", fetch, maxPerMinute: 1000 }));
    for (const [secret, prompt] of prompts) {
      logger.error("unhandled route error", { path: "/api/generations", err: new DrizzleQueryError(QUERY, [prompt, "TAIL_NEGATIVE"], timeout()) });
    }
    await flush();
    expect(calls).toHaveLength(prompts.length);
    const out = printed.join("\n") + calls.map((c) => c.body).join("\n");
    for (const [secret] of prompts) expect(out).not.toContain(secret);
    expect(out).not.toContain("TAIL_NEGATIVE");
    // The frames survive: the redaction did not just drop the whole stack.
    for (const c of calls) expect(JSON.parse(c.body).error.stack).toMatch(/params: \[redacted\]\n\s+at /);
  });

  it("holds: a message changed after the stack was captured (stack no longer repeats it) is still redacted in both places", async () => {
    const { fetch, calls } = fakeFetch();
    setErrorSink(createErrorWebhook({ url: URL_, source: "worker", fetch }));
    const err = new DrizzleQueryError(QUERY, ["two adults\n\nat a masquerade SECRET_MUTATED", "TAIL"], timeout());
    err.message = `while settling job: ${err.message}`;
    logger.error("queue job crashed", { jobId: "j1", err });
    await flush();
    expect(printed.join("\n")).not.toContain("SECRET_MUTATED");
    expect(calls[0]!.body).not.toContain("SECRET_MUTATED");
    expect(JSON.parse(calls[0]!.body).error.message).toBe(`while settling job: Failed query: ${QUERY}\nparams: [redacted]`);
  });

  it("holds: a Drizzle error wrapped as the cause, or quoted inside another error's message, is redacted", async () => {
    const { fetch, calls } = fakeFetch();
    setErrorSink(createErrorWebhook({ url: URL_, source: "web", fetch }));
    const inner = () => new DrizzleQueryError(QUERY, ["masks half lifted SECRET_CAUSE", "TAIL"], timeout());
    logger.error("request error", { err: new Error("render failed", { cause: inner() }) });
    logger.error("request error", { err: new Error(`render failed: ${inner().message} (while rendering /explore)`) });
    await flush();
    expect(printed.join("\n")).not.toContain("SECRET_CAUSE");
    for (const c of calls) expect(c.body).not.toContain("SECRET_CAUSE");
    expect(JSON.parse(calls[0]!.body).error.cause.message).toBe(`Failed query: ${QUERY}\nparams: [redacted]`);
  });

  it("holds: the webhook redacts a Drizzle message passed as a plain string", async () => {
    const { fetch, calls } = fakeFetch();
    setErrorSink(createErrorWebhook({ url: URL_, source: "worker", fetch }));
    logger.error("generation.store_failed", { err: new DrizzleQueryError(QUERY, ["SECRET_STRING_HOOK", "x"], timeout()).message });
    await flush();
    expect(calls[0]!.body).not.toContain("SECRET_STRING_HOOK");
  });

  describe("with the database", () => {
    beforeAll(async () => {
      await resetDb();
    });

    // HOLE (low): serialize() in src/server/log.ts redacts only values that are Error instances. Call
    // sites that log a caught error's message as a string put the whole "params: ..." section on
    // stdout verbatim: push/notify.ts:63 (err: err.message), generation/service.ts:359,
    // generation/processor.ts:101, 106, 207 (message: err.message) and 223 (err: message). Today the
    // queries behind these sites bind ids, storage keys, hashes and timestamps, not prompts or emails,
    // so nothing private was found leaking this way; any new query there that binds user content would.
    test.fails("HOLE: a Drizzle error a call site logs as a string keeps its parameters on stdout (push.notify_failed)", async () => {
      // A bound value notify's first query cannot accept, so Postgres rejects it and Drizzle wraps it.
      const bound = "BOUND-VALUE-SECRET";
      const result = await notifyJobFinished(
        { userId: bound, jobId: "job-attack", outcome: "completed" },
        { vapid: { publicKey: "p", privateKey: "k", subject: "mailto:ops@example.test" } },
      );
      expect(result.skipped).toBe("error");
      const line = printed.find((p) => p.includes("push.notify_failed"));
      expect(line).toBeDefined();
      expect(line).not.toContain(bound);
    });
  });
});

describe("I02: no query parameters reach Next.js's own error printer", () => {
  const search = "masked strangers in a hotel corridor";
  const browse = `select "id", "title" from "templates" where "title" ilike $1 limit $2`;
  const renderCtx = { routerKind: "App Router" as const, routePath: "/explore", routeType: "render" as const, revalidateReason: undefined };
  const explore = { path: "/explore", method: "GET", headers: {} };
  let dir: string;

  beforeAll(() => {
    // The production server's environment: next-server.js:12 loads this before anything else. It puts
    // AsyncLocalStorage on globalThis and replaces Error's util.inspect and prepareStackTrace
    // (node-environment-extensions/error-inspect.js), so every print below is formatted the way the
    // production server formats it.
    require_("next/dist/server/node-environment");
    // The production route modules load instrumentation from <projectDir>/<distDir>/server/instrumentation.js
    // (next/dist/server/lib/router-utils/instrumentation-globals.external.js). This stand-in hands every
    // call to the app's real src/instrumentation.ts onRequestError, set on globalThis by each test.
    dir = mkdtempSync(path.join(tmpdir(), "hushloom-attack-"));
    mkdirSync(path.join(dir, ".next", "server"), { recursive: true });
    writeFileSync(path.join(dir, ".next", "server", "instrumentation.js"), "module.exports = { onRequestError: (...a) => globalThis.__hushloomOnRequestError(...a) };\n");
  });
  afterAll(() => {
    delete (globalThis as Record<string, unknown>).__hushloomOnRequestError;
    rmSync(dir, { recursive: true, force: true });
  });

  async function hook() {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const { onRequestError } = await import("@/instrumentation");
    (globalThis as Record<string, unknown>).__hushloomOnRequestError = onRequestError;
    return onRequestError;
  }

  type RouteModuleLike = { onRequestError(req: unknown, err: unknown, ctx: unknown, routerServerContext?: unknown): Promise<void> };
  /** A production route module (the class the built bundles instantiate) pointed at the stand-in instrumentation. */
  function productionModule(runtime: "app-page" | "app-route"): RouteModuleLike {
    const mod = require_(`next/dist/compiled/next-server/${runtime}.runtime.prod.js`) as Record<string, { prototype: object }>;
    const Cls = runtime === "app-page" ? mod.AppPageRouteModule! : mod.AppRouteRouteModule!;
    return Object.assign(Object.create(Cls.prototype), { distDir: ".next", relativeProjectDir: path.relative(process.cwd(), dir) }) as RouteModuleLike;
  }
  const hookRan = () => printed.some((p) => p.includes(`"msg":"request error"`));

  // HOLE (high, I02 not fixed for the App Router): in Next 15.5.27 every App Router page reports render
  // errors through RouteModule.onRequestError: app-page.js:415 in next/dist/build/templates, and in the
  // bundle the build emits (.next/server/app/explore/page.js of the main checkout:
  // "onInstrumentationRequestError:(b,c,d)=>L.onRequestError(a,b,d,ae)"). That method PRINTS the error
  // first, with routerServerContext.logErrorWithOriginalStack, which in production is `_log.error(err)`
  // (next/dist/server/lib/router-server.js:551), and only THEN awaits instrumentation.onRequestError
  // (next/dist/server/route-modules/route-module.js:261-271; the same order in
  // next/dist/compiled/next-server/app-page.runtime.prod.js, which the build requires). So
  // scrubQueryParams runs after the unredacted message, stack and `params` field are on stdout. The
  // ordering the I02 fix relies on (NextServer.instrumentationOnRequestError, next-server.js:1439-1444)
  // is not the path App Router pages and route handlers take (base-server.js:1406 hands them to the
  // module's own handler).
  test.fails("HOLE: a server component's query error is printed by Next.js before the hook can scrub it (App Router page, production)", async () => {
    await hook();
    const err = new DrizzleQueryError(browse, [`%${search}%`, 24], timeout());
    const routerServerContext = { logErrorWithOriginalStack: (e: unknown) => (require_("next/dist/build/output/log") as { error(...a: unknown[]): void }).error(e) };
    await productionModule("app-page").onRequestError({ url: "/explore?q=masked", headers: {}, method: "GET" }, err, renderCtx, routerServerContext);
    expect(hookRan()).toBe(true);
    expect(printed.join("\n")).not.toContain(search);
  });

  // HOLE (same cause, route handlers): a handler that throws past route() is reported by app-route.js:372
  // without a routerServerContext, so RouteModule.onRequestError falls back to console.error(err),
  // again before the hook. src/app/api/media/route.ts is the one handler not wrapped by route() that can
  // throw (health catches its own errors); its query binds the storage key, nothing more private.
  test.fails("HOLE: an unwrapped route handler's query error is printed by Next.js before the hook can scrub it (production)", async () => {
    await hook();
    const key = "outputs/0f0f0f0f-0000-4000-8000-000000000000/SECRET_STORAGE_KEY.webp";
    const err = new DrizzleQueryError(`select * from "media_assets" where "media_assets"."storage_key" = $1`, [key], timeout());
    await productionModule("app-route").onRequestError(
      { url: "/api/media", headers: {}, method: "GET" },
      err,
      { routerKind: "App Router", routePath: "/api/media", routeType: "route", revalidateReason: undefined },
    );
    expect(hookRan()).toBe(true);
    expect(printed.join("\n")).not.toContain("SECRET_STORAGE_KEY");
  });

  it("holds (control): where Next.js prints after awaiting the hook (NextServer.instrumentationOnRequestError), the print is redacted", async () => {
    const onRequestError = await hook();
    const NextServer = (require_("next/dist/server/next-server") as { default: { prototype: object } }).default;
    const BaseServer = (require_("next/dist/server/base-server") as { default: { prototype: { logError(err: unknown): void } } }).default;
    // The fields this method reads: the loaded instrumentation module, the dev flag, the logger.
    const server = Object.assign(Object.create(NextServer.prototype), {
      instrumentation: { onRequestError },
      renderOpts: { dev: false },
      quiet: false,
      logError: BaseServer.prototype.logError,
    }) as { instrumentationOnRequestError(...a: unknown[]): Promise<void> };
    const err = new Error("render failed", { cause: new DrizzleQueryError(browse, [`%${search}%`, 24], timeout()) });
    await server.instrumentationOnRequestError(err, { url: "/explore", method: "GET", headers: {} }, renderCtx);
    expect(hookRan()).toBe(true);
    expect(printed.length).toBeGreaterThanOrEqual(2);
    expect(printed.join("\n")).not.toContain(search);
    expect(printed.join("\n")).toContain("params: [redacted]");
  });

  it("holds: a Drizzle error four causes deep (the deepest the scrub reaches) prints redacted", async () => {
    const onRequestError = await hook();
    let err: Error = new DrizzleQueryError(browse, [`%${search}%`, 24], timeout());
    for (let i = 0; i < 4; i++) err = new Error(`layer ${i}`, { cause: err });
    await onRequestError(err, explore, renderCtx);
    expect(format(err)).toContain("params: [redacted]");
    expect(format(err)).not.toContain(search);
  });

  // Was a hole (very low, theoretical): scrubQueryParams stopped after five errors of a cause chain, on
  // the assumption that nothing prints deeper. Native util.inspect indeed stops after three causes, but
  // the production server replaces Error's inspect (next/dist/server/patch-error-inspect.js:363-391,
  // loaded by next-server.js:12 through node-environment.js) with one that recomputes the depth at
  // every level and prints causes at any depth. The scrub now walks the whole chain.
  it("holds: a Drizzle error five or more causes deep is scrubbed before Next.js's production inspect prints it", async () => {
    const onRequestError = await hook();
    for (const layers of [5, 12]) {
      let err: Error = new DrizzleQueryError(browse, [`%${search}%`, 24], timeout());
      for (let i = 0; i < layers; i++) err = new Error(`layer ${i}`, { cause: err });
      await onRequestError(err, explore, renderCtx);
      expect(format(err)).toContain("params: [redacted]");
      expect(format(err)).not.toContain(search);
    }
    // A chain that loops back on itself ends the walk instead of hanging it.
    const looped = new Error("outer", { cause: new DrizzleQueryError(browse, [`%${search}%`, 24], timeout()) });
    (looped.cause as Error).cause = looped;
    scrubQueryParams(looped);
    expect((looped.cause as Error).message).toBe(`Failed query: ${browse}\nparams: [redacted]`);
  });

  it("holds: reporting the same error object twice, concurrently (RSC and render handlers), stays redacted without double-redacting", async () => {
    const onRequestError = await hook();
    const err = new DrizzleQueryError(browse, [`%${search}%`, 24], timeout());
    await Promise.all([onRequestError(err, explore, renderCtx), onRequestError(err, explore, renderCtx)]);
    expect(err.message).toBe(`Failed query: ${browse}\nparams: [redacted]`);
    expect((err as unknown as { params: unknown }).params).toBe("[redacted]");
    expect(printed.join("\n") + format(err)).not.toContain(search);
  });

  it("holds: with Next.js's production prepareStackTrace in place, log lines and webhook events still redact every parameter and keep frames", async () => {
    const { fetch, calls } = fakeFetch();
    setErrorSink(createErrorWebhook({ url: URL_, source: "web", fetch }));
    // Created after the patch, so its stack comes from Next's prepareUnsourcemappedStackTrace.
    const err = new DrizzleQueryError(QUERY, ["two adults\n    at Object.<anonymous> (/app/x.js:1:1)\nSECRET_PATCHED_STACK", "TAIL"], timeout());
    logger.error("unhandled route error", { path: "/api/generations", err });
    await flush();
    expect(printed.join("\n")).not.toContain("SECRET_PATCHED_STACK");
    expect(calls[0]!.body).not.toContain("SECRET_PATCHED_STACK");
    expect(JSON.parse(calls[0]!.body).error.stack).toMatch(/params: \[redacted\]\n\s+at /);
  });

  describe("with the database", () => {
    beforeAll(async () => {
      await resetDb();
    });

    // HOLE (low): scrubQueryParams redacts the message, stack and `params` of each error in the chain,
    // but the driver's PostgresError (the cause) keeps its own enumerable fields, and Postgres puts the
    // offending values in `detail`: "Failing row contains (..., <prompt>, ...)" for a check or not-null
    // violation, "Key (lower(email))=(...) already exists." for a unique violation. Next.js prints the
    // cause with those fields. Every print the fix does cover (the NextServer path, base-server.js:1574
    // for an error rethrown from a page) therefore still shows the bound values. No page render that
    // writes a private column was found today (the template page's discovery_events insert binds ids);
    // API routes go through route(), whose log line keeps only the cause's name and message.
    test.fails("HOLE: after the scrub, a check violation still prints the prompt through the cause's detail", async () => {
      const onRequestError = await hook();
      const user = await makeUser();
      const prompt = "two adults at a masquerade ball SECRET_FAILING_ROW";
      let err: unknown;
      try {
        await getDb()
          .insert(generationJobs)
          .values({ userId: user.id, idempotencyKey: "attack-1", mode: "text_to_image", modelKey: "m", providerKey: "demo", isDemo: true, prompt, params: {}, costCredits: -1 } as typeof generationJobs.$inferInsert);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(DrizzleQueryError);
      await onRequestError(err, { path: "/templates/x", method: "GET", headers: {} }, { ...renderCtx, routePath: "/templates/[id]" });
      // The fix did its part: the message is redacted.
      expect((err as Error).message).toMatch(/params: \[redacted\]$/);
      expect(format(err)).not.toContain("SECRET_FAILING_ROW");
    });

    test.fails("HOLE: after the scrub, a unique violation still prints the email through the cause's detail", async () => {
      const user = await makeUser();
      let err: unknown;
      try {
        await getDb()
          .insert(users)
          .values({ email: user.email.toUpperCase(), passwordHash: "x", dateOfBirth: "1990-01-01", ageAssuranceMethod: "self_declaration", ageAssuredAt: new Date() });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(DrizzleQueryError);
      scrubQueryParams(err);
      expect((err as Error).message).toMatch(/params: \[redacted\]$/);
      expect(format(err).toLowerCase()).not.toContain(user.email.toLowerCase());
    });
  });
});
