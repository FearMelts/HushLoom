import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { createSession, userForToken, type SessionUser } from "@/server/auth/session";
import { closeDb, getDb } from "@/server/db";
import { accountFlags, auditLogs, generationJobs, generationOutputs, mediaAssets, moderationEvents, takedownRequests, templates, users } from "@/server/db/schema";
import { confirmJob, createDraft } from "@/server/generation/service";
import { processJob } from "@/server/generation/processor";
import { closeRedis } from "@/server/redis";
import { resolveEscalation } from "@/server/safety/review";
import { resolveTakedown, type TakedownCategory } from "@/server/safety/takedowns";
import { publishTemplate } from "@/server/templates/publish";
import { key, makeUser, resetDb } from "../helpers";

const ctx = { country: null };

async function finished(user: SessionUser, overrides: Record<string, unknown> = {}) {
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
  return draft;
}

const publish = (user: SessionUser, jobId: string, title = "Reported Look") => publishTemplate(user, { jobId, title, description: "", tags: [], isVip: false });

async function takedown(targetType: "template" | "output" | "asset", targetRef: string, category: TakedownCategory) {
  const [row] = await getDb().insert(takedownRequests).values({ requesterEmail: "me@example.test", targetType, targetRef, category }).returning();
  return row!;
}

const sourceOf = async (jobId: string) => {
  const [out] = await getDb().select().from(generationOutputs).where(eq(generationOutputs.jobId, jobId));
  const [asset] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, out!.assetId));
  return { out: out!, asset: asset! };
};

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("R08 takedowns reach every copy of the creation", () => {
  it("an actioned template takedown takes down the source creation, so the creator cannot publish it again", async () => {
    const admin = await makeUser({ role: "admin" });
    for (const category of ["ncii", "copyright"] as const) {
      const creator = await makeUser({ credits: 50 });
      const job = await finished(creator);
      const t = await publish(creator, job.id);
      const req = await takedown("template", t.slug, category);
      await resolveTakedown(admin.id, req.id, { action: "action", note: "Confirmed with requester" });

      // The same creation cannot go straight back up under a new slug.
      await expect(publish(creator, job.id, "Back again")).rejects.toMatchObject({ status: 404 });
      const live = await getDb().select().from(templates).where(and(eq(templates.creatorId, creator.id), eq(templates.status, "published")));
      expect(live).toHaveLength(0);
      const { out, asset } = await sourceOf(job.id);
      expect(out.deletedAt).not.toBeNull();
      expect(asset.deletedAt).not.toBeNull();
      // Intimate images go at once, the private source included; other categories wait for the usual purge.
      expect(asset.storageKey.startsWith("purged/")).toBe(category === "ncii");
    }
  });

  it("takes down every template made from the same creation, whichever copy the request names", async () => {
    const admin = await makeUser({ role: "admin" });
    const creator = await makeUser({ credits: 50 });
    const job = await finished(creator);
    const first = await publish(creator, job.id, "First copy");
    const second = await publish(creator, job.id, "Second copy");
    const other = await publish(creator, (await finished(creator, { params: { aspectRatio: "1:1", seed: 4242 } })).id, "Unrelated");

    await resolveTakedown(admin.id, (await takedown("template", first.id, "ncii")).id, { action: "action", note: "" });
    const status = async (id: string) => (await getDb().select({ s: templates.status }).from(templates).where(eq(templates.id, id)))[0]!.s;
    expect(await status(first.id)).toBe("removed");
    expect(await status(second.id)).toBe("removed");
    expect(await status(other.id)).toBe("published");

    // Named by its creation instead: the template published from it comes down too.
    const job2 = await finished(creator, { params: { aspectRatio: "1:1", seed: 777 } });
    const fromOutput = await publish(creator, job2.id, "From output");
    await resolveTakedown(admin.id, (await takedown("output", job2.id, "likeness")).id, { action: "action", note: "" });
    expect(await status(fromOutput.id)).toBe("removed");
    expect(await status(other.id)).toBe("published");
  });

  it("an actioned CSAM takedown holds the source and suspends the owner, as a scanner match does", async () => {
    const admin = await makeUser({ role: "admin" });
    const creator = await makeUser({ credits: 50 });
    const { token } = await createSession(creator.id, null);
    const job = await finished(creator);
    const t = await publish(creator, job.id);
    const req = await takedown("template", t.id, "csam");
    await resolveTakedown(admin.id, req.id, { action: "action", note: "" });

    // Evidence: the public copy and the private source are both held, hidden and never purged.
    const { asset: source } = await sourceOf(job.id);
    expect(source).toMatchObject({ legalHold: true });
    expect(source.deletedAt).not.toBeNull();
    const escalations = await getDb().select().from(moderationEvents).where(and(eq(moderationEvents.action, "escalate"), eq(moderationEvents.status, "open")));
    expect(escalations.map((e) => e.subjectId).sort()).toEqual([source.id, t.posterAssetId!].sort());
    expect(escalations.every((e) => e.reason === "csam_report")).toBe(true);

    // The account: suspended, signed out everywhere, flagged once per case, audited.
    const [row] = await getDb().select().from(users).where(eq(users.id, creator.id));
    expect(row!.status).toBe("suspended");
    expect(await userForToken(token)).toBeNull();
    const flags = await getDb().select().from(accountFlags).where(and(eq(accountFlags.userId, creator.id), isNull(accountFlags.clearedAt)));
    expect(flags.map((f) => f.kind)).toEqual(["csam_match", "csam_match"]);
    expect(flags.map((f) => f.details.escalationId).sort()).toEqual(escalations.map((e) => e.id).sort());
    const [suspension] = await getDb().select().from(auditLogs).where(and(eq(auditLogs.action, "user.suspend"), eq(auditLogs.targetId, creator.id)));
    expect(suspension).toBeTruthy();
    await expect(publish(creator, job.id, "Back again")).rejects.toMatchObject({ status: 404 });

    // Confirming one case keeps the account suspended even after the other is cleared.
    const [a, b] = escalations;
    await resolveEscalation(admin.id, a!.id, { action: "confirm", reportRef: "CT-2026-000777", reportedTo: "ncmec_cybertipline", note: "" });
    await resolveEscalation(admin.id, b!.id, { action: "clear", note: "Duplicate of the confirmed case" });
    const [after] = await getDb().select().from(users).where(eq(users.id, creator.id));
    expect(after!.status).toBe("suspended");
    const jobs = await getDb().select().from(generationJobs).where(inArray(generationJobs.id, [job.id]));
    expect(jobs[0]!.deletedAt).not.toBeNull();
  });
});
