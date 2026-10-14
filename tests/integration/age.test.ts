import sharp from "sharp";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

// Route handlers read the session cookie and the geo headers through next/headers, which only
// works inside a Next request. The tests stand in for that request scope.
const requestScope = vi.hoisted(() => ({ token: null as string | null, headers: {} as Record<string, string> }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "hl_session" && requestScope.token ? { name, value: requestScope.token } : undefined),
    set: () => undefined,
    delete: () => undefined,
  }),
  headers: async () => new Headers(requestScope.headers),
}));

import { POST as charactersRoute } from "@/app/api/characters/route";
import { GET as meRoute } from "@/app/api/me/route";
import { GET as templatesRoute } from "@/app/api/templates/route";
import { POST as uploadsRoute } from "@/app/api/uploads/route";
import { POST as ageWebhook } from "@/app/api/webhooks/age-verification/[provider]/route";
import { ageVerificationStatus } from "@/server/age";
import { viewerAccess } from "@/server/age/access";
import { assertAgeVerified } from "@/server/age/gate";
import { SANDBOX_SIGNATURE_HEADER, sandboxCallback } from "@/server/age/providers/sandbox";
import { configuredRegions, jurisdictionRequired } from "@/server/age/rules";
import { applyResult, handleCallback, requirementFor, startVerification, viewerAccessFor } from "@/server/age/service";
import { createSession, type SessionUser } from "@/server/auth/session";
import { closeDb, getDb } from "@/server/db";
import { ageVerifications, auditLogs, characterReferences, generationJobs, uploads, users } from "@/server/db/schema";
import { env } from "@/server/env";
import { browseTemplates } from "@/server/discovery/templates";
import { confirmJob, createDraft } from "@/server/generation/service";
import { processJob } from "@/server/generation/processor";
import { closeRedis } from "@/server/redis";
import { publishTemplate } from "@/server/templates/publish";
import { key, makeUser, resetDb } from "../helpers";

const ctx = { country: null };
const png = () => sharp({ create: { width: 640, height: 640, channels: 3, background: "#553344" } }).png().toBuffer();

const draftInput = () => ({
  idempotencyKey: key(),
  mode: "text_to_image" as const,
  modelKey: "demo-still",
  prompt: "two adults sharing a candlelit toast, warm film grain",
  negativePrompt: "",
  params: { aspectRatio: "4:5" },
  inputAssetIds: [],
});

/** A member whose account carries a stored jurisdiction, as signup/login would have recorded it. */
async function userIn(jurisdiction: string | null, opts: { credits?: number } = {}): Promise<SessionUser> {
  const u = await makeUser({ credits: opts.credits ?? 50 });
  if (jurisdiction) await getDb().update(users).set({ jurisdiction }).where(eq(users.id, u.id));
  return u;
}

async function signIn(user: SessionUser, headers: Record<string, string> = {}) {
  requestScope.token = (await createSession(user.id, null)).token;
  requestScope.headers = headers;
}

function anonymous(headers: Record<string, string> = {}) {
  requestScope.token = null;
  requestScope.headers = headers;
}

async function userRow(id: string) {
  const [row] = await getDb().select().from(users).where(eq(users.id, id));
  return row!;
}

async function verificationRow(providerRef: string) {
  const [row] = await getDb().select().from(ageVerifications).where(and(eq(ageVerifications.provider, "sandbox"), eq(ageVerifications.providerRef, providerRef)));
  return row!;
}

function sandboxWebhook(body: string, signature?: string | null) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature) headers[SANDBOX_SIGNATURE_HEADER] = signature;
  return ageWebhook(new NextRequest("http://localhost/api/webhooks/age-verification/sandbox", { method: "POST", body, headers }), { params: Promise.resolve({ provider: "sandbox" }) });
}

/** Starts a sandbox check and delivers the signed outcome through the real webhook route. */
async function verifyThroughSandbox(user: SessionUser, outcome: "verified" | "failed" = "verified") {
  const started = await startVerification(user, ctx);
  const signed = sandboxCallback(started.providerRef, outcome);
  const res = await sandboxWebhook(signed.body, signed.signature);
  expect(res.status).toBe(200);
  return started;
}

