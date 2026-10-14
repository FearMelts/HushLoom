import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { suspendUser } from "@/server/admin";
import { createSession, userForToken, type SessionUser } from "@/server/auth/session";
import { closeDb, getDb, type Tx } from "@/server/db";
import {
  accountFlags,
  auditLogs,
  generationJobs,
  generationOutputs,
  mediaAssets,
  moderationEvents,
  takedownRequests,
  templates,
  templateVersions,
  users,
} from "@/server/db/schema";
import { confirmJob, createDraft } from "@/server/generation/service";
import { processJob } from "@/server/generation/processor";
import { purgeDeletedMedia } from "@/server/media";
import { closeRedis } from "@/server/redis";
import { resolveEscalation } from "@/server/safety/review";
import { recordVerdict } from "@/server/safety/scan";
import { resolveTakedown, type TakedownCategory } from "@/server/safety/takedowns";
import { publishTemplate, updateTemplate } from "@/server/templates/publish";
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

/** Waits until `n` other connections to this database are blocked on a lock (a request mid-flight). */
async function lockWaiters(n: number) {
  for (let i = 0; i < 250; i++) {
    const [row] = await getDb().execute<{ n: number }>(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
    if (row!.n >= n) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`expected ${n} blocked requests`);
}

/** Runs `change` in a transaction that stays open until `inFlight` requests are blocked behind it, then commits. */
async function whileInFlight<T>(change: (tx: Tx) => Promise<void>, start: () => Promise<T>[]) {
  let pending: Promise<T | unknown>[] = [];
  await getDb().transaction(async (tx) => {
    await change(tx);
    pending = start().map((p) => p.catch((e: unknown) => e));
    await lockWaiters(pending.length);
  });
  return Promise.all(pending);
}

describe("R11 template edits never write back what they read before a concurrent change", () => {
  async function published() {
    const creator = await makeUser({ credits: 50 });
    const t = await publish(creator, (await finished(creator)).id, "Edited Look");
    const row = async () => (await getDb().select().from(templates).where(eq(templates.id, t.id)))[0]!;
    return { creator, t, row };
  }

  it("an edit in flight while moderation removes the template does not put it back up", async () => {
    const { creator, t, row } = await published();
    const [result] = await whileInFlight(
      async (tx) => void (await tx.update(templates).set({ status: "removed", updatedAt: new Date() }).where(eq(templates.id, t.id))),
      () => [updateTemplate(creator, t.id, { title: "Harmless rename" })],
    );
    expect((await row()).status).toBe("removed");
    expect(result).toMatchObject({ status: 403, code: "removed" });
  });

  it("an edit in flight while the creator is suspended does not republish their template", async () => {
    const { creator, t, row } = await published();
    const suspend = async (tx: Tx) => {
      await tx.update(users).set({ status: "suspended" }).where(eq(users.id, creator.id));
      await tx.update(templates).set({ status: "unpublished" }).where(eq(templates.creatorId, creator.id));
    };
    await whileInFlight(suspend, () => [updateTemplate(creator, t.id, { title: "Harmless rename" })]);
    expect((await row())).toMatchObject({ status: "unpublished", title: "Harmless rename" });
    // Even asked for outright, a suspended creator's template stays down.
    await expect(updateTemplate(creator, t.id, { status: "published" })).rejects.toMatchObject({ status: 403 });
    expect((await row()).status).toBe("unpublished");
  });

  it("a metadata edit keeps a prompt version made meanwhile, and two prompt edits both land", async () => {
    const { creator, t, row } = await published();
    await whileInFlight(
      async (tx) => {
        await tx.insert(templateVersions).values({ templateId: t.id, version: 2, prompt: "a newer recipe", modelKey: "demo-still", defaults: {}, changelog: "v2" });
        await tx.update(templates).set({ currentVersion: 2 }).where(eq(templates.id, t.id));
      },
      () => [updateTemplate(creator, t.id, { title: "Renamed meanwhile" })],
    );
    expect(await row()).toMatchObject({ title: "Renamed meanwhile", currentVersion: 2 });

    const results = await whileInFlight(
      async (tx) => void (await tx.select().from(templates).where(eq(templates.id, t.id)).for("update")),
      () => [updateTemplate(creator, t.id, { prompt: "recipe three" }), updateTemplate(creator, t.id, { prompt: "recipe four" })],
    );
    expect(results.every((r) => !(r instanceof Error))).toBe(true);
    const versions = await getDb().select().from(templateVersions).where(eq(templateVersions.templateId, t.id));
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2, 3, 4]);
    expect((await row()).currentVersion).toBe(4);
  });
});

