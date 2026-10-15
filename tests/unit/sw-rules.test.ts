import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

/**
 * Loads public/sw.js into a sandbox with a fake `self`, fake Cache Storage and a stubbed fetch, then
 * exercises its rules (routeFor, shouldCache) and its real event handlers.
 */
const ORIGIN = "https://hushloom.test";
const source = readFileSync(path.resolve(__dirname, "../../public/sw.js"), "utf8");

type FakeRequest = { url: string; method?: string; mode?: string; headers?: Headers };
type Strategy = "cache-first" | "network-first" | "network-only";
type Sw = {
  routeFor(request: FakeRequest, origin?: string): Strategy;
  shouldCache(url: string, response: Response): boolean;
  staticAssetsIn(html: string): string[];
  notificationFrom(data: unknown): { title: string; body: string; url: string; tag: string };
};

const keyOf = (input: RequestInfo | URL) => (typeof input === "string" ? new URL(input, ORIGIN).href : input instanceof URL ? input.href : input.url);

class FakeCache {
  entries = new Map<string, Response>();
  async match(input: RequestInfo) {
    return this.entries.get(keyOf(input))?.clone();
  }
  async put(input: RequestInfo, res: Response) {
    this.entries.set(keyOf(input), res);
  }
  async addAll(inputs: RequestInfo[]) {
    for (const input of inputs) this.entries.set(keyOf(input), await (globalFetch as (r: RequestInfo) => Promise<Response>)(input));
  }
  async keys() {
    return [...this.entries.keys()].map((k) => new Request(k));
  }
  async delete(input: RequestInfo) {
    return this.entries.delete(keyOf(input));
  }
}

let globalFetch: unknown;

function load(opts: { search?: string; fetch?: (input: RequestInfo, init?: RequestInit) => Promise<Response> } = {}) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const stores = new Map<string, FakeCache>();
  const caches = {
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new FakeCache());
      return stores.get(name)!;
    },
    async match(input: RequestInfo) {
      for (const store of stores.values()) {
        const hit = await store.match(input);
        if (hit) return hit;
      }
      return undefined;
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name: string) {
      return stores.delete(name);
    },
  };
  const fetch = vi.fn(opts.fetch ?? (async () => new Response("network", { status: 200 })));
  globalFetch = fetch;
  // Relative URLs resolve against the worker's origin, as they do in a browser.
  class SandboxRequest extends Request {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(typeof input === "string" ? new URL(input, ORIGIN) : input, init);
    }
  }
  const self = {
    location: { origin: ORIGIN, href: `${ORIGIN}/sw.js${opts.search ?? ""}` },
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners[type] = fn;
    },
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: vi.fn(async () => undefined) },
  };
  const context = vm.createContext({ self, URL, Response, Headers, Request: SandboxRequest, fetch, caches, console });
  vm.runInContext(source, context, { filename: "sw.js" });
  return { sw: context as unknown as Sw, listeners, stores, fetch, self };
}

/** Dispatches a fetch event; resolves with the worker's response, or null when it lets the browser handle the request. */
async function dispatchFetch(listeners: Record<string, (event: unknown) => void>, request: FakeRequest): Promise<Response | null> {
  let answer: Promise<Response> | null = null;
  listeners.fetch!({ request: { method: "GET", headers: new Headers(), ...request }, respondWith: (p: Promise<Response>) => (answer = p) });
  return answer ? await answer : null;
}

const nav = (pathname: string): FakeRequest => ({ url: `${ORIGIN}${pathname}`, method: "GET", mode: "navigate" });
const sub = (pathname: string, mode = "cors"): FakeRequest => ({ url: `${ORIGIN}${pathname}`, method: "GET", mode });
const ok = (headers: Record<string, string> = {}, status = 200) => new Response("x", { status, headers });

