import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Attack tests for the R05 fix (rate limits keyed on a trusted-proxy client IP and the normalized login
// email). Tests that pass are regression tests: the fix holds against that attempt. Tests marked
// it.fails document a hole that is still open; each says which one.

// Route handlers read the session cookie through next/headers; the tests stand in for the request scope.
const requestScope = vi.hoisted(() => ({ token: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "hl_session" && requestScope.token ? { name, value: requestScope.token } : undefined),
    set: () => undefined,
    delete: () => undefined,
  }),
  headers: async () => new Headers(),
}));

import { POST as loginRoute } from "@/app/api/auth/login/route";
import { POST as signupRoute } from "@/app/api/auth/signup/route";
import { DELETE as meDelete } from "@/app/api/me/route";
import { POST as takedownRoute } from "@/app/api/takedowns/route";
import { registerUser } from "@/server/auth/account";
import { createSession } from "@/server/auth/session";
import { closeDb } from "@/server/db";
import { closeRedis, requestRedis } from "@/server/redis";
import { resetDb } from "../helpers";

type Handler = (req: NextRequest, ctx: never) => Promise<Response>;

function call(handler: Handler, method: string, url: string, body?: unknown, headers: HeadersInit = {}) {
  const h = new Headers(headers);
  if (body !== undefined) h.set("content-type", "application/json");
  const init = body === undefined ? { method, headers: h } : { method, body: JSON.stringify(body), headers: h };
  return handler(new NextRequest(`http://localhost${url}`, init), undefined as never);
}

const PASSWORD = "correct horse battery staple";

async function member(email: string, handle: string) {
  return registerUser({ email, password: PASSWORD, handle, displayName: handle, dateOfBirth: "1990-01-01", acceptTerms: true, confirmAdult: true });
}

/** What one appending reverse proxy (TRUSTED_PROXY_HOPS 0 or 1, the default) forwards: the client's copy, then the address it saw. */
const viaProxy = (seen: string, clientSent?: string) => ({ "x-forwarded-for": clientSent === undefined ? seen : `${clientSent}, ${seen}` });

const login = (email: string, password: string, headers: HeadersInit) => call(loginRoute, "POST", "/api/auth/login", { email, password }, headers);

