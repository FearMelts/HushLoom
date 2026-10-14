import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

// Attack tests for the age-verification fixes R03 (stored jurisdiction overrode the request's) and
// R04 (character photos skipped the upload gate). Each test tries another way to reach the same
// behavior. The holes they found are closed now; each of those tests says what it was.

// Route handlers read the session cookie and the geo headers through next/headers; the tests stand in for that request scope.
const requestScope = vi.hoisted(() => ({ token: null as string | null, headers: {} as Record<string, string> }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "hl_session" && requestScope.token ? { name, value: requestScope.token } : name === "hl_age_ok" ? { name, value: "1" } : undefined),
    set: () => undefined,
    delete: () => undefined,
  }),
  headers: async () => new Headers(requestScope.headers),
}));

import { POST as loginRoute } from "@/app/api/auth/login/route";
import { DELETE as characterDelete } from "@/app/api/characters/[id]/route";
import { GET as charactersGet, POST as charactersPost } from "@/app/api/characters/route";
import { POST as confirmRoute } from "@/app/api/generations/[id]/confirm/route";
import { POST as deriveRoute } from "@/app/api/generations/[id]/derive/route";
import { GET as downloadRoute } from "@/app/api/generations/[id]/download/route";
import { GET as generationsGet, POST as generationsPost } from "@/app/api/generations/route";
import { GET as meRoute } from "@/app/api/me/route";
import { POST as uploadsRoute } from "@/app/api/uploads/route";
import { viewerAccess } from "@/server/age/access";
import { SANDBOX_SIGNATURE_HEADER, sandboxCallback } from "@/server/age/providers/sandbox";
import { handleCallback, startVerification } from "@/server/age/service";
import { createSession, hashPassword, type SessionUser } from "@/server/auth/session";
import { createCharacter } from "@/server/characters";
import { getBalance } from "@/server/credits/ledger";
import { closeDb, getDb } from "@/server/db";
import { ageVerifications, characterReferences, generationJobs, uploads, users } from "@/server/db/schema";
import { env } from "@/server/env";
import { confirmJob, createDraft } from "@/server/generation/service";
import { processJob } from "@/server/generation/processor";
import { closeRedis } from "@/server/redis";
import { key, makeUser, resetDb } from "../helpers";

const GB = { "x-country-code": "GB" };
const png = () => sharp({ create: { width: 640, height: 640, channels: 3, background: "#335544" } }).png().toBuffer();

const draftBody = () => ({
  idempotencyKey: key(),
  mode: "text_to_image" as const,
  modelKey: "demo-still",
  prompt: "two adults sharing a candlelit toast, warm film grain",
  negativePrompt: "",
  params: { aspectRatio: "4:5" },
  inputAssetIds: [] as string[],
});

async function userIn(jurisdiction: string | null): Promise<SessionUser> {
  const u = await makeUser({ credits: 200 });
  if (jurisdiction) await getDb().update(users).set({ jurisdiction }).where(eq(users.id, u.id));
  return u;
}

async function signIn(user: SessionUser, headers: Record<string, string> = {}) {
  requestScope.token = (await createSession(user.id, null)).token;
  requestScope.headers = headers;
}

async function storedJurisdiction(id: string) {
  const [row] = await getDb().select({ jurisdiction: users.jurisdiction }).from(users).where(eq(users.id, id));
  return row!.jurisdiction;
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });

const postDraft = (headers: Record<string, string>) => generationsPost(new NextRequest("http://localhost/api/generations", json(draftBody(), headers)), undefined as never);

const confirm = (jobId: string, expectedCost: number, headers: Record<string, string>) =>
  confirmRoute(new NextRequest(`http://localhost/api/generations/${jobId}/confirm`, json({ expectedCost }, headers)), { params: Promise.resolve({ id: jobId }) });

async function characterForm() {
  const form = new FormData();
  form.set("file", new File([await png()], "me.png", { type: "image/png" }));
  form.set("name", "Mara");
  form.set("consentAdult", "true");
  form.set("consentLikeness", "true");
  return form;
}

