/*
 * Hushloom service worker (addendum §4). Hand-written, no build step, no workbox.
 *
 * - Precaches the app shell: the manifest, the icons and the /offline page. The offline page is
 *   fetched without cookies, so it renders the signed-out shell and can hold nothing private.
 * - Cache-first for /_next/static/ (content-hashed, immutable) and /icons/.
 * - Network-first for navigations to public pages, falling back to /offline when the network is
 *   gone. Page HTML is never stored: it carries the signed-in shell (name, credits).
 * - Never answers /api/ (media included), signed-in pages, other origins, ranges or non-GET
 *   requests: the browser fetches those exactly as if there were no service worker.
 * - Shows opt-in push notifications. Payloads carry a neutral line and a link, never content.
 *
 * The rules are the small pure functions at the top (routeFor, shouldCache, notificationFrom).
 * tests/unit/sw-rules.test.ts loads this file in a sandbox and exercises them.
 * Ship a new worker by bumping VERSION; old caches are dropped when it activates.
 */

const VERSION = "v1";
const SHELL_CACHE = `hushloom-shell-${VERSION}`;
const STATIC_CACHE = `hushloom-static-${VERSION}`;
const STATIC_LIMIT = 250;
const OFFLINE_URL = "/offline";
const SHELL_URLS = [
  "/manifest.webmanifest",
  "/icons/mark.svg",
  "/icons/icon-32.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
  "/icons/badge-96.png",
];

/** Signed-in pages (and money or identity flows): navigations go straight to the network, never to a cache. */
const PRIVATE_PREFIXES = ["/collection", "/projects", "/studio", "/train", "/settings", "/admin", "/favorites", "/pricing", "/auth", "/verify"];

function isPrivatePath(pathname) {
  return PRIVATE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function isStaticAsset(pathname) {
  return pathname.startsWith("/_next/static/") || pathname.startsWith("/icons/");
}

/**
 * The strategy for a request: "cache-first", "network-first" (with the cached copy, or /offline for a
 * page, when the network fails) or "network-only" (the worker does not answer at all).
 */
function routeFor(request, origin = self.location.origin) {
  const url = new URL(request.url, origin);
  if (request.method !== "GET") return "network-only";
  if (url.origin !== origin) return "network-only";
  if (url.pathname.startsWith("/api/")) return "network-only";
  if (request.headers && typeof request.headers.get === "function" && request.headers.get("range")) return "network-only";
  if (isStaticAsset(url.pathname)) return "cache-first";
  if (request.mode === "navigate") return isPrivatePath(url.pathname) ? "network-only" : "network-first";
  if (SHELL_URLS.includes(url.pathname)) return "network-first";
  return "network-only";
}

/** Whether a fetched response may be stored. Only public static files and the shell qualify. */
function shouldCache(url, response) {
  const { pathname } = new URL(url, "https://hushloom.invalid");
  if (!response || response.status !== 200 || response.type === "opaque" || response.type === "opaqueredirect" || response.redirected) return false;
  if (pathname.startsWith("/api/")) return false;
  const cacheControl = (response.headers.get("cache-control") || "").toLowerCase();
  if (/(^|[\s,])(private|no-store)(?=$|[\s,=])/.test(cacheControl)) return false;
  return isStaticAsset(pathname) || SHELL_URLS.includes(pathname);
}

/** The /_next/static/ files a page references (its CSS and scripts), so the offline page renders styled. */
function staticAssetsIn(html) {
  const found = new Set();
  for (const match of html.matchAll(/["'(](\/_next\/static\/[^"'()\s?#]+)/g)) found.add(match[1]);
  return [...found];
}

/** Keeps only the fields a Hushloom push may carry, with a same-origin link. */
function notificationFrom(data) {
  const fallback = { title: "Hushloom", body: "Something you made has an update.", url: "/collection", tag: "hushloom" };
  if (!data || typeof data !== "object") return fallback;
  const url = typeof data.url === "string" && data.url.startsWith("/") && !data.url.startsWith("//") ? data.url : fallback.url;
  return {
    title: typeof data.title === "string" && data.title ? data.title.slice(0, 60) : fallback.title,
    body: typeof data.body === "string" && data.body ? data.body.slice(0, 120) : fallback.body,
    url,
    tag: typeof data.tag === "string" && data.tag ? data.tag.slice(0, 64) : fallback.tag,
  };
}

// ── Caching ──

/** Registered as /sw.js?mode=dev under `next dev`: push only, no caching (dev chunks are not hashed). */
const CACHING = new URL(self.location.href).searchParams.get("mode") !== "dev";

const OFFLINE_FALLBACK_HTML =
  '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline · Hushloom</title>' +
  '<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0f0a0d;color:#f7efe7;font-family:system-ui,sans-serif;text-align:center;padding:24px">' +
  "<div><p style=\"font-family:Georgia,serif;font-style:italic;font-size:22px\">hushloom</p><h1 style=\"font-family:Georgia,serif;font-weight:400\">You're offline</h1>" +
  '<p style="color:#c8b7b1">Nothing is queued; try again when you\'re back.</p><p><a href="" style="color:#ff8a66">Try again</a></p></div></body>';

async function precacheOffline(shell) {
  const res = await fetch(new Request(OFFLINE_URL, { credentials: "omit", cache: "reload" }));
  if (!res.ok) throw new Error(`offline page returned ${res.status}`);
  const html = await res.text();
  // Next marks every server-rendered page no-store. This one copy is stored on purpose: it was fetched
  // without cookies, so it is the same for everyone. Its headers are reduced to the content type.
  await shell.put(OFFLINE_URL, new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }));
  const statics = await caches.open(STATIC_CACHE);
  await Promise.all(
    staticAssetsIn(html).map(async (path) => {
      try {
        const asset = await fetch(new Request(path, { credentials: "omit" }));
        if (shouldCache(path, asset)) await statics.put(path, asset);
      } catch {
        // A missing chunk only costs styling offline.
      }
    }),
  );
}

async function offlineResponse() {
  const cached = await caches.match(OFFLINE_URL);
  return cached || new Response(OFFLINE_FALLBACK_HTML, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function trim(cache, limit) {
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - limit))) await cache.delete(key);
}

async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (shouldCache(request.url, res)) {
    const cache = await caches.open(STATIC_CACHE);
    await cache.put(request, res.clone());
    await trim(cache, STATIC_LIMIT);
  }
  return res;
}

