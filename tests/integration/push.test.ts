import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import webpush from "web-push";
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

// The real sender must never run here: it would POST to a real push service.
vi.mock("@/server/push/sender", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/push/sender")>()),
  webPushSender: vi.fn(async () => {
    throw new Error("the real web-push sender ran inside a test");
  }),
}));

import { POST as logoutRoute } from "@/app/api/auth/logout/route";
import { PATCH as preferencesRoute } from "@/app/api/me/preferences/route";
import { DELETE as deleteAccountRoute } from "@/app/api/me/route";
import { DELETE as signOutEverywhereRoute } from "@/app/api/me/sessions/route";
import { GET as publicKeyRoute } from "@/app/api/push/public-key/route";
import { DELETE as unsubscribeRoute, POST as subscribeRoute } from "@/app/api/push/subscriptions/route";
import { createSession, hashPassword, type SessionUser } from "@/server/auth/session";
import { closeDb, getDb } from "@/server/db";
import { auditLogs, generationJobs, pushSubscriptions, sessions, userPreferences, users } from "@/server/db/schema";
import { confirmJob, createDraft } from "@/server/generation/service";
import { processJob } from "@/server/generation/processor";
import { settingsFor } from "@/server/me";
import { pushStatus, vapidConfig, vapidFrom, type VapidConfig } from "@/server/push";
import { notifyJobFinished } from "@/server/push/notify";
import { pushRequestOptions, webPushSender, type PushSender, type PushTarget } from "@/server/push/sender";
import { isPushServiceEndpoint } from "@/server/push/subscriptions";
import { closeRedis } from "@/server/redis";
import { publishTemplate } from "@/server/templates/publish";
import { key, makeUser, resetDb } from "../helpers";

// A VAPID pair made for this run only (nothing is sent anywhere); env() reads it on first use.
const testKeys = webpush.generateVAPIDKeys();
vi.stubEnv("VAPID_PUBLIC_KEY", testKeys.publicKey);
vi.stubEnv("VAPID_PRIVATE_KEY", testKeys.privateKey);
vi.stubEnv("VAPID_SUBJECT", "mailto:push-tests@example.test");
const vapid: VapidConfig = { publicKey: testKeys.publicKey, privateKey: testKeys.privateKey, subject: "mailto:push-tests@example.test" };

/** What a browser's PushSubscription.toJSON() produces: a push-service endpoint and a real P-256 key with a 16-byte secret. */
function browserSubscription(host = "fcm.googleapis.com") {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint: `https://${host}/fcm/send/${randomUUID()}`,
    expirationTime: null,
    keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
  };
}

/** Signs in on a new device: a fresh session, used by the following route calls. */
async function signIn(user: SessionUser) {
  const ids = async () => (await getDb().select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, user.id))).map((r) => r.id);
  const before = new Set(await ids());
  const { token } = await createSession(user.id, "test-device");
  requestScope.token = token;
  return { token, sessionId: (await ids()).find((id) => !before.has(id))! };
}

function json(method: string, url: string, body?: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 (test)" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const subscribe = (body: unknown) => subscribeRoute(json("POST", "/api/push/subscriptions", body), undefined as never);
const unsubscribe = (endpoint: string) => unsubscribeRoute(json("DELETE", "/api/push/subscriptions", { endpoint }), undefined as never);
const rowsFor = (userId: string) => getDb().select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));

async function optIn(userId: string) {
  await getDb().insert(userPreferences).values({ userId, notifyOnFinish: true }).onConflictDoUpdate({ target: userPreferences.userId, set: { notifyOnFinish: true } });
}

/** A recording sender that answers each endpoint with the status given for it (201 by default). */
function fakeSender(statusFor: (target: PushTarget) => number = () => 201) {
  const sent: { endpoint: string; payload: string }[] = [];
  const sender: PushSender = async (target, payload) => {
    sent.push({ endpoint: target.endpoint, payload });
    const status = statusFor(target);
    return status < 300 ? { ok: true, statusCode: status } : { ok: false, statusCode: status, gone: status === 404 || status === 410 };
  };
  return { sender: vi.fn(sender), sent };
}

beforeEach(async () => {
  await resetDb();
  requestScope.token = null;
  vi.mocked(webPushSender).mockClear();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await closeRedis();
  await closeDb();
});