describe("service worker routing", () => {
  const { sw } = load();

  it("never answers /api/*, media included, whatever the request", () => {
    for (const p of ["/api/generations?active=1", "/api/media/abc?sig=x&exp=1", "/api/me", "/api/push/public-key"]) {
      expect(sw.routeFor(sub(p))).toBe("network-only");
      expect(sw.routeFor(nav(p))).toBe("network-only");
    }
  });

  it("sends navigations to signed-in pages straight to the network", () => {
    for (const p of ["/collection", "/collection/7b0c2f5e-1111-4222-8333-944445555666", "/projects/x", "/studio", "/train", "/settings", "/admin", "/favorites", "/pricing", "/auth?next=/settings", "/verify/sandbox"]) {
      expect(sw.routeFor(nav(p)), p).toBe("network-only");
    }
  });

  it("serves content-hashed static files and icons cache-first", () => {
    expect(sw.routeFor(sub("/_next/static/chunks/app/page-0a1b2c.js", "no-cors"))).toBe("cache-first");
    expect(sw.routeFor(sub("/_next/static/css/2f3e.css", "no-cors"))).toBe("cache-first");
    expect(sw.routeFor(sub("/_next/static/media/fraunces.8a7b.woff2"))).toBe("cache-first");
    expect(sw.routeFor(sub("/icons/icon-192.png", "no-cors"))).toBe("cache-first");
  });

  it("tries the network first for public pages (and falls back to /offline, below)", () => {
    for (const p of ["/", "/explore", "/explore?q=lace", "/templates/velvet-hour", "/creators/mara", "/policies", "/generate/image", "/offline"]) {
      expect(sw.routeFor(nav(p)), p).toBe("network-first");
    }
  });

  it("leaves everything else to the browser: other origins, writes, ranges, page data fetches", () => {
    expect(sw.routeFor({ url: "https://cdn.example.com/_next/static/x.js", method: "GET", mode: "no-cors" })).toBe("network-only");
    expect(sw.routeFor({ url: `${ORIGIN}/_next/static/x.js`, method: "POST", mode: "cors" })).toBe("network-only");
    expect(sw.routeFor({ url: `${ORIGIN}/icons/icon-512.png`, method: "GET", mode: "no-cors", headers: new Headers({ range: "bytes=0-" }) })).toBe("network-only");
    expect(sw.routeFor(sub("/collection?_rsc=1a2b"))).toBe("network-only");
    expect(sw.routeFor(sub("/explore?_rsc=1a2b"))).toBe("network-only");
    expect(sw.routeFor(sub("/_next/image?url=x&w=640"))).toBe("network-only");
  });
});

describe("service worker storage rules", () => {
  const { sw } = load();

  it("never stores /api responses, even ones marked public", () => {
    expect(sw.shouldCache(`${ORIGIN}/api/media/abc`, ok({ "cache-control": "public, max-age=31536000, immutable", "content-type": "image/webp" }))).toBe(false);
    expect(sw.shouldCache("/api/templates", ok({ "cache-control": "public, max-age=60" }))).toBe(false);
  });

  it("never stores a response marked private or no-store", () => {
    expect(sw.shouldCache("/_next/static/chunks/a.js", ok({ "cache-control": "private, max-age=600" }))).toBe(false);
    expect(sw.shouldCache("/_next/static/chunks/a.js", ok({ "cache-control": "no-store" }))).toBe(false);
    expect(sw.shouldCache("/icons/icon-192.png", ok({ "Cache-Control": "public, No-Store" }))).toBe(false);
  });

  it("stores public static files and the shell, nothing else", () => {
    expect(sw.shouldCache("/_next/static/chunks/a.js", ok({ "cache-control": "public, max-age=31536000, immutable" }))).toBe(true);
    expect(sw.shouldCache("/icons/icon-192.png", ok({ "cache-control": "public, max-age=0" }))).toBe(true);
    expect(sw.shouldCache("/manifest.webmanifest", ok({ "cache-control": "public, max-age=0" }))).toBe(true);
    // Page HTML carries the signed-in shell; it is never stored, even without cache headers.
    expect(sw.shouldCache("/explore", ok({ "content-type": "text/html" }))).toBe(false);
    expect(sw.shouldCache("/", ok())).toBe(false);
    expect(sw.shouldCache("/collection", ok())).toBe(false);
  });

  it("never stores partial or failed responses", () => {
    expect(sw.shouldCache("/_next/static/chunks/a.js", ok({}, 206))).toBe(false);
    expect(sw.shouldCache("/_next/static/chunks/a.js", ok({}, 404))).toBe(false);
    expect(sw.shouldCache("/_next/static/chunks/a.js", ok({}, 500))).toBe(false);
  });

  it("finds the offline page's CSS and scripts", () => {
    const html = '<link rel="stylesheet" href="/_next/static/css/a1.css"><script src="/_next/static/chunks/main-9f.js" async></script><img src="/api/media/x">';
    expect(sw.staticAssetsIn(html).sort()).toEqual(["/_next/static/chunks/main-9f.js", "/_next/static/css/a1.css"]);
  });
});