async function auditActions(targetId: string) {
  const rows = await getDb().select().from(auditLogs).where(and(eq(auditLogs.targetType, "age_verification"), eq(auditLogs.targetId, targetId))).orderBy(auditLogs.createdAt);
  return rows.map((r) => ({ action: r.action, actorId: r.actorId, providerRef: (r.metadata as { providerRef?: string }).providerRef }));
}

async function publishedTemplate() {
  const creator = await makeUser({ credits: 50 });
  const draft = await createDraft(creator, draftInput(), ctx);
  await confirmJob(creator, draft.id, draft.costCredits);
  await processJob(draft.id);
  const [job] = await getDb().select().from(generationJobs).where(eq(generationJobs.id, draft.id));
  expect(job!.status).toBe("completed");
  return publishTemplate(creator, { jobId: job!.id, title: "Candle Toast", description: "", tags: ["warm"], isVip: false });
}

beforeEach(async () => {
  await resetDb();
  anonymous();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("configuration", () => {
  it("runs the sandbox provider in tests, enforces by default, and covers the UK and the US states with laws", () => {
    const status = ageVerificationStatus();
    expect(status.provider).toBe("sandbox");
    expect(status.sandbox).toBe(true);
    expect(status.enforce).toBe(true);
    expect(configuredRegions()).toEqual(expect.arrayContaining(["GB", "US-TX", "US-FL"]));
    expect(jurisdictionRequired("GB")).toBe(true);
    expect(jurisdictionRequired("US-TX")).toBe(true);
    expect(jurisdictionRequired("us-tx")).toBe(true);
    expect(jurisdictionRequired("DE")).toBe(false);
    expect(jurisdictionRequired("US-CA")).toBe(false);
    // Unknown location: AGE_VERIFICATION_FAIL_CLOSED decides, and it defaults to open.
    expect(env().AGE_VERIFICATION_FAIL_CLOSED).toBe("false");
    expect(jurisdictionRequired(null)).toBe(false);
  });
});

describe("the gate", () => {
  it("returns 451 with a path to fix it for GB and US-TX accounts, and lets a DE account through", async () => {
    const gb = await userIn("GB");
    const tx = await userIn("US-TX");
    const de = await userIn("DE");
    for (const blocked of [gb, tx]) {
      await expect(createDraft(blocked, draftInput(), ctx)).rejects.toMatchObject({
        status: 451,
        code: "age_verification_required",
        details: { verifyPath: "/settings#age-verification", status: "unverified" },
      });
      await expect(assertAgeVerified(blocked, ctx)).rejects.toMatchObject({ status: 451 });
    }
    const draft = await createDraft(de, draftInput(), ctx);
    expect(draft.status).toBe("awaiting_confirmation");
    expect((await getDb().select().from(generationJobs).where(eq(generationJobs.userId, gb.id))).length).toBe(0);
  });

  it("uses the request's geo headers when the account has no stored jurisdiction, and stays open for accounts without either", async () => {
    const nowhere = await userIn(null);
    await expect(createDraft(nowhere, draftInput(), { country: "GB" })).rejects.toMatchObject({ status: 451 });
    await expect(createDraft(nowhere, draftInput(), { country: "US", region: "TX" })).rejects.toMatchObject({ status: 451 });
    await expect(createDraft(nowhere, draftInput(), { country: "US", region: "CA" })).resolves.toMatchObject({ status: "awaiting_confirmation" });
    await expect(createDraft(nowhere, draftInput(), ctx)).resolves.toMatchObject({ status: "awaiting_confirmation" });
    // A stored jurisdiction wins over the headers of the current request.
    const gb = await userIn("GB");
    await expect(createDraft(gb, draftInput(), { country: "DE" })).rejects.toMatchObject({ status: 451 });
  });

  it("blocks the upload route with the same 451 until verified", async () => {
    const gb = await userIn("GB");
    await signIn(gb);
    const form = new FormData();
    form.set("file", new File([await png()], "a.png", { type: "image/png" }));
    form.set("consent", "true");
    const blocked = await uploadsRoute(new NextRequest("http://localhost/api/uploads", { method: "POST", body: form }), undefined as never);
    expect(blocked.status).toBe(451);
    expect(await blocked.json()).toMatchObject({ error: { code: "age_verification_required", details: { verifyPath: "/settings#age-verification" } } });

    await verifyThroughSandbox(gb);
    const form2 = new FormData();
    form2.set("file", new File([await png()], "a.png", { type: "image/png" }));
    form2.set("consent", "true");
    const ok = await uploadsRoute(new NextRequest("http://localhost/api/uploads", { method: "POST", body: form2 }), undefined as never);
    expect(ok.status).toBe(201);
  });
});

describe("sandbox verification flow", () => {
  it("marks the user pending on start, verified after a signed callback, and the same user can then create", async () => {
    const gb = await userIn("GB");
    const started = await startVerification(gb, ctx);
    expect(started.sandbox).toBe(true);
    expect(started.url).toContain(`/verify/sandbox?ref=${started.providerRef}`);
    expect((await userRow(gb.id)).ageVerificationStatus).toBe("pending");
    expect((await verificationRow(started.providerRef))).toMatchObject({ status: "pending", jurisdiction: "GB", userId: gb.id });
    await expect(createDraft(gb, draftInput(), ctx)).rejects.toMatchObject({ status: 451, details: { status: "pending" } });

    const signed = sandboxCallback(started.providerRef, "verified");
    const res = await sandboxWebhook(signed.body, signed.signature);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, outcome: "verified" });

    const u = await userRow(gb.id);
    expect(u.ageVerificationStatus).toBe("verified");
    expect(u.ageVerificationProvider).toBe("sandbox");
    expect(u.ageVerifiedAt).not.toBeNull();
    const row = await verificationRow(started.providerRef);
    expect(row.status).toBe("verified");
    expect(row.method).toBe("sandbox");
    expect(row.completedAt).not.toBeNull();
    expect(row.expiresAt!.getTime() - row.completedAt!.getTime()).toBe(env().AGE_VERIFICATION_VALID_DAYS * 86_400_000);

    const req = await requirementFor({ id: gb.id }, ctx);
    expect(req).toMatchObject({ jurisdiction: "GB", required: true, status: "verified" });
    expect(req.expiresAt).toEqual(row.expiresAt);
    await expect(createDraft(gb, draftInput(), ctx)).resolves.toMatchObject({ status: "awaiting_confirmation" });
    await expect(startVerification(gb, ctx)).rejects.toMatchObject({ code: "already_verified" });
  });

  it("rejects unsigned, forged and malformed callbacks and changes nothing", async () => {
    const gb = await userIn("GB");
    const started = await startVerification(gb, ctx);
    const signed = sandboxCallback(started.providerRef, "verified");

    const unsigned = await sandboxWebhook(signed.body, null);
    expect(unsigned.status).toBe(400);
    expect(await unsigned.json()).toMatchObject({ error: { code: "callback_unsigned" } });

    const forged = await sandboxWebhook(signed.body, "0".repeat(64));
    expect(forged.status).toBe(400);
    expect(await forged.json()).toMatchObject({ error: { code: "callback_bad_signature" } });

    // A valid signature over a different body does not transfer.
    const tampered = await sandboxWebhook(signed.body.replace('"verified"', '"failed"'), signed.signature);
    expect(tampered.status).toBe(400);

    const other = sandboxCallback("sbx_unknown_reference", "verified");
    const unknown = await sandboxWebhook(other.body, other.signature);
    expect(unknown.status).toBe(404);

    const malformed = await sandboxWebhook("not json", "x");
    expect(malformed.status).toBe(400);

    expect((await userRow(gb.id)).ageVerificationStatus).toBe("pending");
    expect((await verificationRow(started.providerRef)).status).toBe("pending");
    expect(await auditActions((await verificationRow(started.providerRef)).id)).toEqual([{ action: "age_verification.pending", actorId: gb.id, providerRef: started.providerRef }]);
    await expect(createDraft(gb, draftInput(), ctx)).rejects.toMatchObject({ status: 451 });
  });

  it("rejects a replayed callback, including a later 'failed' for an already verified reference", async () => {
    const gb = await userIn("GB");
    const started = await verifyThroughSandbox(gb);
    const again = sandboxCallback(started.providerRef, "verified");
    const replay = await sandboxWebhook(again.body, again.signature);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ error: { code: "callback_replayed" } });

    const flip = sandboxCallback(started.providerRef, "failed");
    const flipped = await sandboxWebhook(flip.body, flip.signature);
    expect(flipped.status).toBe(409);

    expect((await userRow(gb.id)).ageVerificationStatus).toBe("verified");
    expect((await verificationRow(started.providerRef)).status).toBe("verified");
    const actions = await auditActions((await verificationRow(started.providerRef)).id);
    expect(actions.map((a) => a.action)).toEqual(["age_verification.pending", "age_verification.verified"]);
  });

  it("records a failed outcome with its reason, audits it with actor null, and keeps the user blocked", async () => {
    const gb = await userIn("GB");
    const started = await verifyThroughSandbox(gb, "failed");
    expect((await userRow(gb.id)).ageVerificationStatus).toBe("failed");
    const row = await verificationRow(started.providerRef);
    expect(row).toMatchObject({ status: "failed", failureReason: "sandbox_simulated_failure" });
    expect(await auditActions(row.id)).toEqual([
      { action: "age_verification.pending", actorId: gb.id, providerRef: started.providerRef },
      { action: "age_verification.failed", actorId: null, providerRef: started.providerRef },
    ]);
    await expect(createDraft(gb, draftInput(), ctx)).rejects.toMatchObject({ status: 451, details: { status: "failed" } });
    // They can try again.
    await verifyThroughSandbox(gb);
    expect((await userRow(gb.id)).ageVerificationStatus).toBe("verified");
  });

  it("never downgrades a verified account because an older pending attempt later fails", async () => {
    const gb = await userIn("GB");
    const stale = await startVerification(gb, ctx);
    await verifyThroughSandbox(gb);
    const late = sandboxCallback(stale.providerRef, "failed");
    expect((await sandboxWebhook(late.body, late.signature)).status).toBe(200);
    expect((await verificationRow(stale.providerRef)).status).toBe("failed");
    expect((await userRow(gb.id)).ageVerificationStatus).toBe("verified");
  });

  it("writes an audit row for every status change", async () => {
    const gb = await userIn("GB");
    const started = await verifyThroughSandbox(gb);
    const row = await verificationRow(started.providerRef);
    expect(await auditActions(row.id)).toEqual([
      { action: "age_verification.pending", actorId: gb.id, providerRef: started.providerRef },
      { action: "age_verification.verified", actorId: null, providerRef: started.providerRef },
    ]);
  });

  it("only accepts callbacks for the active provider and a pending outcome changes nothing", async () => {
    const gb = await userIn("GB");
    const started = await startVerification(gb, ctx);
    await expect(handleCallback("yoti", { rawBody: "{}", headers: new Headers(), url: new URL("http://localhost") })).rejects.toMatchObject({ status: 404 });
    await expect(applyResult("sandbox", { providerRef: started.providerRef, outcome: "pending" })).resolves.toMatchObject({ outcome: "pending" });
    expect((await verificationRow(started.providerRef)).status).toBe("pending");
    expect((await userRow(gb.id)).ageVerificationStatus).toBe("pending");
  });
});