describe("push configuration", () => {
  it("is off without VAPID keys and says why", () => {
    expect(pushStatus({})).toEqual({ enabled: false, reason: "not_configured", publicKey: null });
    expect(vapidConfig({})).toBeNull();
    expect(vapidFrom({ VAPID_PUBLIC_KEY: testKeys.publicKey })).toEqual({ reason: "incomplete" });
    expect(vapidFrom({ VAPID_PUBLIC_KEY: "short", VAPID_PRIVATE_KEY: testKeys.privateKey, VAPID_SUBJECT: "mailto:a@b.test" })).toEqual({ reason: "invalid_keys" });
    expect(vapidFrom({ VAPID_PUBLIC_KEY: testKeys.publicKey, VAPID_PRIVATE_KEY: testKeys.privateKey, VAPID_SUBJECT: "http://insecure.test" })).toEqual({ reason: "invalid_subject" });
  });

  it("is on with a valid pair and publishes only the public key", async () => {
    const res = await publicKeyRoute(json("GET", "/api/push/public-key"), undefined as never);
    expect(await res.json()).toEqual({ enabled: true, reason: null, publicKey: testKeys.publicKey });
  });

  it("accepts only the browsers' push services as endpoints", () => {
    for (const ok of ["https://fcm.googleapis.com/fcm/send/abc", "https://updates.push.services.mozilla.com/wpush/v2/abc", "https://web.push.apple.com/QGx", "https://wns2-par02p.notify.windows.com/w/?token=x"]) {
      expect(isPushServiceEndpoint(ok), ok).toBe(true);
    }
    for (const bad of ["http://fcm.googleapis.com/fcm/send/abc", "https://fcm.googleapis.com:8443/x", "https://evil.example/collect", "https://fcm.googleapis.com.evil.example/x", "https://user:pw@fcm.googleapis.com/x", "https://169.254.169.254/latest", "not a url"]) {
      expect(isPushServiceEndpoint(bad), bad).toBe(false);
    }
  });
});

describe("subscriptions", () => {
  it("stores one subscription per device, tied to its session; a second device adds a second row", async () => {
    const user = await makeUser();
    const phone = await signIn(user);
    const phoneSub = browserSubscription();
    const first = await subscribe(phoneSub);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, created: true });

    // The phone re-syncs on its next visit: still one row, no second audit entry.
    const again = await subscribe(phoneSub);
    expect(await again.json()).toMatchObject({ ok: true, created: false });

    const laptop = await signIn(user);
    expect(laptop.sessionId).not.toBe(phone.sessionId);
    await subscribe(browserSubscription("updates.push.services.mozilla.com"));

    const rows = await rowsFor(user.id);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.sessionId))).toEqual(new Set([phone.sessionId, laptop.sessionId]));
    expect(rows.find((r) => r.endpoint === phoneSub.endpoint)).toMatchObject({ sessionId: phone.sessionId, p256dh: phoneSub.keys.p256dh, auth: phoneSub.keys.auth, userAgent: "Mozilla/5.0 (test)" });
    const audits = await getDb().select().from(auditLogs).where(and(eq(auditLogs.actorId, user.id), eq(auditLogs.action, "push.subscribe")));
    expect(audits).toHaveLength(2);
    // The endpoint is a capability URL: it is not copied into the audit log.
    expect(JSON.stringify(audits)).not.toContain(phoneSub.endpoint);
  });

  it("refuses signed-out callers, foreign endpoints and malformed keys", async () => {
    expect((await subscribe(browserSubscription())).status).toBe(401);
    const user = await makeUser();
    await signIn(user);
    expect((await subscribe({ ...browserSubscription(), endpoint: "https://evil.example/collect" })).status).toBe(422);
    expect((await subscribe({ ...browserSubscription(), keys: { p256dh: "abc", auth: randomBytes(16).toString("base64url") } })).status).toBe(422);
    expect((await subscribe({ ...browserSubscription(), keys: { p256dh: browserSubscription().keys.p256dh, auth: "short" } })).status).toBe(422);
    expect(await rowsFor(user.id)).toHaveLength(0);
  });

  it("logout removes that session's subscription only", async () => {
    const user = await makeUser();
    const phone = await signIn(user);
    await subscribe(browserSubscription());
    const laptop = await signIn(user);
    const laptopSub = browserSubscription();
    await subscribe(laptopSub);

    requestScope.token = phone.token;
    expect((await logoutRoute(json("POST", "/api/auth/logout"), undefined as never)).status).toBe(200);

    const rows = await rowsFor(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId: laptop.sessionId, endpoint: laptopSub.endpoint });
    expect(await getDb().select().from(sessions).where(eq(sessions.id, phone.sessionId))).toHaveLength(0);
  });

  it("deleting a session row also deletes its subscriptions (the foreign key cascades)", async () => {
    const user = await makeUser();
    const device = await signIn(user);
    await subscribe(browserSubscription());
    await getDb().delete(sessions).where(eq(sessions.id, device.sessionId));
    expect(await rowsFor(user.id)).toHaveLength(0);
  });

  it("sign out everywhere and account deletion remove every device", async () => {
    const user = await makeUser();
    await signIn(user);
    await subscribe(browserSubscription());
    await signIn(user);
    await subscribe(browserSubscription());
    expect(await rowsFor(user.id)).toHaveLength(2);
    expect((await signOutEverywhereRoute(json("DELETE", "/api/me/sessions"), undefined as never)).status).toBe(200);
    expect(await rowsFor(user.id)).toHaveLength(0);

    const leaving = await makeUser();
    await getDb().update(users).set({ passwordHash: await hashPassword("correct horse battery") }).where(eq(users.id, leaving.id));
    await signIn(leaving);
    await subscribe(browserSubscription());
    await signIn(leaving);
    await subscribe(browserSubscription());
    expect((await deleteAccountRoute(json("DELETE", "/api/me", { password: "correct horse battery" }), undefined as never)).status).toBe(200);
    expect(await rowsFor(leaving.id)).toHaveLength(0);
  });

  it("DELETE by endpoint removes only your own subscription", async () => {
    const owner = await makeUser();
    await signIn(owner);
    const mine = browserSubscription();
    await subscribe(mine);

    const other = await makeUser();
    await signIn(other);
    expect(await (await unsubscribe(mine.endpoint)).json()).toEqual({ ok: true, removed: 0 });
    expect(await rowsFor(owner.id)).toHaveLength(1);

    await signIn(owner);
    expect(await (await unsubscribe(mine.endpoint)).json()).toEqual({ ok: true, removed: 1 });
    expect(await rowsFor(owner.id)).toHaveLength(0);
  });

  it("settings carry the preference and whether push is configured; the preference saves", async () => {
    const user = await makeUser();
    await signIn(user);
    expect(await settingsFor(user.id)).toMatchObject({ pushEnabled: true, preferences: { notifyOnFinish: false } });
    expect((await preferencesRoute(json("PATCH", "/api/me/preferences", { notifyOnFinish: true }), undefined as never)).status).toBe(200);
    expect(await settingsFor(user.id)).toMatchObject({ preferences: { notifyOnFinish: true } });
  });
});