describe("service worker behavior", () => {
  it("falls back to /offline when a public page cannot be reached, and stores no page", async () => {
    const offline = new Response("<h1>You're offline</h1>", { headers: { "content-type": "text/html" } });
    const { listeners, stores } = load({ fetch: async () => Promise.reject(new TypeError("Failed to fetch")) });
    stores.set("hushloom-shell-v1", new FakeCache());
    await stores.get("hushloom-shell-v1")!.put("/offline", offline);
    const res = await dispatchFetch(listeners, nav("/explore"));
    expect(res).not.toBeNull();
    expect(await res!.text()).toContain("You're offline");
  });

  it("answers with a plain offline page when even the cached copy is missing", async () => {
    const { listeners } = load({ fetch: async () => Promise.reject(new TypeError("Failed to fetch")) });
    const res = await dispatchFetch(listeners, nav("/templates/velvet-hour"));
    expect(res!.status).toBe(503);
    expect(await res!.text()).toContain("Nothing is queued");
  });

  it("passes an online public page through without storing it", async () => {
    const { listeners, stores, fetch } = load({ fetch: async () => new Response("<main>Explore</main>", { headers: { "cache-control": "private, no-cache, no-store" } }) });
    const res = await dispatchFetch(listeners, nav("/explore"));
    expect(await res!.text()).toBe("<main>Explore</main>");
    expect(fetch).toHaveBeenCalledTimes(1);
    for (const store of stores.values()) expect(store.entries.size).toBe(0);
  });

  it("does not answer signed-in pages or API calls at all, even offline", async () => {
    const { listeners, fetch } = load({ fetch: async () => Promise.reject(new TypeError("Failed to fetch")) });
    expect(await dispatchFetch(listeners, nav("/collection"))).toBeNull();
    expect(await dispatchFetch(listeners, nav("/settings"))).toBeNull();
    expect(await dispatchFetch(listeners, sub("/api/media/abc"))).toBeNull();
    expect(await dispatchFetch(listeners, sub("/api/generations?active=1"))).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("serves static files from the cache once fetched", async () => {
    const { listeners, fetch } = load({ fetch: async () => new Response("js", { headers: { "cache-control": "public, max-age=31536000, immutable" } }) });
    expect(await (await dispatchFetch(listeners, sub("/_next/static/chunks/a.js", "no-cors")))!.text()).toBe("js");
    expect(await (await dispatchFetch(listeners, sub("/_next/static/chunks/a.js", "no-cors")))!.text()).toBe("js");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("precaches the offline page without cookies, stripped of headers, with its CSS and scripts", async () => {
    const offlineHtml = '<html><head><link rel="stylesheet" href="/_next/static/css/a1.css"></head><body><script src="/_next/static/chunks/main.js"></script>You\'re offline</body></html>';
    const { listeners, stores, fetch, self } = load({
      fetch: async (input) => {
        const url = keyOf(input);
        if (url.endsWith("/offline")) return new Response(offlineHtml, { headers: { "content-type": "text/html", "cache-control": "private, no-cache, no-store, max-age=0, must-revalidate" } });
        return new Response("asset", { headers: { "cache-control": "public, max-age=31536000, immutable" } });
      },
    });
    let installing: Promise<unknown> | null = null;
    listeners.install!({ waitUntil: (p: Promise<unknown>) => (installing = p) });
    await installing;
    const offlineCall = fetch.mock.calls.find(([input]) => keyOf(input).endsWith("/offline"));
    expect((offlineCall![0] as Request).credentials).toBe("omit");
    const shell = stores.get("hushloom-shell-v1")!;
    const cached = await shell.match("/offline");
    expect(await cached!.text()).toContain("You're offline");
    expect([...cached!.headers.keys()]).toEqual(["content-type"]);
    expect(await shell.match("/manifest.webmanifest")).toBeTruthy();
    expect(await shell.match("/icons/icon-512.png")).toBeTruthy();
    const statics = stores.get("hushloom-static-v1")!;
    expect(await statics.match("/_next/static/css/a1.css")).toBeTruthy();
    expect(await statics.match("/_next/static/chunks/main.js")).toBeTruthy();
    expect(self.skipWaiting).toHaveBeenCalled();
  });

  it("takes control on activate and drops caches from older versions", async () => {
    const { listeners, stores, self } = load();
    stores.set("hushloom-static-v0", new FakeCache());
    stores.set("hushloom-shell-v1", new FakeCache());
    stores.set("someone-elses-cache", new FakeCache());
    let activating: Promise<unknown> | null = null;
    listeners.activate!({ waitUntil: (p: Promise<unknown>) => (activating = p) });
    await activating;
    expect([...stores.keys()].sort()).toEqual(["hushloom-shell-v1", "someone-elses-cache"]);
    expect(self.clients.claim).toHaveBeenCalled();
  });

  it("under next dev (?mode=dev) it caches and answers nothing, so dev code is never served stale", async () => {
    const { listeners, fetch, stores, self } = load({ search: "?mode=dev" });
    let installing: Promise<unknown> | null = null;
    listeners.install!({ waitUntil: (p: Promise<unknown>) => (installing = p) });
    await installing;
    expect(stores.size).toBe(0);
    expect(self.skipWaiting).toHaveBeenCalled();
    expect(await dispatchFetch(listeners, sub("/_next/static/chunks/a.js", "no-cors"))).toBeNull();
    expect(await dispatchFetch(listeners, nav("/explore"))).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("still installs when precaching fails, so push keeps working", async () => {
    const { listeners, self } = load({ fetch: async () => Promise.reject(new TypeError("Failed to fetch")) });
    let installing: Promise<unknown> | null = null;
    listeners.install!({ waitUntil: (p: Promise<unknown>) => (installing = p) });
    await expect(installing).resolves.toBeUndefined();
    expect(self.skipWaiting).toHaveBeenCalled();
  });
});

describe("service worker notifications", () => {
  const { sw } = load();
  const id = "7b0c2f5e-1111-4222-8333-944445555666";

  it("shows only the allowed fields and only same-origin links", () => {
    expect(sw.notificationFrom({ title: "Hushloom", body: "Your creation is ready", url: `/collection/${id}`, tag: `job-${id}`, prompt: "secret", image: "/api/media/x" })).toEqual({
      title: "Hushloom",
      body: "Your creation is ready",
      url: `/collection/${id}`,
      tag: `job-${id}`,
    });
    expect(sw.notificationFrom({ title: "x", body: "y", url: "https://evil.example/phish" }).url).toBe("/collection");
    expect(sw.notificationFrom({ title: "x", body: "y", url: "//evil.example/phish" }).url).toBe("/collection");
    expect(sw.notificationFrom(null).title).toBe("Hushloom");
  });
});