beforeEach(async () => {
  await resetDb();
  requestScope.token = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("R05 attack: the per-account sign-in limit", () => {
  it("every spelling that reaches the account (Unicode spaces, BOM, line separators, Kelvin sign, case) counts against one bucket", async () => {
    await member("kim@example.test", "kim");
    // U+212A KELVIN SIGN lowercases to an ASCII "k", so this spelling signs in to kim@example.test.
    expect((await login("Kim@example.test", PASSWORD, viaProxy("203.0.113.50"))).status).toBe(200);
    const variants = [
      " KIM@example.test ",
      "﻿kim@EXAMPLE.TEST",
      " Kim@example.test　",
      "kim@example.test  ",
      " kIm@Example.Test ",
      "\u000Bkim@example.test\u000C",
      "KIM@example.test",
      "  \t\r\nkim@example.test\r\n",
      "KIM@EXAMPLE.TEST",
    ];
    // A different address for each attempt, so only the per-account bucket can stop them.
    const statuses: number[] = [];
    for (const [i, email] of variants.entries()) statuses.push((await login(email, "wrong-guess-123", viaProxy(`203.0.113.${60 + i}`))).status);
    statuses.push((await login("kim@example.test", PASSWORD, viaProxy("203.0.113.99"))).status);
    expect(statuses).toEqual([...Array(9).fill(401), 429]);
  }, 60_000);

  it("spellings that escape the normalization never reach the account, so the fresh buckets they open are worthless", async () => {
    await member("kim@example.test", "kim");
    const escapes = [
      "​kim@example.test", // zero-width space: not White_Space, so trim() keeps it
      "kim@example.test‍", // zero-width joiner
      "k­im@example.test", // soft hyphen
      "kİm@example.test", // dotted capital I lowercases to "i" + U+0307 in JS
      "ｋｉｍ@example.test", // fullwidth letters
      "kim@example.test.", // trailing dot
      "kim@example.test\uD800", // lone surrogate, sent to Postgres as U+FFFD
      "kim@example.test\u0000", // NUL, which Postgres refuses (422 since R43)
    ];
    const outcomes: Record<string, number> = {};
    for (const [i, email] of escapes.entries()) outcomes[JSON.stringify(email)] = (await login(email, PASSWORD, viaProxy(`198.51.100.${i + 1}`))).status;
    expect(Object.values(outcomes).every((s) => s === 401 || s === 422)).toBe(true);
    expect(outcomes[JSON.stringify("kim@example.test\u0000")]).toBe(422);
  }, 60_000);

  it("concurrent guesses cannot get more than ten past the per-account limit", async () => {
    await member("kim@example.test", "kim");
    const statuses = await Promise.all(Array.from({ length: 25 }, (_, i) => login(i % 2 ? "KIM@example.test " : " kim@example.test", "wrong-guess-123", viaProxy(`192.0.2.${i + 1}`)).then((r) => r.status)));
    expect(statuses.filter((s) => s === 401).length).toBe(10);
    expect(statuses.filter((s) => s === 429).length).toBe(15);
  }, 60_000);

  // HOLE (acknowledged residual (c) in the R05 report, still open): the per-account bucket counts anyone's
  // attempts, so ten bad guesses from anywhere lock the owner out of their own account for 15 minutes, and
  // repeating that every 15 minutes keeps them out indefinitely. Needs a product decision (CAPTCHA,
  // progressive delay, or a per-(email, IP) bucket).
  it.fails("ten wrong guesses by someone else do not lock the owner out of their own account", async () => {
    await member("kim@example.test", "kim");
    for (let i = 0; i < 10; i++) await login("kim@example.test", "wrong-guess-123", viaProxy(`192.0.2.${i + 1}`));
    const owner = await login("kim@example.test", PASSWORD, viaProxy("203.0.113.200"));
    expect(owner.status).toBe(200);
  }, 60_000);
});

describe("R05 attack: the per-IP limits behind one appending proxy", () => {
  it("odd shapes of the client's own X-Forwarded-For never move the key off the address the proxy saw", async () => {
    const seen = "203.0.113.20";
    const forged: HeadersInit[] = [
      viaProxy(seen, "1.1.1.1,"), // trailing comma: an empty entry before the proxy's
      viaProxy(seen, ", , ,"),
      viaProxy(seen, Array.from({ length: 200 }, (_, i) => `10.0.${i}.1`).join(",")),
      viaProxy(seen, " 6.6.6.6 ;  7.7.7.7 "),
      viaProxy(seen, "[2001:db8::1]:443, unknown, _hidden"),
      viaProxy(seen, `${"9".repeat(500)}`),
      // Two header lines: the client's own, then the one the proxy added. They join as "6.6.6.6, <seen>".
      [
        ["x-forwarded-for", "6.6.6.6"],
        ["x-forwarded-for", seen],
      ],
      [
        ["x-forwarded-for", "6.6.6.7, 6.6.6.8"],
        ["x-forwarded-for", seen],
      ],
      viaProxy(seen, "\t8.8.8.8\t"),
      viaProxy(seen, "203.0.113.20 , 203.0.113.21"),
    ];
    const statuses: number[] = [];
    for (const headers of forged) statuses.push((await call(signupRoute, "POST", "/api/auth/signup", {}, headers)).status);
    statuses.push((await call(signupRoute, "POST", "/api/auth/signup", {}, viaProxy(seen, "10.99.99.99"))).status);
    expect(statuses).toEqual([...Array(10).fill(422), 429]);
  });

  it("a garbage session cookie does not swap the signed-out takedown limit for a fresh per-user one", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      requestScope.token = `forged-session-${i}`;
      statuses.push((await call(takedownRoute, "POST", "/api/takedowns", {}, viaProxy("203.0.113.21", `10.7.${i}.1`))).status);
    }
    expect(statuses).toEqual([...Array(10).fill(422), 429]);
  });

  // Was a hole (R05-H1, fixed): clientIp() keyed on the full IPv6 address. One IPv6 subscriber or cloud VM is
  // routed a /64 (2^64 addresses), so it could give every request a new source address and a fresh per-IP
  // bucket, leaving sign-up, signed-out takedowns and the per-IP sign-in limit unlimited from one IPv6
  // connection. IPv6 clients are now keyed by their /64.
  it("sign-up: one IPv6 /64 gets one sign-up bucket, not one per address", async () => {
    const statuses: number[] = [];
    for (let i = 1; i <= 11; i++) statuses.push((await call(signupRoute, "POST", "/api/auth/signup", {}, viaProxy(`2001:db8:42:7::${i.toString(16)}`))).status);
    expect(statuses).toEqual([...Array(10).fill(422), 429]);
  });

  it("signed-out takedowns: one IPv6 /64 gets one takedown bucket, not one per address", async () => {
    const statuses: number[] = [];
    for (let i = 1; i <= 11; i++) statuses.push((await call(takedownRoute, "POST", "/api/takedowns", {}, viaProxy(`2001:db8:42:9:${i.toString(16)}::1`))).status);
    expect(statuses).toEqual([...Array(10).fill(422), 429]);
  });

  it("sign-in: one IPv6 /64 gets one per-IP bucket, so it cannot spray guesses across thirty-one accounts", async () => {
    // A different (unknown) email each time keeps the per-account bucket out of it; each attempt still runs bcrypt.
    const statuses: number[] = [];
    for (let i = 1; i <= 31; i++) statuses.push((await login(`member${i}@example.test`, "Summer2026!", viaProxy(`2001:db8:42:8::${i.toString(16)}`))).status);
    expect(statuses).toEqual([...Array(30).fill(401), 429]);
  }, 120_000);

  // Was a hole (R05-H2, fixed): some proxies write "address:port" into X-Forwarded-For (Azure Application
  // Gateway documents this format). clientIp() kept the port, so every new TCP connection from the same
  // client got a fresh bucket. The port and IPv6 brackets are now dropped before keying.
  it("an address:port entry from the proxy keys on the address, not on the ephemeral port", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await call(signupRoute, "POST", "/api/auth/signup", {}, viaProxy(`203.0.113.30:${40001 + i}`))).status);
    expect(statuses).toEqual([...Array(10).fill(422), 429]);
  });
});