describe("R21 clearing a false positive lifts only what that case caused", () => {
  /** A later scan of a creation the account already has (a backfill), matching it as CSAM. */
  async function scannerMatch(owner: SessionUser, jobId?: string) {
    const { asset } = await sourceOf(jobId ?? (await finished(owner)).id);
    await recordVerdict({ assetId: asset.id, mime: asset.mime, kind: "image", sha256: asset.sha256, ownerId: owner.id, origin: "backfill" }, { status: "matched", provider: "dev", ref: "drill", category: "csam" });
    const [esc] = await getDb().select().from(moderationEvents).where(and(eq(moderationEvents.action, "escalate"), eq(moderationEvents.subjectId, asset.id)));
    return { asset, esc: esc! };
  }
  const statusOf = async (id: string) => (await getDb().select({ s: users.status }).from(users).where(eq(users.id, id)))[0]!.s;

  it("keeps an admin's suspension when a match made afterwards is cleared", async () => {
    const admin = await makeUser({ role: "admin" });
    const u = await makeUser({ credits: 50 });
    const job = await finished(u);
    await suspendUser(admin.id, u.id, "Harassment reports");
    const { esc } = await scannerMatch(u, job.id);

    await resolveEscalation(admin.id, esc.id, { action: "clear", note: "Drill fixture, not real material" });
    expect(await statusOf(u.id)).toBe("suspended");
    expect(await getDb().select().from(auditLogs).where(and(eq(auditLogs.action, "user.reinstate"), eq(auditLogs.targetId, u.id)))).toHaveLength(0);
  });

  it("lets an admin add a reason to an account a match suspended, and clearing the match keeps it", async () => {
    const admin = await makeUser({ role: "admin" });
    const u = await makeUser({ credits: 50 });
    const { esc } = await scannerMatch(u);
    expect(await statusOf(u.id)).toBe("suspended");

    await expect(suspendUser(admin.id, u.id, "Separate harassment reports")).resolves.toMatchObject({ unpublishedTemplates: expect.any(Number) });
    await resolveEscalation(admin.id, esc.id, { action: "clear", note: "Drill fixture, not real material" });
    expect(await statusOf(u.id)).toBe("suspended");
  });

  it("clearing a duplicate case keeps the hold a confirmed case on the same file needs", async () => {
    const admin = await makeUser({ role: "admin" });
    const creator = await makeUser({ credits: 50 });
    const t = await publish(creator, (await finished(creator)).id);
    // Two people report the same template; both requests are actioned.
    for (const email of ["one@example.test", "two@example.test"]) {
      const [req] = await getDb().insert(takedownRequests).values({ requesterEmail: email, targetType: "template", targetRef: t.id, category: "csam" }).returning();
      await resolveTakedown(admin.id, req!.id, { action: "action", note: "" });
    }
    const cases = await getDb().select().from(moderationEvents).where(and(eq(moderationEvents.action, "escalate"), eq(moderationEvents.subjectId, t.posterAssetId!)));
    expect(cases).toHaveLength(2);
    await resolveEscalation(admin.id, cases[0]!.id, { action: "confirm", reportRef: "CT-2026-000888", reportedTo: "ncmec_cybertipline", note: "" });
    await resolveEscalation(admin.id, cases[1]!.id, { action: "clear", note: "Duplicate of the confirmed report" });

    const [evidence] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, t.posterAssetId!));
    expect(evidence).toMatchObject({ legalHold: true });
    await getDb().update(mediaAssets).set({ deletedAt: new Date(Date.now() - 90 * 86_400_000) }).where(eq(mediaAssets.id, t.posterAssetId!));
    expect(await purgeDeletedMedia(30)).toBe(0);
    expect(await statusOf(creator.id)).toBe("suspended");
  });
});