describe("expiry", () => {
  it("reads a verification older than AGE_VERIFICATION_VALID_DAYS as expired and blocks again until redone", async () => {
    const gb = await userIn("GB");
    await verifyThroughSandbox(gb);
    await expect(createDraft(gb, draftInput(), ctx)).resolves.toBeTruthy();
    const old = new Date(Date.now() - (env().AGE_VERIFICATION_VALID_DAYS + 1) * 86_400_000);
    await getDb().update(users).set({ ageVerifiedAt: old }).where(eq(users.id, gb.id));
    const req = await requirementFor({ id: gb.id }, ctx);
    expect(req.status).toBe("expired");
    expect(req.expiresAt!.getTime()).toBeLessThan(Date.now());
    await expect(createDraft(gb, draftInput(), ctx)).rejects.toMatchObject({ status: 451, details: { status: "expired" } });
    await verifyThroughSandbox(gb);
    expect((await requirementFor({ id: gb.id }, ctx)).status).toBe("verified");
    await expect(createDraft(gb, draftInput(), ctx)).resolves.toBeTruthy();
  });
});

describe("explicit media", () => {
  it("withholds template media for an unverified GB viewer and issues it after verification", async () => {
    const t = await publishedTemplate();
    const gb = await userIn("GB");

    const before = await viewerAccessFor(gb, ctx);
    expect(before).toMatchObject({ jurisdiction: "GB", required: true, status: "unverified", explicitAllowed: false });
    const withheld = await browseTemplates({ sort: "new" }, before.viewer);
    const card = withheld.items.find((c) => c.id === t.id)!;
    expect(card.title).toBe("Candle Toast");
    expect(card.posterUrl).toBeNull();
    expect(card.previewUrl).toBeNull();
    expect(card.mediaWithheld).toBe(true);

    await verifyThroughSandbox(gb);
    const after = await viewerAccessFor(gb, ctx);
    expect(after.explicitAllowed).toBe(true);
    const shown = (await browseTemplates({ sort: "new" }, after.viewer)).items.find((c) => c.id === t.id)!;
    expect(shown.posterUrl).toMatch(/\/api\/media/);
    expect(shown.mediaWithheld).toBe(false);
  });

  it("decides for anonymous visitors from the geo headers", async () => {
    await publishedTemplate();
    expect((await viewerAccessFor(null, { country: "GB" })).explicitAllowed).toBe(false);
    expect((await viewerAccessFor(null, { country: "US", region: "TX" })).explicitAllowed).toBe(false);
    expect((await viewerAccessFor(null, { country: "DE" })).explicitAllowed).toBe(true);
    expect((await viewerAccessFor(null, { country: null })).explicitAllowed).toBe(true);
    const de = await userIn("DE");
    expect((await viewerAccessFor(de, ctx)).explicitAllowed).toBe(true);
  });

  it("applies the same decision in the templates API through viewerAccess()", async () => {
    const t = await publishedTemplate();
    // The route reads the viewer through viewerAccess(), i.e. the (mocked) request scope's cookie and geo headers.
    const list = () => templatesRoute(new NextRequest("http://localhost/api/templates?sort=new"), undefined as never).then((r) => r.json() as Promise<{ items: { id: string; posterUrl: string | null; mediaWithheld: boolean }[] }>);

    anonymous({ "x-country-code": "GB" });
    expect((await viewerAccess()).explicitAllowed).toBe(false);
    const gbList = await list();
    expect(gbList.items.find((c) => c.id === t.id)).toMatchObject({ posterUrl: null, mediaWithheld: true });

    anonymous({ "x-country-code": "DE" });
    const deList = await list();
    expect(deList.items.find((c) => c.id === t.id)!.posterUrl).toMatch(/\/api\/media/);

    const gb = await userIn("GB");
    await signIn(gb, { "x-country-code": "DE" });
    expect((await viewerAccess()).explicitAllowed).toBe(false);
    await verifyThroughSandbox(gb);
    expect((await viewerAccess()).explicitAllowed).toBe(true);
  });
});

