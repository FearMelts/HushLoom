import sharp from "sharp";
import Stripe from "stripe";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { POST as stripeWebhook } from "@/app/api/webhooks/stripe/route";
import { GET as mediaRoute } from "@/app/api/media/route";
import { adjustCredits, resolveReport } from "@/server/admin";
import { deleteAccount, registerUser, withdrawConsent } from "@/server/auth/account";
import { createSession, userForToken, type SessionUser } from "@/server/auth/session";
import { createCharacter, removeCharacter } from "@/server/characters";
import { getBalance, listLedger } from "@/server/credits/ledger";
import { closeDb, getDb } from "@/server/db";
import {
  characterReferences,
  discoveryEvents,
  favorites,
  generationJobs,
  generationOutputs,
  mediaAssets,
  moderationEvents,
  subscriptions,
  templates,
  uploads,
  userPreferences,
} from "@/server/db/schema";
import { forYou } from "@/server/discovery/templates";
import { confirmJob, createDraft } from "@/server/generation/service";
import { processJob } from "@/server/generation/processor";
import { assetUrl, acceptUpload } from "@/server/media";
import { createPreset } from "@/server/presets";
import { addScene, createProject, getProjectDetail, reorderScenes, selectVersion } from "@/server/projects";
import { closeRedis } from "@/server/redis";
import { storage } from "@/server/storage";
import { publishTemplate } from "@/server/templates/publish";
import { key, makeUser, resetDb } from "../helpers";

const ctx = { country: null };
const png = (w = 640, h = 640) => sharp({ create: { width: w, height: h, channels: 3, background: "#553344" } }).png().toBuffer();

async function makeCreation(user: SessionUser, overrides: Record<string, unknown> = {}) {
  const draft = await createDraft(
    user,
    {
      idempotencyKey: key(),
      mode: "text_to_image",
      modelKey: "demo-still",
      prompt: "an adult couple sharing a toast by candlelight, warm film grain",
      negativePrompt: "",
      params: { aspectRatio: "1:1" },
      inputAssetIds: [],
      ...overrides,
    },
    ctx,
  );
  await confirmJob(user, draft.id, draft.costCredits);
  await processJob(draft.id);
  const [job] = await getDb().select().from(generationJobs).where(eq(generationJobs.id, draft.id));
  expect(job!.status).toBe("completed");
  const [out] = await getDb().select().from(generationOutputs).where(eq(generationOutputs.jobId, draft.id));
  const [asset] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, out!.assetId));
  return { job: job!, asset: asset! };
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("stripe webhook", () => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET!;
  const send = (event: object, signature?: string) => {
    const payload = JSON.stringify(event);
    const header = signature ?? new Stripe("sk_test_unused").webhooks.generateTestHeaderString({ payload, secret });
    return stripeWebhook(new NextRequest("http://localhost/api/webhooks/stripe", { method: "POST", body: payload, headers: { "stripe-signature": header } }), undefined as never);
  };
  const checkout = (id: string, userId: string, extra: Record<string, unknown> = {}) => ({
    id,
    object: "event",
    type: "checkout.session.completed",
    data: { object: { id: `cs_${id}`, object: "checkout.session", mode: "payment", payment_status: "paid", amount_total: 999, currency: "usd", metadata: { userId, itemKey: "pack_small" }, ...extra } },
  });

  it("grants a pack exactly once even when Stripe delivers the event twice", async () => {
    const u = await makeUser();
    const first = await send(checkout("evt_pack_1", u.id));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ outcome: "processed" });
    const again = await send(checkout("evt_pack_1", u.id));
    expect(await again.json()).toMatchObject({ outcome: "duplicate" });
    expect((await getBalance(u.id)).available).toBe(100);
    expect((await listLedger(u.id)).filter((l) => l.kind === "purchase")).toHaveLength(1);
  });

  it("rejects a forged signature and changes nothing", async () => {
    const u = await makeUser();
    const res = await send(checkout("evt_forged", u.id), "t=1,v1=deadbeef");
    expect(res.status).toBe(400);
    expect((await getBalance(u.id)).available).toBe(0);
  });

  it("ignores unpaid checkouts", async () => {
    const u = await makeUser();
    const res = await send(checkout("evt_unpaid", u.id, { payment_status: "unpaid" }));
    expect(await res.json()).toMatchObject({ outcome: "ignored" });
    expect((await getBalance(u.id)).available).toBe(0);
  });

  it("asks Stripe to retry an invoice that arrives before its subscription, then grants once", async () => {
    const u = await makeUser();
    const invoice = { id: "evt_inv_1", object: "event", type: "invoice.paid", data: { object: { id: "in_1", object: "invoice", subscription: "sub_1", amount_paid: 1999, currency: "usd" } } };
    const early = await send(invoice);
    expect(early.status).toBe(500);
    await send({
      id: "evt_sub_1",
      object: "event",
      type: "checkout.session.completed",
      data: { object: { id: "cs_sub", object: "checkout.session", mode: "subscription", subscription: "sub_1", amount_total: 1999, currency: "usd", metadata: { userId: u.id, itemKey: "plan_member" } } },
    });
    const retried = await send(invoice);
    expect(await retried.json()).toMatchObject({ outcome: "processed" });
    await send(invoice);
    expect((await getBalance(u.id)).available).toBe(400);
    const [sub] = await getDb().select().from(subscriptions).where(eq(subscriptions.userId, u.id));
    expect(sub?.status).toBe("active");
  });
});

