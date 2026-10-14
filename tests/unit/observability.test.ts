import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger, setErrorSink } from "@/server/log";
import { createErrorWebhook, installErrorWebhook, toErrorEvent } from "@/server/observability";

const URL_ = "https://monitor.example.test/hooks/hushloom";
const PROMPT = "two adults sharing a candlelit toast in a velvet booth";

type Call = { url: string; init: RequestInit; event: Record<string, unknown> };

/** A fetch that records each call and answers with `respond` (default: 202). */
function fakeFetch(respond: (call: Call) => Promise<Response> = async () => new Response(null, { status: 202 })) {
  const calls: Call[] = [];
  const fn = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {}, event: JSON.parse(String(init?.body)) as Record<string, unknown> };
    calls.push(call);
    return respond(call);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let stderr: string[];
beforeEach(() => {
  stderr = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => void stderr.push(String(line)));
});
afterEach(() => {
  setErrorSink(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("error webhook", () => {
  it("posts one JSON event per error with the message, stack, route and time", async () => {
    const { fetch, calls } = fakeFetch();
    setErrorSink(createErrorWebhook({ url: URL_, source: "web", fetch, now: () => Date.parse("2026-10-14T01:00:00Z") }));
    const err = new Error("connection refused");
    logger.error("unhandled route error", { path: "/api/generations", err });
    await flush();

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe(URL_);
    expect(call!.init.method).toBe("POST");
    expect(new Headers(call!.init.headers).get("content-type")).toBe("application/json");
    expect(call!.init.signal).toBeInstanceOf(AbortSignal);
    expect(call!.event).toEqual({
      source: "web",
      time: "2026-10-14T01:00:00.000Z",
      message: "unhandled route error",
      error: { name: "Error", message: "connection refused", stack: err.stack },
      path: "/api/generations",
    });
    // stdout keeps its JSON line as before.
    expect(JSON.parse(stderr[0]!)).toMatchObject({ level: "error", msg: "unhandled route error", path: "/api/generations" });
  });

  it("never sends request bodies, query strings, headers, prompts or unknown log fields", async () => {
    const { fetch, calls } = fakeFetch();
    setErrorSink(createErrorWebhook({ url: URL_, source: "web", fetch }));
    logger.error("request error", {
      err: new Error("render failed"),
      path: "/api/media?k=outputs/u/x.webp&e=1&s=SIGNATURE#frag",
      route: "/api/webhooks/payments/[provider]?token=WEBHOOKTOKEN",
      method: "POST",
      body: { prompt: PROMPT },
      prompt: PROMPT,
      headers: { cookie: "hl_session=SESSIONTOKEN" },
      jobId: "job-1",
      provider: "ccbill",
    });
    await flush();

    const sent = String(calls[0]!.init.body);
    for (const secret of ["SIGNATURE", "WEBHOOKTOKEN", "SESSIONTOKEN", PROMPT, "k=", "frag"]) expect(sent).not.toContain(secret);
    expect(calls[0]!.event).toMatchObject({
      path: "/api/media",
      route: "/api/webhooks/payments/[provider]",
      method: "POST",
      context: { jobId: "job-1", provider: "ccbill" },
    });
    expect(Object.keys(calls[0]!.event).sort()).toEqual(["context", "error", "message", "method", "path", "route", "source", "time"]);
  });

  it("redacts Drizzle query parameters in the event and in the stdout line", async () => {
    const { fetch, calls } = fakeFetch();
    setErrorSink(createErrorWebhook({ url: URL_, source: "worker", fetch }));
    const err = new Error(`Failed query: insert into "generation_jobs" ("prompt") values ($1)\nparams: ${PROMPT}`);
    logger.error("queue job crashed", { jobId: "job-2", err });
    await flush();

    expect(String(calls[0]!.init.body)).not.toContain(PROMPT);
    expect(stderr.join("\n")).not.toContain(PROMPT);
    const sentError = calls[0]!.event.error as { message: string; stack: string };
    expect(sentError.message).toBe(`Failed query: insert into "generation_jobs" ("prompt") values ($1)\nparams: [redacted]`);
    expect(sentError.stack).toContain("params: [redacted]");
    expect(sentError.stack).toMatch(/\n\s+at /);
  });

  it("returns at once and survives a monitor that hangs, rejects, answers 500 or throws", async () => {
    const hanging = fakeFetch((call) => new Promise((_, reject) => call.init.signal?.addEventListener("abort", () => reject(call.init.signal?.reason))));
    setErrorSink(createErrorWebhook({ url: URL_, source: "web", fetch: hanging.fetch, timeoutMs: 20 }));
    logger.error("slow monitor", { err: new Error("x") });
    // logger.error has returned while the request is still open; the timeout then aborts it.
    expect(hanging.calls[0]!.init.signal?.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(hanging.calls[0]!.init.signal?.aborted).toBe(true);

    for (const respond of [
      async () => Promise.reject(new TypeError("fetch failed")),
      async () => new Response("nope", { status: 500 }),
    ]) {
      const f = fakeFetch(respond);
      setErrorSink(createErrorWebhook({ url: URL_, source: "web", fetch: f.fetch }));
      expect(() => logger.error("monitor down", { err: new Error("y") })).not.toThrow();
      await flush();
      // A failed delivery is a warning, not an error, so it never feeds back into the webhook.
      expect(f.calls).toHaveLength(1);
    }

    const throwing = vi.fn(() => {
      throw new TypeError("bad url");
    });
    setErrorSink(createErrorWebhook({ url: URL_, source: "web", fetch: throwing as unknown as typeof fetch }));
    expect(() => logger.error("monitor misconfigured", { err: new Error("z") })).not.toThrow();
    expect(throwing).toHaveBeenCalledTimes(1);
  });

  it("caps deliveries per minute so an error storm cannot pile up requests", async () => {
    let t = Date.parse("2026-10-14T01:00:00Z");
    const { fetch, calls } = fakeFetch();
    setErrorSink(createErrorWebhook({ url: URL_, source: "web", fetch, maxPerMinute: 2, now: () => t }));
    for (let i = 0; i < 5; i++) logger.error("storm", { err: new Error(`e${i}`) });
    expect(calls).toHaveLength(2);
    t += 60_000;
    logger.error("after the storm", { err: new Error("later") });
    expect(calls).toHaveLength(3);
    expect(calls[2]!.event.message).toBe("after the storm");
  });

  it("accepts a plain string error and clips oversized fields", () => {
    const event = toErrorEvent("x".repeat(500), { err: "queue unreachable", jobId: "j".repeat(500) }, "worker", new Date(0));
    expect(event.error).toEqual({ name: "Error", message: "queue unreachable" });
    expect(event.message.length).toBeLessThanOrEqual(201);
    expect(String(event.context?.jobId).length).toBeLessThanOrEqual(201);
  });
});

describe("installErrorWebhook", () => {
  async function fresh(url: string | undefined) {
    vi.resetModules();
    vi.stubEnv("ERROR_WEBHOOK_URL", url);
    return import("@/server/observability");
  }

  it("installs nothing without ERROR_WEBHOOK_URL, so errors stay on stdout only", async () => {
    const mod = await fresh(undefined);
    const spy = vi.spyOn(globalThis, "fetch");
    expect(mod.installErrorWebhook("web")).toBe(false);
    logger.error("no monitor", { err: new Error("x") });
    await flush();
    expect(spy).not.toHaveBeenCalled();
  });

  it("installs the webhook when ERROR_WEBHOOK_URL is set, and shares it with every module copy", async () => {
    const mod = await fresh(URL_);
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));
    expect(mod.installErrorWebhook("worker")).toBe(true);
    // `logger` was loaded before the module reset, so it is a separate copy of src/server/log.ts, as the
    // route handlers' copy is separate from instrumentation's in a Next.js build. It reaches the same sink.
    logger.error("from another bundle", { err: new Error("x") });
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBe(URL_);
    expect(JSON.parse(String(spy.mock.calls[0]![1]?.body))).toMatchObject({ source: "worker", message: "from another bundle" });
  });

  it("installs nothing when the configuration does not parse", async () => {
    const mod = await fresh("not a url");
    expect(mod.installErrorWebhook("web")).toBe(false);
  });

  it("is a no-op for the statically imported copy too when unset", () => {
    expect(installErrorWebhook("web")).toBe(false);
  });
});

describe("instrumentation", () => {
  it("reports errors Next.js catches, with the path but never its query string", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const { fetch, calls } = fakeFetch();
    setErrorSink(createErrorWebhook({ url: URL_, source: "web", fetch }));
    const { onRequestError } = await import("@/instrumentation");
    const err = Object.assign(new Error("render failed"), { digest: "123456" });
    await onRequestError(
      err,
      { path: "/collection/abc?share=TOKEN", method: "GET", headers: { cookie: "hl_session=SESSIONTOKEN" } },
      { routerKind: "App Router", routePath: "/collection/[id]", routeType: "render", revalidateReason: undefined },
    );
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.event).toMatchObject({
      message: "request error",
      path: "/collection/abc",
      route: "/collection/[id]",
      method: "GET",
      error: { name: "Error", message: "render failed", digest: "123456" },
      context: { routeType: "render" },
    });
    const sent = String(calls[0]!.init.body);
    expect(sent).not.toContain("TOKEN");
    expect(stderr.join("\n")).not.toContain("share=TOKEN");
  });

  it("does nothing in the Edge runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    const { fetch, calls } = fakeFetch();
    setErrorSink(createErrorWebhook({ url: URL_, source: "web", fetch }));
    const { onRequestError } = await import("@/instrumentation");
    await onRequestError(new Error("x"), { path: "/", method: "GET", headers: {} }, { routerKind: "App Router", routePath: "/", routeType: "middleware", revalidateReason: undefined });
    expect(calls).toHaveLength(0);
    expect(stderr).toHaveLength(0);
  });
});
