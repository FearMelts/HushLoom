import sharp from "sharp";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Route handlers read the session cookie through next/headers, which only works inside a Next
// request. The tests stand in for that request scope, as tests/integration/scan.test.ts does.
const requestScope = vi.hoisted(() => ({ token: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "hl_session" && requestScope.token ? { name, value: requestScope.token } : undefined),
    set: () => undefined,
    delete: () => undefined,
  }),
  headers: async () => new Headers(),
}));

import { POST as charactersRoute } from "@/app/api/characters/route";
import { POST as uploadsRoute } from "@/app/api/uploads/route";
import { createSession } from "@/server/auth/session";
import { closeDb } from "@/server/db";
import { closeRedis } from "@/server/redis";
import { config as middlewareConfig } from "@/middleware";
import { makeUser, resetDb } from "../helpers";

type Handler = (req: NextRequest, ctx: never) => Promise<Response>;
const ROUTES: [string, Handler, (form: FormData) => void][] = [
  ["/api/uploads", uploadsRoute as Handler, (f) => f.set("consent", "true")],
  [
    "/api/characters",
    charactersRoute as Handler,
    (f) => {
      f.set("name", "Ana");
      f.set("consentAdult", "true");
      f.set("consentLikeness", "true");
    },
  ],
];

async function multipart(fields: (f: FormData) => void, bytes: Buffer) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], "photo.png", { type: "image/png" }));
  fields(form);
  const res = new Response(form);
  return { body: Buffer.from(await res.arrayBuffer()), type: res.headers.get("content-type")! };
}

const call = (handler: Handler, path: string, init: { body: BodyInit; headers: Record<string, string> }) =>
  handler(new NextRequest(`http://localhost${path}`, { method: "POST", body: init.body, headers: init.headers, duplex: "half" } as ConstructorParameters<typeof NextRequest>[1]), undefined as never);

beforeEach(async () => {
  await resetDb();
  const u = await makeUser();
  requestScope.token = (await createSession(u.id, null)).token;
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("upload bodies up to the documented limits reach the upload routes (R27)", () => {
  it("middleware, which would cut every body at 10 MB, does not run on the two upload routes", () => {
    const runs = (url: string) => unstable_doesMiddlewareMatch({ config: middlewareConfig, url });
    expect(runs("/api/uploads")).toBe(false);
    expect(runs("/api/characters")).toBe(false);
    // Everything else keeps the middleware and its cross-site check.
    expect(runs("/api/characters/2b1f0d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f")).toBe(true);
    expect(runs("/api/generations")).toBe(true);
    expect(runs("/api/uploads/x")).toBe(true);
    expect(runs("/library")).toBe(true);
  });

  for (const [path, handler, fields] of ROUTES) {
    it(`${path} refuses a cross-site write itself`, async () => {
      const png = await sharp({ create: { width: 600, height: 600, channels: 3, background: "#335544" } }).png().toBuffer();
      const { body, type } = await multipart(fields, png);
      const res = await call(handler, path, { body, headers: { "content-type": type, origin: "https://elsewhere.example" } });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: "bad_origin" } });
    });

    it(`${path} answers a cut-off multipart body with 400, not 500`, async () => {
      const png = await sharp({ create: { width: 600, height: 600, channels: 3, background: "#335544" } }).png().toBuffer();
      const { body, type } = await multipart(fields, png);
      const res = await call(handler, path, { body: body.subarray(0, body.length - 200), headers: { "content-type": type } });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "invalid_form" } });
    });

    it(`${path} answers a body that is not multipart with 400, not 500`, async () => {
      const res = await call(handler, path, { body: JSON.stringify({ file: "x" }), headers: { "content-type": "application/json" } });
      expect(res.status).toBe(400);
    });

    it(`${path} refuses a body over the limit with 413 before reading it`, async () => {
      let pulled = 0;
      const chunk = new Uint8Array(1024 * 1024);
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          pulled += chunk.length;
          if (pulled > 120 * 1024 * 1024) c.close();
          else c.enqueue(chunk);
        },
      });
      const res = await call(handler, path, { body: stream, headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(120 * 1024 * 1024) } });
      expect(res.status).toBe(413);
      expect(pulled).toBeLessThan(4 * 1024 * 1024);
    });

    it(`${path} stops reading a body without a length once it passes the limit`, async () => {
      let pulled = 0;
      const chunk = new Uint8Array(1024 * 1024);
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          pulled += chunk.length;
          if (pulled > 300 * 1024 * 1024) c.close();
          else c.enqueue(chunk);
        },
      });
      const res = await call(handler, path, { body: stream, headers: { "content-type": "multipart/form-data; boundary=x" } });
      expect(res.status).toBe(413);
      expect(pulled).toBeLessThan(110 * 1024 * 1024);
    });
  }
});