describe("settings", () => {
  it("GET /api/me reports the verification status, jurisdiction, requirement and the sandbox label", async () => {
    const gb = await userIn("GB");
    await signIn(gb);
    const before = (await (await meRoute(new NextRequest("http://localhost/api/me"), undefined as never)).json()) as { ageVerification: Record<string, unknown> };
    expect(before.ageVerification).toMatchObject({ status: "unverified", jurisdiction: "GB", required: true, verifyPath: "/settings#age-verification", provider: { key: "sandbox", sandbox: true } });
    await verifyThroughSandbox(gb);
    const after = (await (await meRoute(new NextRequest("http://localhost/api/me"), undefined as never)).json()) as { ageVerification: { status: string; history: unknown[] } };
    expect(after.ageVerification.status).toBe("verified");
    expect(after.ageVerification.history).toHaveLength(1);
  });

  it("uses the request's geo headers for an account without a stored jurisdiction", async () => {
    const nowhere = await userIn(null);
    await signIn(nowhere);
    const req = new NextRequest("http://localhost/api/me", { headers: { "x-country-code": "US", "x-region-code": "TX" } });
    const data = (await (await meRoute(req, undefined as never)).json()) as { ageVerification: Record<string, unknown> };
    expect(data.ageVerification).toMatchObject({ jurisdiction: "US-TX", required: true });
    const elsewhere = new NextRequest("http://localhost/api/me", { headers: { "x-country-code": "DE" } });
    expect(((await (await meRoute(elsewhere, undefined as never)).json()) as { ageVerification: Record<string, unknown> }).ageVerification).toMatchObject({ jurisdiction: "DE", required: false });
  });
});