describe("consent", () => {
  it("withdrawing an upload consent deletes the upload, every creation made from it, and the stored files", async () => {
    const u = await makeUser({ credits: 50 });
    const up = await acceptUpload(u.id, { bytes: await png(), declaredMime: "image/png" }, { statement: "test consent", subjectLabel: null }, "source");
    const { job, asset } = await makeCreation(u, { mode: "image_to_image", inputAssetIds: [up.assetId] });
    const [upAsset] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, up.assetId));
    const [row] = await getDb().select().from(uploads).where(eq(uploads.assetId, up.assetId));

    await withdrawConsent(u.id, row!.consentRecordId!);

    const [j] = await getDb().select().from(generationJobs).where(eq(generationJobs.id, job.id));
    expect(j!.deletedAt).not.toBeNull();
    for (const a of [asset, upAsset!]) {
      const [after] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, a.id));
      expect(after!.deletedAt).not.toBeNull();
      expect(after!.storageKey.startsWith("purged/")).toBe(true);
      await expect(storage().get(a.storageKey)).rejects.toThrow();
    }
    await expect(makeCreation(u, { mode: "image_to_image", inputAssetIds: [up.assetId] })).rejects.toMatchObject({ status: 404 });
  });

  it("removing a character deletes its reference and its creations", async () => {
    const u = await makeUser({ credits: 50 });
    const ch = await createCharacter(u.id, { bytes: await png(), declaredMime: "image/png" }, "Ari", null);
    const { job } = await makeCreation(u, { mode: "reference_guided", characterReferenceId: ch.id });
    await removeCharacter(u.id, ch.id);
    const [ref] = await getDb().select().from(characterReferences).where(eq(characterReferences.id, ch.id));
    const [j] = await getDb().select().from(generationJobs).where(eq(generationJobs.id, job.id));
    expect(ref!.deletedAt).not.toBeNull();
    expect(j!.deletedAt).not.toBeNull();
    await expect(makeCreation(u, { mode: "reference_guided", characterReferenceId: ch.id })).rejects.toMatchObject({ status: 404 });
  });

  it("one user cannot use another user's character or upload", async () => {
    const a = await makeUser({ credits: 50 });
    const b = await makeUser({ credits: 50 });
    const ch = await createCharacter(a.id, { bytes: await png(), declaredMime: "image/png" }, "Ari", null);
    const up = await acceptUpload(a.id, { bytes: await png(), declaredMime: "image/png" }, { statement: "x", subjectLabel: null }, "source");
    await expect(makeCreation(b, { mode: "reference_guided", characterReferenceId: ch.id })).rejects.toMatchObject({ status: 404 });
    await expect(makeCreation(b, { mode: "image_to_image", inputAssetIds: [up.assetId] })).rejects.toMatchObject({ status: 404 });
    await expect(removeCharacter(b.id, ch.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe("publishing", () => {
  it("copies the output to a new public asset and leaves the original private", async () => {
    const u = await makeUser({ credits: 50 });
    const other = await makeUser();
    const { job, asset } = await makeCreation(u);
    const t = await publishTemplate(u, { jobId: job.id, title: "Candle Toast", description: "", tags: ["warm"], isVip: false });
    expect(t.posterAssetId).not.toBe(asset.id);
    const [poster] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, t.posterAssetId!));
    expect(poster!.visibility).toBe("public");
    expect(await assetUrl(poster!, other.id)).not.toBeNull();
    expect(await assetUrl(asset, other.id)).toBeNull();
    expect(await assetUrl(asset, null)).toBeNull();
  });

  it("refuses to publish anything made from an upload or a character", async () => {
    const u = await makeUser({ credits: 50 });
    const up = await acceptUpload(u.id, { bytes: await png(), declaredMime: "image/png" }, { statement: "x", subjectLabel: null }, "source");
    const { job } = await makeCreation(u, { mode: "image_to_image", inputAssetIds: [up.assetId] });
    await expect(publishTemplate(u, { jobId: job.id, title: "Mine", description: "", tags: [], isVip: false })).rejects.toMatchObject({ status: 403, code: "personal_media" });
  });

  it("refuses to publish someone else's creation", async () => {
    const a = await makeUser({ credits: 50 });
    const b = await makeUser();
    const { job } = await makeCreation(a);
    await expect(publishTemplate(b, { jobId: job.id, title: "Theirs", description: "", tags: [], isVip: false })).rejects.toMatchObject({ status: 404 });
  });

  it("removing a reported template takes it down and closes every report on it", async () => {
    const creator = await makeUser({ credits: 50 });
    const admin = await makeUser({ role: "admin" });
    const { job } = await makeCreation(creator);
    const t = await publishTemplate(creator, { jobId: job.id, title: "Reported", description: "", tags: [], isVip: false });
    const [r1] = await getDb().insert(moderationEvents).values({ subjectType: "template", subjectId: t.id, action: "report", reason: "minor" }).returning();
    await getDb().insert(moderationEvents).values({ subjectType: "template", subjectId: t.id, action: "report", reason: "spam" });
    await resolveReport(admin.id, r1!.id, { action: "remove", note: "" });
    const [after] = await getDb().select().from(templates).where(eq(templates.id, t.id));
    expect(after!.status).toBe("removed");
    const open = await getDb().select().from(moderationEvents).where(and(eq(moderationEvents.subjectId, t.id), eq(moderationEvents.status, "open")));
    expect(open).toHaveLength(0);
    await expect(resolveReport(admin.id, r1!.id, { action: "dismiss", note: "" })).rejects.toMatchObject({ status: 409 });
  });
});

describe("video posters", () => {
  it("stores a poster frame for clips, uses it as the published cover, and deletes it with the creation", async () => {
    const u = await makeUser({ credits: 50 });
    const { job } = await makeCreation(u, { mode: "text_to_video", modelKey: "demo-motion", params: { aspectRatio: "9:16", durationS: 3 } });
    const [out] = await getDb().select().from(generationOutputs).where(eq(generationOutputs.jobId, job.id));
    expect(out!.posterAssetId).not.toBeNull();
    const [poster] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, out!.posterAssetId!));
    expect(poster).toMatchObject({ kind: "image", mime: "image/webp", visibility: "private", width: 720, height: 1280 });

    const t = await publishTemplate(u, { jobId: job.id, title: "Clip", description: "", tags: [], isVip: false });
    expect(t.posterAssetId).not.toBeNull();
    expect(t.posterAssetId).not.toBe(poster!.id);

    const { deleteJob } = await import("@/server/generation/service");
    await deleteJob(u, job.id);
    const [after] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, poster!.id));
    expect(after!.deletedAt).not.toBeNull();
  });
});