async function networkFirst(request) {
  try {
    const res = await fetch(request);
    if (shouldCache(request.url, res)) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(request, res.clone());
    }
    return res;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (request.mode === "navigate") return offlineResponse();
    throw err;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      if (CACHING) {
        // Best effort: a failed precache must not stop the worker installing (push depends on it);
        // without the cached copy the worker falls back to a plain offline page.
        const shell = await caches.open(SHELL_CACHE);
        await shell.addAll(SHELL_URLS.map((url) => new Request(url, { cache: "reload" }))).catch(() => undefined);
        await precacheOffline(shell).catch(() => undefined);
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, STATIC_CACHE]);
      for (const key of await caches.keys()) {
        if (key.startsWith("hushloom-") && !keep.has(key)) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  if (!CACHING) return;
  const strategy = routeFor(event.request);
  if (strategy === "cache-first") event.respondWith(cacheFirst(event.request));
  else if (strategy === "network-first") event.respondWith(networkFirst(event.request));
  // "network-only": no respondWith, so the browser handles the request as if there were no worker.
});

// ── Push ──

self.addEventListener("push", (event) => {
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch {
    data = null;
  }
  const note = notificationFrom(data);
  event.waitUntil(
    self.registration.showNotification(note.title, {
      body: note.body,
      tag: note.tag,
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      data: { url: note.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(notificationFrom(event.notification.data).url, self.location.origin);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        try {
          await client.focus();
          if (await client.navigate(target.href)) return;
        } catch {
          // An uncontrolled window cannot be navigated from here; open a new one instead.
        }
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});

/** The browser replaced the subscription (key rotation, expiry): subscribe again and tell the server. */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const old = event.oldSubscription;
      if (!old || !old.options) return;
      const fresh = event.newSubscription || (await self.registration.pushManager.subscribe(old.options));
      const send = (method, body) => fetch("/api/push/subscriptions", { method, credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      await send("POST", fresh.toJSON());
      if (old.endpoint !== fresh.endpoint) await send("DELETE", { endpoint: old.endpoint });
    })().catch(() => undefined),
  );
});
