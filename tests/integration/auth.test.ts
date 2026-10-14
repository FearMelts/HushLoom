import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Route handlers read the session cookie through next/headers, which only works inside a Next
// request. The tests stand in for that request scope.
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
import { POST as takedownRoute } from "@/app/api/takedowns/route";
import { registerUser } from "@/server/auth/account";
import { closeDb } from "@/server/db";
import { closeRedis } from "@/server/redis";
import { resetDb } from "../helpers";

type Handler = (req: NextRequest, ctx: never) => Promise<Response>;

function call(handler: Handler, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const init = body === undefined ? { method, headers } : { method, body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } };
  return handler(new NextRequest(`http://localhost${url}`, init), undefined as never);
}

const PASSWORD = "correct horse battery staple";

async function victim(email = "victim@example.test", handle = "victim") {
  return registerUser({ email, password: PASSWORD, handle, displayName: "Victim", dateOfBirth: "1990-01-01", acceptTerms: true, confirmAdult: true });
}

/** What an appending reverse proxy forwards: whatever the client sent, then the address it saw. */
const viaProxy = (clientSent: string, seen: string) => ({ "x-forwarded-for": `${clientSent}, ${seen}` });

beforeEach(async () => {
  await resetDb();
  requestScope.token = null;
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("R05 sign-in and sign-up limits", () => {
  it("padding or recasing the email does not open a fresh per-account login bucket", async () => {
    await victim();
    // Ten wrong guesses, each spelled differently; authenticate() trims and lowercases every one to the same account.
    const spellings = Array.from({ length: 11 }, (_, i) => `${" ".repeat(i + 1)}${i % 2 ? "VICTIM" : "victim"}@example.test${i % 3 ? "\t" : " "}`);
    for (const email of spellings.slice(0, 10)) {
      expect((await call(loginRoute, "POST", "/api/auth/login", { email, password: "wrong-guess-123" })).status).toBe(401);
    }
    const eleventh = await call(loginRoute, "POST", "/api/auth/login", { email: spellings[10], password: PASSWORD });
    expect(eleventh.status).toBe(429);
  });

  it("a forged left-most X-Forwarded-For does not open a fresh per-IP login bucket", async () => {
    await victim();
    // 30 attempts from one address behind an appending proxy, each with a new forged left-most entry.
    // The first ten reach bcrypt; the per-account limit answers the other twenty without it.
    for (let i = 0; i < 30; i++) {
      const res = await call(loginRoute, "POST", "/api/auth/login", { email: "victim@example.test", password: "wrong-guess-123" }, viaProxy(`10.9.${i}.1`, "203.0.113.9"));
      expect(res.status).toBe(i < 10 ? 401 : 429);
    }
    const fresh = await call(loginRoute, "POST", "/api/auth/login", { email: "someone-else@example.test", password: "guess" }, viaProxy("10.200.0.1", "203.0.113.9"));
    expect(fresh.status).toBe(429);
  });

  it("a forged left-most X-Forwarded-For does not open a fresh per-IP sign-up bucket", async () => {
    // The limit runs before the body is read, so empty bodies count without creating accounts.
    for (let i = 0; i < 10; i++) {
      expect((await call(signupRoute, "POST", "/api/auth/signup", {}, viaProxy(`10.8.${i}.1`, "203.0.113.10"))).status).toBe(422);
    }
    expect((await call(signupRoute, "POST", "/api/auth/signup", {}, viaProxy("10.8.99.1", "203.0.113.10"))).status).toBe(429);
  });

  it("a forged left-most X-Forwarded-For does not open a fresh per-IP takedown bucket when signed out", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await call(takedownRoute, "POST", "/api/takedowns", {}, viaProxy(`10.7.${i}.1`, "203.0.113.11"))).status).toBe(422);
    }
    expect((await call(takedownRoute, "POST", "/api/takedowns", {}, viaProxy("10.7.99.1", "203.0.113.11"))).status).toBe(429);
  });
});