describe("discovery privacy", () => {
  it("For You falls back to trending when personalization is off", async () => {
    const creator = await makeUser({ credits: 50 });
    const viewer = await makeUser();
    const { job } = await makeCreation(creator);
    const t = await publishTemplate(creator, { jobId: job.id, title: "Signal", description: "", tags: ["warm"], isVip: false });
    await getDb().insert(favorites).values({ userId: viewer.id, targetType: "template", targetId: t.id });
    expect((await forYou({ id: viewer.id, explicitAllowed: true })).personalized).toBe(true);
    await getDb().insert(userPreferences).values({ userId: viewer.id, personalizationEnabled: false }).onConflictDoUpdate({ target: userPreferences.userId, set: { personalizationEnabled: false } });
    expect((await forYou({ id: viewer.id, explicitAllowed: true })).personalized).toBe(false);
  });
});

describe("accounts", () => {
  it("refuses under-18 signups without storing anything", async () => {
    const dob = new Date();
    dob.setUTCFullYear(dob.getUTCFullYear() - 17);
    await expect(
      registerUser({ email: "young@example.test", password: "long-enough-pass", handle: "young_one", displayName: "Y", dateOfBirth: dob.toISOString().slice(0, 10), acceptTerms: true, confirmAdult: true }),
    ).rejects.toMatchObject({ status: 403, code: "underage" });
    const rows = await getDb().execute(`select 1 from users where email = 'young@example.test'` as never);
    expect(rows).toHaveLength(0);
  });

  it("deleting an account ends sessions, removes templates and hides creations", async () => {
    const reg = await registerUser({ email: "leaver@example.test", password: "long-enough-pass", handle: "leaver", displayName: "L", dateOfBirth: "1990-05-05", acceptTerms: true, confirmAdult: true });
    const { token } = await createSession(reg.id, null);
    const user = (await userForToken(token))!;
    await adjustCredits((await makeUser({ role: "admin" })).id, { account: "leaver", amount: 20, reason: "test", idempotencyKey: key() });
    const { job } = await makeCreation(user);
    const t = await publishTemplate(user, { jobId: job.id, title: "Bye", description: "", tags: [], isVip: false });
    await getDb().insert(discoveryEvents).values({ userId: user.id, templateId: t.id, event: "view" });
    await expect(deleteAccount(user.id, "wrong-password")).rejects.toMatchObject({ status: 403 });
    await deleteAccount(user.id, "long-enough-pass");
    expect(await userForToken(token)).toBeNull();
    const [tt] = await getDb().select().from(templates).where(eq(templates.id, t.id));
    expect(tt!.status).toBe("removed");
    const [j] = await getDb().select().from(generationJobs).where(eq(generationJobs.id, job.id));
    expect(j!.deletedAt).not.toBeNull();
    expect(await getDb().select().from(discoveryEvents).where(eq(discoveryEvents.userId, user.id))).toHaveLength(0);
  });

  it("admin credit adjustments apply once per key", async () => {
    const admin = await makeUser({ role: "admin" });
    const u = await makeUser({ handle: "target_user" });
    const k = key();
    await adjustCredits(admin.id, { account: "@target_user", amount: 30, reason: "goodwill", idempotencyKey: k });
    const again = await adjustCredits(admin.id, { account: "target_user", amount: 30, reason: "goodwill", idempotencyKey: k });
    expect(again.applied).toBe(false);
    expect((await getBalance(u.id)).available).toBe(30);
    await expect(adjustCredits(admin.id, { account: "target_user", amount: -31, reason: "too much", idempotencyKey: key() })).rejects.toThrow(/credits/);
  });
});