describe("notifyJobFinished", () => {
  async function subscribedUser(devices = 1) {
    const user = await makeUser({ credits: 50 });
    const endpoints: string[] = [];
    for (let i = 0; i < devices; i++) {
      await signIn(user);
      const sub = browserSubscription();
      await subscribe(sub);
      endpoints.push(sub.endpoint);
    }
    return { user, endpoints };
  }

  it("does nothing while the user has not opted in", async () => {
    const { user } = await subscribedUser();
    const { sender } = fakeSender();
    expect(await notifyJobFinished({ userId: user.id, jobId: randomUUID(), outcome: "completed" }, { sender, vapid })).toMatchObject({ sent: 0, skipped: "preference_off" });
    expect(sender).not.toHaveBeenCalled();
  });

  it("does nothing without VAPID keys, even for an opted-in user", async () => {
    const { user } = await subscribedUser();
    await optIn(user.id);
    const { sender } = fakeSender();
    expect(await notifyJobFinished({ userId: user.id, jobId: randomUUID(), outcome: "completed" }, { sender, vapid: null })).toMatchObject({ sent: 0, skipped: "push_disabled" });
    expect(sender).not.toHaveBeenCalled();
  });

  it("sends the neutral payload to every signed-in device, and nothing from the job", async () => {
    // A real job made from a published template, with a distinctive prompt.
    const creator = await makeUser({ credits: 50 });
    const base = await createDraft(creator, { idempotencyKey: key(), mode: "text_to_image", modelKey: "demo-still", prompt: "lace curtains at dusk, soft rim light", negativePrompt: "", params: { aspectRatio: "4:5" }, inputAssetIds: [] }, { country: null });
    await confirmJob(creator, base.id, base.costCredits);
    await processJob(base.id);
    const template = await publishTemplate(creator, { jobId: base.id, title: "Amber Velvet Booth", description: "", tags: ["warm"], isVip: false });

    const { user, endpoints } = await subscribedUser(2);
    await optIn(user.id);
    const draft = await createDraft(
      user,
      { idempotencyKey: key(), mode: "text_to_image", modelKey: "demo-still", templateId: template.id, prompt: "a whispered secret about Mara by the window", negativePrompt: "crowds", params: { aspectRatio: "4:5" }, inputAssetIds: [] },
      { country: null },
    );
    const [job] = await getDb().select().from(generationJobs).where(eq(generationJobs.id, draft.id));
    expect(job!.templateId).toBe(template.id);

    const { sender, sent } = fakeSender();
    expect(await notifyJobFinished({ userId: user.id, jobId: job!.id, outcome: "completed" }, { sender, vapid })).toEqual({ sent: 2, pruned: 0, failed: 0 });
    expect(new Set(sent.map((s) => s.endpoint))).toEqual(new Set(endpoints));
    for (const { payload } of sent) {
      expect(JSON.parse(payload)).toEqual({ title: "Hushloom", body: "Your creation is ready", url: `/collection/${job!.id}`, tag: `job-${job!.id}` });
      for (const secret of ["whispered", "Mara", "crowds", "Amber Velvet Booth", template.slug, "demo-still", "4:5", user.handle, user.email]) expect(payload).not.toContain(secret);
    }
    const rows = await rowsFor(user.id);
    expect(rows.every((r) => r.lastUsedAt !== null && r.failedAt === null)).toBe(true);
    expect(webPushSender).not.toHaveBeenCalled();
  });

  it("prunes a subscription the push service reports gone (410), and keeps a temporarily failing one", async () => {
    const { user, endpoints } = await subscribedUser(3);
    await optIn(user.id);
    const [healthy, gone, flaky] = endpoints as [string, string, string];
    const { sender } = fakeSender((t) => (t.endpoint === gone ? 410 : t.endpoint === flaky ? 503 : 201));
    expect(await notifyJobFinished({ userId: user.id, jobId: randomUUID(), outcome: "failed" }, { sender, vapid })).toEqual({ sent: 1, pruned: 1, failed: 1 });
    const rows = await rowsFor(user.id);
    expect(rows.map((r) => r.endpoint).sort()).toEqual([healthy, flaky].sort());
    expect(rows.find((r) => r.endpoint === flaky)!.failedAt).not.toBeNull();
    expect(rows.find((r) => r.endpoint === healthy)!.lastUsedAt).not.toBeNull();
  });

  it("skips devices whose session has expired", async () => {
    const { user } = await subscribedUser(1);
    await optIn(user.id);
    await getDb().update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sessions.userId, user.id));
    const { sender } = fakeSender();
    expect(await notifyJobFinished({ userId: user.id, jobId: randomUUID(), outcome: "completed" }, { sender, vapid })).toMatchObject({ sent: 0, skipped: "no_subscriptions" });
    expect(sender).not.toHaveBeenCalled();
  });

  it("never throws into the processor: a crashing sender or a database error is logged and swallowed", async () => {
    const { user } = await subscribedUser(1);
    await optIn(user.id);
    const crashing: PushSender = async () => {
      throw new Error("socket hang up");
    };
    await expect(notifyJobFinished({ userId: user.id, jobId: randomUUID(), outcome: "completed" }, { sender: crashing, vapid })).resolves.toEqual({ sent: 0, pruned: 0, failed: 1 });
    await expect(notifyJobFinished({ userId: "not-a-uuid", jobId: randomUUID(), outcome: "completed" }, { sender: crashing, vapid })).resolves.toMatchObject({ skipped: "error" });
  });

  it("the real sender's request is VAPID-signed and the payload encrypted (built locally, nothing sent)", () => {
    const sub = browserSubscription();
    const payload = JSON.stringify({ title: "Hushloom", body: "Your creation is ready", url: `/collection/${randomUUID()}`, tag: "job-x" });
    const details = webpush.generateRequestDetails({ endpoint: sub.endpoint, keys: sub.keys }, payload, pushRequestOptions(vapid));
    expect(details.endpoint).toBe(sub.endpoint);
    expect(String(details.headers.Authorization)).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    expect(details.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(Number(details.headers.TTL)).toBe(12 * 60 * 60);
    expect(details.body).toBeInstanceOf(Buffer);
    expect(details.body!.toString("latin1")).not.toContain("Your creation is ready");
  });
});
