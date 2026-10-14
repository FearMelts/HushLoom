import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { SessionUser } from "@/server/auth/session";
import { createCharacter } from "@/server/characters";
import { generatePrefill } from "@/server/create-context";
import { closeDb, getDb } from "@/server/db";
import { generationJobs, mediaAssets, moderationEvents, subscriptions, templates } from "@/server/db/schema";
import { confirmJob, createDraft, deleteJob } from "@/server/generation/service";
import { processJob } from "@/server/generation/processor";
import { acceptUpload } from "@/server/media";
import { createPreset, presetSchema } from "@/server/presets";
import { addScene, createProject } from "@/server/projects";
import { closeRedis } from "@/server/redis";
import { storage } from "@/server/storage";
import { publishTemplate } from "@/server/templates/publish";
import { key, makeUser, resetDb } from "../helpers";

const ctx = { country: null };
const png = () => sharp({ create: { width: 640, height: 640, channels: 3, background: "#553344" } }).png().toBuffer();

const draftInput = (overrides: Record<string, unknown> = {}) => ({
  idempotencyKey: key(),
  mode: "text_to_image" as const,
  modelKey: "demo-still",
  prompt: "an adult couple sharing a toast by candlelight, warm film grain",
  negativePrompt: "",
  params: { aspectRatio: "1:1", lighting: "candlelit" },
  inputAssetIds: [],
  ...overrides,
});