describe("media route", () => {
  it("serves only valid, unexpired, undeleted links, and supports ranges", async () => {
    const u = await makeUser({ credits: 50 });
    const { asset } = await makeCreation(u);
    const signed = (await assetUrl(asset, u.id))!;
    const get = (url: string, headers: Record<string, string> = {}) => mediaRoute(new NextRequest(new URL(url, "http://localhost"), { headers }));

    const ok = await get(signed);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/webp");
    const full = Buffer.from(await ok.arrayBuffer());

    const part = await get(signed, { range: "bytes=0-9" });
    expect(part.status).toBe(206);
    expect(Buffer.from(await part.arrayBuffer())).toEqual(full.subarray(0, 10));
    const tail = await get(signed, { range: "bytes=-4" });
    expect(Buffer.from(await tail.arrayBuffer())).toEqual(full.subarray(full.length - 4));

    const u2 = new URL(signed, "http://localhost");
    u2.searchParams.set("s", "AAAA");
    expect((await get(u2.toString())).status).toBe(403);
    const u3 = new URL(signed, "http://localhost");
    u3.searchParams.delete("s");
    expect((await get(u3.toString())).status).toBe(403);

    await getDb().update(mediaAssets).set({ deletedAt: new Date() }).where(eq(mediaAssets.id, asset.id));
    expect((await get(signed)).status).toBe(404);
  });
});

