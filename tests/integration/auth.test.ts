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

import * as React from "react";
import type { ReactElement } from "react";
import { eq } from "drizzle-orm";
import { POST as loginRoute } from "@/app/api/auth/login/route";
import { POST as signupRoute } from "@/app/api/auth/signup/route";
import { DELETE as meDelete, PATCH as mePatch } from "@/app/api/me/route";
import { POST as takedownRoute } from "@/app/api/takedowns/route";
import AuthPage from "@/app/auth/page";
import { AuthForms } from "@/components/auth-forms";
import { registerUser } from "@/server/auth/account";
import { createSession } from "@/server/auth/session";
import { closeDb, getDb } from "@/server/db";
import { userProfiles, users } from "@/server/db/schema";
import { HttpError, route } from "@/server/http";
import { setErrorSink } from "@/server/log";
import { updateProfile } from "@/server/me";
import { toErrorEvent, type ErrorEvent } from "@/server/observability";
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
  vi.unstubAllGlobals();
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

/** Where /auth?next=... sends someone: the server redirect when signed in, or the form's router.replace target when signed out. */
async function authLanding(next: string): Promise<string> {
  // Vitest compiles the page's JSX with the classic runtime (tsconfig keeps JSX for Next), which reads a global React.
  vi.stubGlobal("React", React);
  try {
    const el = (await AuthPage({ searchParams: Promise.resolve({ next }) })) as ReactElement;
    const find = (node: unknown): string | undefined => {
      if (!node || typeof node !== "object") return undefined;
      if (Array.isArray(node)) return node.map(find).find((v) => v !== undefined);
      const e = node as ReactElement<{ next?: string; children?: unknown }>;
      return e.type === AuthForms ? e.props.next : find(e.props?.children);
    };
    const target = find(el);
    if (target === undefined) throw new Error("AuthForms not rendered");
    return target;
  } catch (e) {
    const digest = (e as { digest?: unknown }).digest;
    if (typeof digest !== "string" || !digest.startsWith("NEXT_REDIRECT")) throw e;
    return digest.split(";")[2]!;
  }
}

describe("R23 sign-in redirect target", () => {
  // Each resolves to another origin in a browser (backslash, tab and newline read as "/" or vanish), or does once a
  // check normalizes it ("/.//x" becomes the protocol-relative "//x").
  const hostile = ["/\\evil.example", "/\t/evil.example", "/\n/evil.example", "/\\/evil.example", "//evil.example", "/.//evil.example", "https://evil.example/", "javascript:alert(1)"];

  for (const signedIn of [false, true]) {
    it(`never leaves the app (${signedIn ? "already signed in: server redirect" : "signed out: after the form"})`, async () => {
      if (signedIn) requestScope.token = (await createSession((await victim()).id, null)).token;
      for (const next of hostile) {
        const target = await authLanding(next);
        expect({ next, origin: new URL(target, "https://hushloom.example/auth").origin }).toEqual({ next, origin: "https://hushloom.example" });
      }
      expect(await authLanding("/settings#age-verification")).toBe("/settings#age-verification");
      expect(await authLanding("/templates/night-swim?ref=home")).toBe("/templates/night-swim?ref=home");
    });
  }
});

describe("R22 account deletion and handles", () => {
  it("a handle someone else chose cannot block deleting an account", async () => {
    const creator = await victim("creator@example.test", "creator");
    const attacker = await victim("attacker@example.test", "attacker");
    // The handle deletion used to assign: "deleted_" and the first 8 characters of the (public) user id.
    requestScope.token = (await createSession(attacker.id, null)).token;
    const claim = await call(mePatch, "PATCH", "/api/me", { displayName: "A", handle: `deleted_${creator.id.slice(0, 8)}` });
    expect(claim.status).toBe(200);

    requestScope.token = (await createSession(creator.id, null)).token;
    const res = await call(meDelete, "DELETE", "/api/me", { password: PASSWORD });
    expect(res.status).toBe(200);
    const [row] = await getDb().select().from(users).where(eq(users.id, creator.id));
    expect(row?.status).toBe("deleted");
  });

  it("losing a race for a handle is a 409, not a server error", async () => {
    const a = await victim("a@example.test", "first_user");
    const b = await victim("b@example.test", "second_user");
    // b's claim is written but not committed when a's check runs, so the check passes and a's update waits on the unique index.
    let commit!: () => void;
    const committed = new Promise<void>((resolve) => (commit = resolve));
    let claimed!: () => void;
    const written = new Promise<void>((resolve) => (claimed = resolve));
    const other = getDb().transaction(async (tx) => {
      await tx.update(userProfiles).set({ handle: "contested" }).where(eq(userProfiles.userId, b.id));
      claimed();
      await committed;
    });
    await written;
    const mine = updateProfile(a.id, { displayName: "A", handle: "contested", bio: "" }).then(
      () => "updated",
      (e: unknown) => e,
    );
    await new Promise((r) => setTimeout(r, 300));
    commit();
    await other;
    const outcome = await mine;
    expect(outcome).toBeInstanceOf(HttpError);
    expect({ status: (outcome as HttpError).status, code: (outcome as HttpError).code }).toEqual({ status: 409, code: "handle_taken" });
  });
});

describe("R28 unhandled-error logs", () => {
  it("a failed query logs none of the values it carried, on stdout or to the error monitor", async () => {
    const PRIVATE = ["private.person@example.test", "$2a$12$privatebcrypthashvalue", "1990-02-31"];
    const lines: string[] = [];
    const events: ErrorEvent[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => void lines.push(String(line)));
    setErrorSink((msg, meta) => events.push(toErrorEvent(msg, meta, "web", new Date())));
    try {
      // Postgres rejects the impossible date (22008) and quotes it in its own message, which Drizzle wraps as the cause.
      const handler = route(async () => {
        await getDb().insert(users).values({ email: PRIVATE[0]!, passwordHash: PRIVATE[1]!, dateOfBirth: PRIVATE[2]! });
        return new Response(null, { status: 204 });
      });
      expect((await call(handler as Handler, "POST", "/api/anything")).status).toBe(500);
    } finally {
      spy.mockRestore();
      setErrorSink(null);
    }
    expect(lines).toHaveLength(1);
    expect(events).toHaveLength(1);
    const logged = [...lines, JSON.stringify(events)].join("\n");
    for (const value of PRIVATE) expect(logged).not.toContain(value);
    // What is useful for debugging stays: the statement and the kind of failure.
    expect(logged).toContain('insert into \\"users\\"');
    expect(logged).toContain("date/time field value out of range");
  });
});