describe("R05 attack: the shipped default, no proxy in front", () => {
  // HOLE (acknowledged residual (a) in the R05 report, still open): TRUSTED_PROXY_HOPS defaults to 0 and
  // docker-compose.yml publishes the web port on every interface with no proxy (docs/deployment.md: "No proxy
  // is bundled"). Next.js only fills X-Forwarded-For when the request has none
  // (node_modules/next/dist/server/base-server.js:565, `??=`), so a client talking straight to the app
  // forwards its own single entry, which clientIp() takes as the address. The original R05 exploit
  // (rotate X-Forwarded-For on every request) works unchanged on that setup.
  it.fails("a client that reaches the app directly cannot pick its own sign-up bucket", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await call(signupRoute, "POST", "/api/auth/signup", {}, { "x-forwarded-for": `10.66.0.${i + 1}` })).status);
    expect(statuses).toEqual([...Array(10).fill(422), 429]);
  });
});

describe("R05 attack: other ways to the same behaviour", () => {
  // Was a hole (R05-H3, fixed): DELETE /api/me checked the password with bcrypt (cost 12) and had no attempt
  // limit at all. A stolen session could guess the account password without limit (a right guess deletes the
  // account but reveals a password people reuse), and any member could drive unlimited bcrypt work from one
  // account, the CPU exhaustion R05 describes for sign-in. It now spends the sign-in per-account budget.
  it("the password re-check on account deletion is attempt-limited like sign-in", async () => {
    const user = await member("kim@example.test", "kim");
    requestScope.token = (await createSession(user.id, null)).token;
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await call(meDelete, "DELETE", "/api/me", { password: `guess-number-${i}` }, viaProxy("203.0.113.40"))).status);
    expect(statuses.filter((s) => s === 403).length).toBeLessThanOrEqual(10);
    expect(statuses).toContain(429);
  }, 60_000);

  // HOLE (low; limiter atomicity, widened by R30): rateLimit() sends INCR and then, only when the count is 1,
  // EXPIRE as a separate command. R30's request client gives up on a command after one reconnect attempt or
  // 2 s, so a connection drop between the two leaves the counter with no TTL. That bucket then never resets:
  // once it passes the limit (a member's login:email bucket, an address's signup bucket) it answers 429 forever.
  it.fails("a failure between INCR and EXPIRE does not leave a bucket that never expires", async () => {
    const client = requestRedis();
    vi.spyOn(client, "expire").mockRejectedValueOnce(new Error("Connection is closed."));
    const first = await call(signupRoute, "POST", "/api/auth/signup", {}, viaProxy("203.0.113.41"));
    expect(first.status).toBe(503);
    expect(await client.ttl("rl:signup:203.0.113.41")).toBeGreaterThan(0);
  });
});

describe("R05 attack: membership probe at sign-up", () => {
  // HOLE (acknowledged residual (b) in the R05 report, still open): sign-up answers 409 email_taken for an
  // address that has an account and 201 for one that does not, so anyone can check whether a given person
  // is a member of an adults-only site (ten probes an hour per address, unlimited over IPv6 as above).
  // Closing it needs email verification, which is a product decision.
  it.fails("signing up with a member's email answers the same as with a new one", async () => {
    await member("kim@example.test", "kim");
    const body = (email: string, handle: string) => ({ email, password: "a fine long password", handle, displayName: "Probe", dateOfBirth: "1990-01-01", acceptTerms: true, confirmAdult: true });
    const taken = await call(signupRoute, "POST", "/api/auth/signup", body("KIM@example.test", "probe_one"), viaProxy("203.0.113.42"));
    const fresh = await call(signupRoute, "POST", "/api/auth/signup", body("nobody@example.test", "probe_two"), viaProxy("203.0.113.43"));
    expect(taken.status).toBe(fresh.status);
  }, 60_000);
});