describe("projects", () => {
  it("keeps scene order, copies continuity forward, and selects only finished takes", async () => {
    const u = await makeUser({ credits: 50 });
    const p = await createProject(u.id, { title: "Night swim", description: "" });
    let detail = await getProjectDetail(u.id, p.id);
    const first = detail.scenes[0]!;
    const { updateScene } = await import("@/server/projects");
    await updateScene(u.id, first.id, { continuity: { lighting: "neon", palette: "teal and plum" } });
    const second = await addScene(u.id, p.id, { title: "Pool edge" });
    expect(second.continuity).toEqual({ lighting: "neon", palette: "teal and plum" });

    await expect(reorderScenes(u.id, p.id, [second.id])).rejects.toMatchObject({ status: 422 });
    await reorderScenes(u.id, p.id, [second.id, first.id]);
    detail = await getProjectDetail(u.id, p.id);
    expect(detail.scenes.map((s) => s.id)).toEqual([second.id, first.id]);

    const { job } = await makeCreation(u, { projectId: p.id, sceneId: second.id });
    detail = await getProjectDetail(u.id, p.id);
    const version = detail.scenes[0]!.versions[0]!;
    expect(version.creation.id).toBe(job.id);
    await selectVersion(u.id, second.id, version.id);
    detail = await getProjectDetail(u.id, p.id);
    expect(detail.scenes[0]!.versions[0]!.isSelected).toBe(true);

    const other = await makeUser();
    await expect(getProjectDetail(other.id, p.id)).rejects.toMatchObject({ status: 404 });
    await expect(selectVersion(other.id, second.id, version.id)).rejects.toMatchObject({ status: 404 });
    await expect(makeCreation(other, { projectId: p.id })).rejects.toMatchObject({ status: 404 });
  });
});

describe("presets", () => {
  it("saves a creation's settings without its seed, and only for the owner", async () => {
    const u = await makeUser({ credits: 50 });
    const { job } = await makeCreation(u, { params: { aspectRatio: "4:5", seed: 42, quality: "4k" } });
    const preset = await createPreset(u.id, { name: "Warm toast", fromJobId: job.id });
    expect(preset.params).toEqual({ aspectRatio: "4:5", quality: "4k" });
    const other = await makeUser();
    await expect(createPreset(other.id, { name: "Steal", fromJobId: job.id })).rejects.toMatchObject({ status: 404 });
  });
});