const postCharacter = async (headers: Record<string, string>, body?: BodyInit) =>
  charactersPost(new NextRequest("http://localhost/api/characters", { method: "POST", body: body ?? (await characterForm()), headers }), undefined as never);

async function verifyThroughSandbox(user: SessionUser) {
  const started = await startVerification(user, { country: null });
  const signed = sandboxCallback(started.providerRef, "verified");
  await handleCallback("sandbox", { rawBody: signed.body, headers: new Headers({ [SANDBOX_SIGNATURE_HEADER]: signed.signature }), url: new URL("http://localhost/api/webhooks/age-verification/sandbox") });
}

/** Runs `fn` with fields of the cached env changed, then restores them. */
async function withEnv<T>(patch: Partial<ReturnType<typeof env>>, fn: () => Promise<T>): Promise<T> {
  const e = env() as Record<string, unknown>;
  const before = Object.fromEntries(Object.keys(patch).map((k) => [k, e[k]]));
  Object.assign(e, patch);
  try {
    return await fn();
  } finally {
    Object.assign(e, before);
  }
}

beforeEach(async () => {
  await resetDb();
  requestScope.token = null;
  requestScope.headers = {};
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("R03 attack: other entry points and header forms for a member whose stored place is uncovered", () => {
  it("POST /api/generations refuses GB and covered-state requests whatever the header's case or form, and still serves NL", async () => {
    const nl = await userIn("NL");
    await signIn(nl);
    const covered: Record<string, string>[] = [
      { "x-country-code": "GB" },
      { "x-country-code": "gb" },
      { "x-country-code": "GBR" },
      { "x-country-code": "US", "x-region-code": "TX" },
      { "x-country-code": "us", "x-region-code": "us-tx" },
      { "x-country-code": "US", "x-region-code": "US-TX" },
      { "x-country-code": "US", "x-region-code": "  tx  " },
    ];
    for (const headers of covered) {
      const res = await postDraft(headers);
      expect(res.status, JSON.stringify(headers)).toBe(451);
    }
    expect(await getDb().select().from(generationJobs)).toHaveLength(0);
    expect((await postDraft({ "x-country-code": "NL" })).status).toBe(201);
    // The pages read the same headers through next/headers (contextFromHeaders), with the same forms.
    for (const headers of covered) {
      requestScope.headers = headers;
      expect((await viewerAccess()).explicitAllowed, JSON.stringify(headers)).toBe(false);
    }
  });

  it("a VPN sign-in through the real login route that stores NL unlocks nothing from GB afterwards", async () => {
    const u = await makeUser({ credits: 50 });
    await getDb().update(users).set({ passwordHash: await hashPassword("correct horse battery") }).where(eq(users.id, u.id));
    const login = (headers: Record<string, string>) =>
      loginRoute(new NextRequest("http://localhost/api/auth/login", json({ email: u.email, password: "correct horse battery" }, headers)), undefined as never);

    expect((await login({ "x-country-code": "GB" })).status).toBe(200);
    expect(await storedJurisdiction(u.id)).toBe("GB");
    expect((await login({ "x-country-code": "NL" })).status).toBe(200);
    expect(await storedJurisdiction(u.id)).toBe("NL");

    await signIn(u, GB);
    expect((await postDraft(GB)).status).toBe(451);
    const form = new FormData();
    form.set("file", new File([await png()], "a.png", { type: "image/png" }));
    form.set("consent", "true");
    expect((await uploadsRoute(new NextRequest("http://localhost/api/uploads", { method: "POST", body: form, headers: GB }), undefined as never)).status).toBe(451);
    expect((await postCharacter(GB)).status).toBe(451);
    expect((await viewerAccess()).explicitAllowed).toBe(false);
    // Settings shows the check as required for this request, so the person is sent to verify.
    const me = (await (await meRoute(new NextRequest("http://localhost/api/me", { headers: GB }), undefined as never)).json()) as { ageVerification: { required: boolean; jurisdiction: string | null } };
    expect(me.ageVerification).toMatchObject({ required: true, jurisdiction: "GB" });
    expect(await getDb().select().from(uploads)).toHaveLength(0);
  });

  it("derive, download and the own-media list from GB are refused or withheld for a member who stored NL", async () => {
    const nl = await userIn("NL");
    // An earlier creation, made while really in the Netherlands.
    const draft = await createDraft(nl, draftBody(), { country: "NL" });
    await confirmJob(nl, draft.id, draft.costCredits);
    await processJob(draft.id);
    await signIn(nl, GB);
    const params = { params: Promise.resolve({ id: draft.id }) };

    const derived = await deriveRoute(new NextRequest(`http://localhost/api/generations/${draft.id}/derive`, json({ relation: "variation", idempotencyKey: key() }, GB)), params);
    expect(derived.status).toBe(451);
    const download = await downloadRoute(new NextRequest(`http://localhost/api/generations/${draft.id}/download`, { headers: GB }), params);
    expect(download.status).toBe(451);
    expect(download.headers.get("location")).toBeNull();
    const list = (await (await generationsGet(new NextRequest("http://localhost/api/generations", { headers: GB }), undefined as never)).json()) as { items: { id: string; output: { url: string | null } | null }[] };
    expect(list.items.find((i) => i.id === draft.id)!.output).toMatchObject({ url: null });
  });

  it("starting a check from GB records GB on the attempt, not the stored NL", async () => {
    const nl = await userIn("NL");
    const started = await startVerification(nl, { country: "GB" });
    const [row] = await getDb().select().from(ageVerifications).where(eq(ageVerifications.id, started.verificationId));
    expect(row!.jurisdiction).toBe("GB");
  });

  it("a stored covered place is not unlocked by an uncovered request (the union does not let the request override GB)", async () => {
    const gb = await userIn("GB");
    await signIn(gb);
    expect((await postDraft({ "x-country-code": "DE" })).status).toBe(451);
    expect((await postDraft({ "x-country-code": "US", "x-region-code": "CA" })).status).toBe(451);
    expect((await postCharacter({ "x-country-code": "DE" })).status).toBe(451);
  });

  it("with AGE_VERIFICATION_FAIL_CLOSED=true, an unknown location on the request is not overridden by a stored uncovered place", async () => {
    const nl = await userIn("NL");
    await signIn(nl);
    await withEnv({ AGE_VERIFICATION_FAIL_CLOSED: "true" }, async () => {
      for (const headers of [{ "x-country-code": "XX" }, { "x-country-code": "T1" }, { "x-country-code": "A1" }, { "x-country-code": "US" }]) {
        expect((await postDraft(headers)).status, JSON.stringify(headers)).toBe(451);
      }
    });
  });

  // Was a hole: POST /api/generations/:id/confirm had no age gate. confirmJob reserves the credits and
  // queues the job that actually generates, but only createDraft checked age, so a draft priced from an
  // uncovered place (one VPN request, or a trip abroad) could be started from GB within the 24 h draft
  // window. The confirm route now runs the gate for its own request.
  it("confirming a draft priced from an uncovered place does not start a generation from GB", async () => {
    const nl = await userIn("NL");
    await signIn(nl);
    const made = await postDraft({ "x-country-code": "NL" });
    expect(made.status).toBe(201);
    const { job } = (await made.json()) as { job: { id: string; costCredits: number } };

    const res = await confirm(job.id, job.costCredits, GB);
    const [row] = await getDb().select().from(generationJobs).where(eq(generationJobs.id, job.id));
    expect({ status: res.status, job: row!.status, reserved: (await getBalance(nl.id)).reserved }).toEqual({ status: 451, job: "awaiting_confirmation", reserved: 0 });
  });

  // Was a hole (same root cause): the gate was only checked when the draft was priced, so a verification
  // that lapsed between the draft and the confirm did not stop the generation.
  it("confirming a draft after the member's verification expired does not start a generation from GB", async () => {
    const gb = await userIn("GB");
    await verifyThroughSandbox(gb);
    const draft = await createDraft(gb, draftBody(), { country: "GB" });
    const lapsed = new Date(Date.now() - (env().AGE_VERIFICATION_VALID_DAYS + 1) * 86_400_000);
    await getDb().update(users).set({ ageVerifiedAt: lapsed }).where(eq(users.id, gb.id));
    await signIn(gb, GB);

    const res = await confirm(draft.id, draft.costCredits, GB);
    const [row] = await getDb().select().from(generationJobs).where(eq(generationJobs.id, draft.id));
    expect({ status: res.status, job: row!.status }).toEqual({ status: 451, job: "awaiting_confirmation" });
  });

  // The other form of the same lapse: a sandbox result reads as unverified once the site is live (R16),
  // so a draft priced on it cannot be confirmed there either.
  it("confirming a draft on a live site with only a sandbox verification does not start a generation from GB", async () => {
    const gb = await userIn("GB");
    await verifyThroughSandbox(gb);
    const draft = await createDraft(gb, draftBody(), { country: "GB" });
    await signIn(gb, GB);

    const res = await withEnv({ APP_ENV: "production" }, () => confirm(draft.id, draft.costCredits, GB));
    const [row] = await getDb().select().from(generationJobs).where(eq(generationJobs.id, draft.id));
    expect({ status: res.status, job: row!.status, reserved: (await getBalance(gb.id)).reserved }).toEqual({ status: 451, job: "awaiting_confirmation", reserved: 0 });
  });
});

describe("R04 attack: character photos", () => {
  it("every status short of a live verified one gets 451 from GB: unverified, pending, failed, expired, and a sandbox result on a live site", async () => {
    const lapsed = new Date(Date.now() - (env().AGE_VERIFICATION_VALID_DAYS + 1) * 86_400_000);
    const states = [
      { ageVerificationStatus: "unverified" as const },
      { ageVerificationStatus: "pending" as const, ageVerificationProvider: "sandbox" },
      { ageVerificationStatus: "failed" as const, ageVerificationProvider: "sandbox" },
      { ageVerificationStatus: "verified" as const, ageVerificationProvider: "yoti", ageVerifiedAt: lapsed },
    ];
    for (const state of states) {
      const u = await userIn("NL");
      await getDb().update(users).set(state).where(eq(users.id, u.id));
      await signIn(u);
      expect((await postCharacter(GB)).status, JSON.stringify(state)).toBe(451);
    }
    const sandboxed = await userIn("GB");
    await getDb().update(users).set({ ageVerificationStatus: "verified", ageVerificationProvider: "sandbox", ageVerifiedAt: new Date() }).where(eq(users.id, sandboxed.id));
    await signIn(sandboxed);
    await withEnv({ APP_ENV: "production" }, async () => {
      expect((await postCharacter(GB)).status).toBe(451);
    });
    expect(await getDb().select().from(characterReferences)).toHaveLength(0);
    expect(await getDb().select().from(uploads)).toHaveLength(0);
  });

  it("the gate runs before the body is read: JSON, empty, malformed multipart and a video all get 451, never a parse error or a stored file", async () => {
    const gb = await userIn("GB");
    await signIn(gb);
    const bodies: [string, Record<string, string>, BodyInit | undefined][] = [
      ["json", { "content-type": "application/json" }, JSON.stringify({ name: "Mara", consentAdult: "true", consentLikeness: "true" })],
      ["empty", {}, ""],
      ["broken multipart", { "content-type": "multipart/form-data; boundary=zzz" }, "--zzz\r\nnot really\r\n"],
    ];
    for (const [label, headers, body] of bodies) {
      const res = await charactersPost(new NextRequest("http://localhost/api/characters", { method: "POST", headers: { ...GB, ...headers }, body }), undefined as never);
      expect(res.status, label).toBe(451);
    }
    const video = new FormData();
    video.set("file", new File([Buffer.from("....ftypisom")], "clip.mp4", { type: "video/mp4" }));
    video.set("name", "Mara");
    video.set("consentAdult", "true");
    video.set("consentLikeness", "true");
    expect((await postCharacter(GB, video)).status).toBe(451);
    expect(await getDb().select().from(uploads)).toHaveLength(0);
  });

  it("blocked attempts do not use up the hourly character limit, so verifying later works at once", async () => {
    const gb = await userIn("GB");
    await signIn(gb);
    for (let i = 0; i < 12; i++) expect((await postCharacter(GB)).status).toBe(451);
    await verifyThroughSandbox(gb);
    expect((await postCharacter(GB)).status).toBe(201);
  });

  it("a reference photo kept from an uncovered place cannot be used to generate from GB while unverified", async () => {
    const nl = await userIn("NL");
    const ref = await createCharacter(nl.id, { bytes: await png(), declaredMime: "image/png" }, "Mara", null);
    await signIn(nl, GB);
    const res = await generationsPost(
      new NextRequest("http://localhost/api/generations", json({ ...draftBody(), mode: "reference_guided", characterReferenceId: ref.id }, GB)),
      undefined as never,
    );
    expect(res.status).toBe(451);
  });

  it("an unverified member in GB can still remove a character (withdrawing likeness consent is never gated)", async () => {
    const nl = await userIn("NL");
    const ref = await createCharacter(nl.id, { bytes: await png(), declaredMime: "image/png" }, "Mara", null);
    await signIn(nl, GB);
    const res = await characterDelete(new NextRequest(`http://localhost/api/characters/${ref.id}`, { method: "DELETE", headers: GB }), { params: Promise.resolve({ id: ref.id }) });
    expect(res.status).toBe(200);
    const [row] = await getDb().select().from(characterReferences).where(and(eq(characterReferences.id, ref.id)));
    expect(row!.deletedAt).not.toBeNull();
  });

  it("every API route that reads an uploaded body sits behind the age gate (no second upload door)", () => {
    const root = path.resolve(__dirname, "../../src/app/api");
    const routes = (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith("route.ts")).map((f) => path.join(root, f));
    const readsUpload = routes.filter((f) => !f.includes(`${path.sep}webhooks${path.sep}`) && /\.formData\(\)|\.arrayBuffer\(\)|\.blob\(\)/.test(readFileSync(f, "utf8")));
    expect(readsUpload.map((f) => path.relative(root, f)).sort()).toEqual(["characters/route.ts", "uploads/route.ts"]);
    for (const f of readsUpload) expect(readFileSync(f, "utf8"), f).toMatch(/assertAgeVerified\(user, \{ country: requestCountry\(req\), region: requestRegion\(req\) \}\)/);
  });

  // Was a hole: the fix gated new character uploads only. GET /api/characters (and the /train page, which
  // calls the same listCharacters) still signed the stored likeness photos for a member who needs
  // verification here and lacks it, so a photo kept from an uncovered place, or from before the gate, was
  // served back from GB. listCharacters now takes the viewer's age decision, as the creation lists do.
  it("GET /api/characters withholds stored likeness photos from an unverified member in GB", async () => {
    const nl = await userIn("NL");
    await createCharacter(nl.id, { bytes: await png(), declaredMime: "image/png" }, "Mara", null);
    await signIn(nl, GB);
    const res = await charactersGet(new NextRequest("http://localhost/api/characters", { headers: GB }), undefined as never);
    const { characters } = (await res.json()) as { characters: { imageUrl: string | null }[] };
    expect(characters).toHaveLength(1);
    expect(characters[0]!.imageUrl).toBeNull();
    expect(characters[0]).toMatchObject({ name: "Mara", mediaWithheld: true });
    // The same member from the uncovered place still gets the photo, so only the age decision withholds it.
    const fromNl = await charactersGet(new NextRequest("http://localhost/api/characters", { headers: { "x-country-code": "NL" } }), undefined as never);
    expect(((await fromNl.json()) as { characters: { imageUrl: string | null; mediaWithheld: boolean }[] }).characters[0]).toMatchObject({ imageUrl: expect.stringMatching(/^\/api\/media\?/), mediaWithheld: false });
  });
});