describe("R03: the current request's location counts as well as the stored one", () => {
  it("requires verification from GB or US-TX although the account stored an uncovered place, and keeps the stored value", async () => {
    const t = await publishedTemplate();
    // Stored at signup or the last sign-in over a VPN that exits in the Netherlands.
    const nl = await userIn("NL");
    await expect(createDraft(nl, draftInput(), { country: "GB" })).rejects.toMatchObject({ status: 451, details: { jurisdiction: "GB" } });
    await expect(createDraft(nl, draftInput(), { country: "US", region: "TX" })).rejects.toMatchObject({ status: 451, details: { jurisdiction: "US-TX" } });
    expect(await viewerAccessFor(nl, { country: "GB" })).toMatchObject({ required: true, explicitAllowed: false });

    // The request-scoped paths: template media and the upload route.
    await signIn(nl, { "x-country-code": "GB" });
    expect((await viewerAccess()).explicitAllowed).toBe(false);
    const list = (await (await templatesRoute(new NextRequest("http://localhost/api/templates?sort=new"), undefined as never)).json()) as { items: { id: string; posterUrl: string | null; mediaWithheld: boolean }[] };
    expect(list.items.find((c) => c.id === t.id)).toMatchObject({ posterUrl: null, mediaWithheld: true });
    const form = new FormData();
    form.set("file", new File([await png()], "a.png", { type: "image/png" }));
    form.set("consent", "true");
    const upload = await uploadsRoute(new NextRequest("http://localhost/api/uploads", { method: "POST", body: form, headers: { "x-country-code": "GB" } }), undefined as never);
    expect(upload.status).toBe(451);

    // From an uncovered place, or with no location on the request, the account still works, and the stored value is unchanged.
    await expect(createDraft(nl, draftInput(), { country: "DE" })).resolves.toMatchObject({ status: "awaiting_confirmation" });
    await expect(createDraft(nl, draftInput(), ctx)).resolves.toMatchObject({ status: "awaiting_confirmation" });
    expect((await userRow(nl.id)).jurisdiction).toBe("NL");

    // Verifying unlocks the covered request.
    await verifyThroughSandbox(nl);
    await expect(createDraft(nl, draftInput(), { country: "GB" })).resolves.toMatchObject({ status: "awaiting_confirmation" });
    expect((await viewerAccess()).explicitAllowed).toBe(true);
  });
});