async function finished(user: SessionUser, overrides: Record<string, unknown> = {}) {
  const draft = await createDraft(user, draftInput(overrides), ctx);
  await confirmJob(user, draft.id, draft.costCredits);
  await processJob(draft.id);
  const [job] = await getDb().select().from(generationJobs).where(eq(generationJobs.id, draft.id));
  expect(job!.status).toBe("completed");
  return job!;
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("Remix and Reuse settings", () => {
  it("links the new creation to its source and keeps the template's attribution", async () => {
    const creator = await makeUser({ credits: 50 });
    const member = await makeUser({ credits: 50 });
    const t = await publishTemplate(creator, { jobId: (await finished(creator)).id, title: "Candle Toast", description: "", tags: [], isVip: false });
    const source = await finished(member, { templateId: t.id });

    const remix = await generatePrefill(member.id, "image", { from: source.id });
    expect(remix).toMatchObject({ parentJobId: source.id, relation: "remix", templateId: t.id, modelKey: "demo-still", mode: "text_to_image", prompt: source.prompt });
    expect(remix!.params).toEqual({ aspectRatio: "1:1", lighting: "candlelit" });
    const exact = await generatePrefill(member.id, "image", { from: source.id, reuse: "exact" });
    expect(exact!.params!.seed).toBe(source.params.seed);

    // What the panel sends from that prefill.
    const made = await createDraft(member, draftInput({ templateId: remix!.templateId, parentJobId: remix!.parentJobId, relation: remix!.relation, params: remix!.params }), ctx);
    expect(made).toMatchObject({ templateId: t.id, parentJobId: source.id, relation: "remix" });
    expect(made.params.seed).not.toBe(source.params.seed);
  });

  it("drops the attribution, not the remix, once the template can no longer be made from", async () => {
    const creator = await makeUser({ credits: 50 });
    const member = await makeUser({ credits: 50 });
    const t = await publishTemplate(creator, { jobId: (await finished(creator)).id, title: "Candle Toast", description: "", tags: [], isVip: false });
    const mine = await finished(member, { templateId: t.id });
    const theirs = await finished(creator, { templateId: t.id });

    await getDb().update(templates).set({ status: "unpublished" }).where(eq(templates.id, t.id));
    expect((await generatePrefill(member.id, "image", { from: mine.id }))!.templateId).toBeUndefined();
    // The creator can still make from their own unpublished template.
    expect((await generatePrefill(creator.id, "image", { from: theirs.id }))!.templateId).toBe(t.id);

    await getDb().update(templates).set({ status: "published", isVip: true }).where(eq(templates.id, t.id));
    const withoutPass = await generatePrefill(member.id, "image", { from: mine.id });
    expect(withoutPass).toMatchObject({ parentJobId: mine.id, relation: "remix" });
    expect(withoutPass!.templateId).toBeUndefined();
    await getDb().insert(subscriptions).values({ userId: member.id, provider: "sandbox", providerSubscriptionId: `sub_${member.id}`, planKey: "plan_member", status: "active", currentPeriodEnd: new Date(Date.now() + 86_400_000) });
    expect((await generatePrefill(member.id, "image", { from: mine.id }))!.templateId).toBe(t.id);
  });

  it("carries the character and never prefills from someone else's or a deleted creation", async () => {
    const member = await makeUser({ credits: 50 });
    const other = await makeUser({ credits: 50 });
    const ch = await createCharacter(member.id, { bytes: await png(), declaredMime: "image/png" }, "Ari", null);
    const withChar = await finished(member, { mode: "reference_guided", characterReferenceId: ch.id });
    expect(await generatePrefill(member.id, "image", { from: withChar.id })).toMatchObject({ mode: "reference_guided", characterReferenceId: ch.id });

    expect(await generatePrefill(other.id, "image", { from: withChar.id })).toBeUndefined();
    await deleteJob(member, withChar.id);
    expect(await generatePrefill(member.id, "image", { from: withChar.id })).toBeUndefined();
  });

  it("makes only offered values into scene settings and keeps the rest in the prompt", async () => {
    const member = await makeUser();
    const project = await createProject(member.id, { title: "Night in", description: "" });
    const scene = await addScene(member.id, project.id, { title: "By the window", continuity: { lighting: "golden hour", framing: "dutch tilt", palette: "amber" } });
    const prefill = await generatePrefill(member.id, "image", { scene: scene.id });
    expect(prefill!.params).toEqual({ lighting: "golden hour" });
    expect(prefill!.prompt).toBe("By the window. golden hour lighting, dutch tilt framing, amber palette");
    expect(prefill).toMatchObject({ projectId: project.id, sceneId: scene.id });
  });
});

describe("presets saved while composing", () => {
  it("keep the look without the seed and accept only offered values", async () => {
    const user = await makeUser();
    const input = presetSchema.parse({ name: "Candle", mode: "text_to_image", modelKey: "demo-still", prompt: "warm toast", params: { aspectRatio: "4:5", lighting: "candlelit", seed: 42 } });
    const preset = await createPreset(user.id, input);
    expect(preset.params).toEqual({ aspectRatio: "4:5", lighting: "candlelit" });
    expect(presetSchema.safeParse({ name: "Bad", mode: "text_to_image", modelKey: "demo-still", params: { lighting: "strobe" } }).success).toBe(false);
  });
});

describe("publishing checks the settings too", () => {
  it("refuses a recipe whose stored free-text setting breaks the content policy", async () => {
    const user = await makeUser({ credits: 50 });
    const job = await finished(user);
    // A job stored before the closed lists and the atmosphere check.
    await getDb().update(generationJobs).set({ params: { ...job.params, atmosphere: "a 16 yo vibe" } }).where(eq(generationJobs.id, job.id));
    await expect(publishTemplate(user, { jobId: job.id, title: "Recipe", description: "", tags: [], isVip: false })).rejects.toMatchObject({ status: 422, code: "policy_blocked" });
    const events = await getDb().select().from(moderationEvents).where(eq(moderationEvents.subjectId, job.id));
    expect(events.map((e) => e.reason)).toEqual(["minors"]);
    expect(await getDb().select().from(templates)).toHaveLength(0);
  });
});

describe("video uploads", () => {
  it("are stored without their container metadata", async () => {
    const user = await makeUser();
    const dir = mkdtempSync(path.join(os.tmpdir(), "hl-test-"));
    try {
      const file = path.join(dir, "in.mp4");
      const made = spawnSync("ffmpeg", [
        "-v", "error", "-f", "lavfi", "-i", "color=c=0x553344:s=128x128:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-metadata", "title=HushloomSecretTitle", "-metadata", "comment=HushloomSecretPlace", "-f", "mp4", file,
      ]);
      expect(made.status).toBe(0);
      const original = readFileSync(file);
      expect(original.includes("HushloomSecretTitle")).toBe(true);

      const up = await acceptUpload(user.id, { bytes: original, declaredMime: "video/mp4" }, { statement: "x", subjectLabel: null }, "source");
      const [asset] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, up.assetId));
      const stored = await storage().get(asset!.storageKey);
      expect(stored.subarray(4, 8).toString("ascii")).toBe("ftyp");
      expect(stored.includes("HushloomSecretTitle")).toBe(false);
      expect(stored.includes("HushloomSecretPlace")).toBe(false);
      expect(asset!.bytes).toBe(stored.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a file that only claims to be an MP4", async () => {
    const user = await makeUser();
    const fake = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(2048, 7)]);
    await expect(acceptUpload(user.id, { bytes: fake, declaredMime: "video/mp4" }, { statement: "x", subjectLabel: null }, "source")).rejects.toMatchObject({ status: 415, code: "unsupported_type" });
    expect(await getDb().select().from(mediaAssets)).toHaveLength(0);
  });
});