describe("R04: character photos go through the same gate as uploads", () => {
  const characterForm = async () => {
    const form = new FormData();
    form.set("file", new File([await png()], "me.png", { type: "image/png" }));
    form.set("name", "Mara");
    form.set("consentAdult", "true");
    form.set("consentLikeness", "true");
    return form;
  };
  const postCharacter = async (headers: Record<string, string> = {}) =>
    charactersRoute(new NextRequest("http://localhost/api/characters", { method: "POST", body: await characterForm(), headers }), undefined as never);

  it("returns 451 to an unverified user in a covered place and stores nothing until verified", async () => {
    const gb = await userIn("GB");
    await signIn(gb);
    const blocked = await postCharacter();
    expect(blocked.status).toBe(451);
    expect(await blocked.json()).toMatchObject({ error: { code: "age_verification_required", details: { verifyPath: "/settings#age-verification" } } });
    const tx = await userIn(null);
    await signIn(tx);
    expect((await postCharacter({ "x-country-code": "US", "x-region-code": "TX" })).status).toBe(451);
    expect(await getDb().select().from(characterReferences)).toHaveLength(0);
    expect(await getDb().select().from(uploads)).toHaveLength(0);

    await signIn(gb);
    await verifyThroughSandbox(gb);
    expect((await postCharacter()).status).toBe(201);
    expect(await getDb().select().from(characterReferences).where(eq(characterReferences.userId, gb.id))).toHaveLength(1);
  });
});
