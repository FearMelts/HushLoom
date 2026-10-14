import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { resolveReport, suspendUser } from "@/server/admin";
import type { SessionUser } from "@/server/auth/session";
import { closeDb, getDb } from "@/server/db";
import { generationOutputs, mediaAssets, moderationEvents, takedownRequests, templates, users } from "@/server/db/schema";
import { confirmJob, createDraft, deleteJob, deriveDraft } from "@/server/generation/service";
import { processJob } from "@/server/generation/processor";
import { closeRedis } from "@/server/redis";
import { recordVerdict } from "@/server/safety/scan";
import { resolveTakedown, type TakedownCategory } from "@/server/safety/takedowns";
import { storage } from "@/server/storage";
import { publishTemplate, updateTemplate } from "@/server/templates/publish";
import { key, makeUser, resetDb } from "../helpers";

/**
 * Attack tests for the moderation fixes R08 (takedowns reach every copy of a creation) and R11
 * (template edits lock the row and write only what they were given). Each test tries to get
 * content a takedown or a suspension took down back up through another entry point, another input
 * or another interleaving. Tests marked `it.fails` are holes: they assert the safe outcome and
 * fail today; the comment above each one names the hole.
 */

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

const publish = (user: SessionUser, jobId: string, title = "Reported Look", categorySlug?: string) =>
  publishTemplate(user, { jobId, title, description: "", tags: [], isVip: false, ...(categorySlug ? { categorySlug } : {}) });

async function takedown(targetType: "template" | "output" | "asset" | "url", targetRef: string, category: TakedownCategory) {
  const [row] = await getDb().insert(takedownRequests).values({ requesterEmail: "me@example.test", targetType, targetRef, category }).returning();
  return row!;
}

const action = (adminId: string, takedownId: string) => resolveTakedown(adminId, takedownId, { action: "action", note: "Confirmed with requester" });

const sourceOf = async (jobId: string) => {
  const [out] = await getDb().select().from(generationOutputs).where(eq(generationOutputs.jobId, jobId));
  const [asset] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, out!.assetId));
  return { out: out!, asset: asset! };
};

const templateRow = async (id: string) => (await getDb().select().from(templates).where(eq(templates.id, id)))[0]!;
const userStatus = async (id: string) => (await getDb().select({ s: users.status }).from(users).where(eq(users.id, id)))[0]!.s;
const liveTemplates = (creatorId: string) =>
  getDb()
    .select()
    .from(templates)
    .where(and(eq(templates.creatorId, creatorId), eq(templates.status, "published"), isNull(templates.deletedAt)));

/** Waits until `n` connections to this database are blocked on a lock (requests mid-flight). */
async function lockWaiters(n: number) {
  for (let i = 0; i < 250; i++) {
    const [row] = await getDb().execute<{ n: number }>(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
    if (row!.n >= n) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`expected ${n} blocked requests`);
}

/**
 * Forces the race window a slow request has in production (a storage copy, a slow query): the
 * request is started and parked on its read of template_categories (both publishTemplate and
 * updateTemplate read it, after every check they make and before they write), `meanwhile` runs
 * to completion on its own connection, and then the request is let go.
 */
async function parkedAcross<T>(request: () => Promise<T>, meanwhile: () => Promise<unknown>): Promise<T | unknown> {
  let pending!: Promise<T | unknown>;
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`lock table template_categories in access exclusive mode`);
    pending = request().catch((e: unknown) => e);
    await lockWaiters(1);
    await meanwhile();
  });
  return pending;
}

/** Holds the template's row lock until `n` requests queue behind it, then lets them run in queue order. */
async function queuedOnTemplate(templateId: string, starts: (() => Promise<unknown>)[]) {
  const pending: Promise<unknown>[] = [];
  await getDb().transaction(async (tx) => {
    await tx.select().from(templates).where(eq(templates.id, templateId)).for("update");
    for (const [i, start] of starts.entries()) {
      pending.push(start().catch((e: unknown) => e));
      await lockWaiters(i + 1);
    }
  });
  return Promise.all(pending);
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("R08 attack: getting a taken-down creation back up", () => {
  // Was a hole (R08): takeDownCopies only reaches copies that exist when the takedown is actioned,
  // so the creator regenerated the same prompt with the same seed (shown on their own creation),
  // got byte-identical bytes and published them straight back under a new slug after an NCII
  // takedown. Closed: the takedown records the SHA-256 of what it removed and publishing refuses it.
  it("regenerating the same prompt and seed after an NCII takedown cannot be published again", async () => {
    const admin = await makeUser({ role: "admin" });
    const creator = await makeUser({ credits: 50 });
    const params = { aspectRatio: "1:1", seed: 24680 };
    const job = await finished(creator, { params });
    const t = await publish(creator, job.id);
    await action(admin.id, (await takedown("template", t.slug, "ncii")).id);
    expect((await templateRow(t.id)).status).toBe("removed");

    const again = await finished(creator, { params });
    // The new creation is the very same file the takedown removed.
    expect((await sourceOf(again.id)).asset.sha256).toBe((await sourceOf(job.id)).asset.sha256);
    await expect(publish(creator, again.id, "Back again")).rejects.toMatchObject({ status: expect.any(Number) });
    expect(await liveTemplates(creator.id)).toHaveLength(0);
  });

  // Was a hole (R08): the same gap through the Library's own Retry button. A retry draft made before
  // the takedown keeps the source's seed; confirmJob does not look at the (now deleted) parent, so it
  // runs after the takedown and yields the identical file. Closed by the same SHA-256 check at publish.
  it("a retry drafted before the takedown and confirmed after it cannot put the same file back up", async () => {
    const admin = await makeUser({ role: "admin" });
    const creator = await makeUser({ credits: 50 });
    const job = await finished(creator);
    const t = await publish(creator, job.id);
    const retry = await deriveDraft(creator, job.id, "retry", key(), ctx);
    await action(admin.id, (await takedown("template", t.id, "ncii")).id);

    await confirmJob(creator, retry.id, retry.costCredits);
    await processJob(retry.id);
    expect((await sourceOf(retry.id)).asset.sha256).toBe((await sourceOf(job.id)).asset.sha256);
    await expect(publish(creator, retry.id, "Retried")).rejects.toMatchObject({ status: expect.any(Number) });
    expect(await liveTemplates(creator.id)).toHaveLength(0);
  });

  // HOLE (R08): takeDownCopies only matches the same owner's assets. A second account that made the
  // byte-identical file (same prompt and seed) keeps its public template live after the NCII
  // takedown of the first, though it is the same image the request is about.
  it.fails("an NCII takedown also reaches a byte-identical public copy another account published", async () => {
    const admin = await makeUser({ role: "admin" });
    const creator = await makeUser({ credits: 50 });
    const puppet = await makeUser({ credits: 50 });
    const params = { aspectRatio: "1:1", seed: 13579 };
    const a = await finished(creator, { params });
    const b = await finished(puppet, { params });
    expect((await sourceOf(b.id)).asset.sha256).toBe((await sourceOf(a.id)).asset.sha256);
    const ta = await publish(creator, a.id, "Original");
    const tb = await publish(puppet, b.id, "Mirror");

    await action(admin.id, (await takedown("template", ta.id, "ncii")).id);
    expect((await templateRow(ta.id)).status).toBe("removed");
    expect((await templateRow(tb.id)).status).not.toBe("published");
  });

  // HOLE (R08): publishTemplate checks the job and its output, copies the bytes, and only then
  // writes, in a transaction that re-checks nothing. A publish in flight while the takedown commits
  // (the window is the storage copy) creates a new live template from the deleted source.
  it.fails("a publish in flight while an NCII takedown is actioned does not create a live copy", async () => {
    const admin = await makeUser({ role: "admin" });
    const creator = await makeUser({ credits: 50 });
    const job = await finished(creator);
    const t = await publish(creator, job.id);
    const req = await takedown("template", t.id, "ncii");

    const result = await parkedAcross(
      () => publish(creator, job.id, "Back again", "any-category"),
      () => action(admin.id, req.id),
    );
    expect((await sourceOf(job.id)).out.deletedAt).not.toBeNull();
    expect(result).toBeInstanceOf(Error);
    expect(await liveTemplates(creator.id)).toHaveLength(0);
  });

  // HOLE (R08): the same race on a CSAM takedown. The source is held as evidence and the owner is
  // suspended and signed out, yet the request already past requireUser writes a fresh public copy
  // marked clean and not held, and a published template that shows it.
  it.fails("a publish in flight while a CSAM takedown is actioned does not make the held file public", async () => {
    const admin = await makeUser({ role: "admin" });
    const creator = await makeUser({ credits: 50 });
    const job = await finished(creator);
    const t = await publish(creator, job.id);
    const req = await takedown("template", t.id, "csam");

    await parkedAcross(
      () => publish(creator, job.id, "Back again", "any-category"),
      () => action(admin.id, req.id),
    );
    const { asset: source } = await sourceOf(job.id);
    expect(source.legalHold).toBe(true);
    expect(await userStatus(creator.id)).toBe("suspended");
    const exposed = await getDb()
      .select()
      .from(mediaAssets)
      .where(and(eq(mediaAssets.sha256, source.sha256), eq(mediaAssets.visibility, "public"), isNull(mediaAssets.deletedAt), eq(mediaAssets.legalHold, false)));
    expect((await liveTemplates(creator.id)).map((x) => x.title)).toEqual([]);
    expect(exposed).toHaveLength(0);
  });

  it("holds: Retry or Variation of a taken-down creation is refused", async () => {
    const admin = await makeUser({ role: "admin" });
    const creator = await makeUser({ credits: 50 });
    const job = await finished(creator);
    const t = await publish(creator, job.id);
    await action(admin.id, (await takedown("template", t.id, "likeness")).id);
    for (const relation of ["retry", "variation"] as const) {
      await expect(deriveDraft(creator, job.id, relation, key(), ctx)).rejects.toMatchObject({ status: 404 });
    }
    // Nor can the held or deleted output be used as an input for a new creation.
    const { asset } = await sourceOf(job.id);
    await expect(
      createDraft(
        creator,
        { idempotencyKey: key(), mode: "image_to_image", modelKey: "demo-still", prompt: "same scene, new light", negativePrompt: "", params: { aspectRatio: "1:1" }, inputAssetIds: [asset.id] },
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("holds: whichever way the request names the creation (public asset id, template link, output id), every copy comes down", async () => {
    const admin = await makeUser({ role: "admin" });
    const creator = await makeUser({ credits: 80 });
    const unrelated = await publish(creator, (await finished(creator, { params: { aspectRatio: "1:1", seed: 99 } })).id, "Unrelated");

    const namings: ((t: { id: string; slug: string; posterAssetId: string | null }, jobId: string, outputId: string) => [Parameters<typeof takedown>[0], string])[] = [
      (t) => ["asset", t.posterAssetId!],
      (t) => ["url", `  https://example.test/templates/${encodeURIComponent(t.slug)}?utm_source=share#top  `],
      (_t, _job, outputId) => ["output", outputId],
    ];
    for (const [i, naming] of namings.entries()) {
      const job = await finished(creator, { params: { aspectRatio: "1:1", seed: 1000 + i } });
      const first = await publish(creator, job.id, "First copy");
      const second = await publish(creator, job.id, "Second copy");
      const { out } = await sourceOf(job.id);
      const [targetType, ref] = naming(first, job.id, out.id);
      await action(admin.id, (await takedown(targetType, ref, "ncii")).id);

      expect((await templateRow(first.id)).status).toBe("removed");
      expect((await templateRow(second.id)).status).toBe("removed");
      const { asset } = await sourceOf(job.id);
      expect(asset.storageKey.startsWith("purged/")).toBe(true);
      await expect(publish(creator, job.id, "Back again")).rejects.toMatchObject({ status: 404 });
    }
    expect((await templateRow(unrelated.id)).status).toBe("published");
  });

  it("holds: a template the creator unpublished, or a creation they deleted, before the takedown is still reached and purged", async () => {
    const admin = await makeUser({ role: "admin" });
    const creator = await makeUser({ credits: 50 });
    const job = await finished(creator);
    const hidden = await publish(creator, job.id, "Hidden");
    const live = await publish(creator, job.id, "Live");
    await updateTemplate(creator, hidden.id, { status: "unpublished" });
    // The creator deletes the source from their Library first, hoping the request finds nothing private.
    await deleteJob(creator, job.id);

    await action(admin.id, (await takedown("template", hidden.slug, "ncii")).id);
    expect((await templateRow(hidden.id)).status).toBe("removed");
    expect((await templateRow(live.id)).status).toBe("removed");
    const { asset } = await sourceOf(job.id);
    expect(asset.storageKey.startsWith("purged/")).toBe(true);
    const publicCopy = (await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, live.posterAssetId!)))[0]!;
    expect(publicCopy.storageKey.startsWith("purged/")).toBe(true);
  });

  it("holds: a video template's clip and poster frame are both traced back to the source and purged", async () => {
    const admin = await makeUser({ role: "admin" });
    const creator = await makeUser({ credits: 200 });
    const job = await finished(creator, { mode: "text_to_video", modelKey: "demo-motion", params: { aspectRatio: "9:16", durationS: 3 } });
    const t = await publish(creator, job.id, "Clip");
    expect(t.previewAssetId).toBeTruthy();
    expect(t.posterAssetId).toBeTruthy();
    const { out } = await sourceOf(job.id);
    expect(out.posterAssetId).toBeTruthy();

    await action(admin.id, (await takedown("template", t.id, "ncii")).id);
    const ids = [out.assetId, out.posterAssetId!, t.previewAssetId!, t.posterAssetId!];
    const rows = await Promise.all(ids.map(async (id) => (await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, id)))[0]!));
    for (const r of rows) {
      expect(r.deletedAt).not.toBeNull();
      expect(r.storageKey.startsWith("purged/")).toBe(true);
    }
    await expect(storage().get(rows[0]!.storageKey)).rejects.toBeTruthy();
    await expect(publish(creator, job.id, "Back again")).rejects.toMatchObject({ status: 404 });
  });
});

describe("R11 attack: undoing a removal or suspension through a template edit", () => {
  async function setup() {
    const admin = await makeUser({ role: "admin" });
    const creator = await makeUser({ credits: 50 });
    const t = await publish(creator, (await finished(creator)).id, "Edited Look");
    return { admin, creator, t };
  }

  // HOLE (R11): the creator_suspended check reads users.status without a lock, so it is a
  // check-then-act. A creator who has a template unpublished and asks to publish it at the moment
  // an admin suspends them: the suspension's "unpublish everything live" skips the row (it is not
  // published yet), commits, and the edit then writes status=published for a suspended account.
  it.fails("publishing an unpublished template in flight while an admin suspends the creator leaves nothing live", async () => {
    const { admin, creator, t } = await setup();
    await updateTemplate(creator, t.id, { status: "unpublished" });

    await parkedAcross(
      () => updateTemplate(creator, t.id, { status: "published", categorySlug: "any-category" }),
      () => suspendUser(admin.id, creator.id, "Harassment reports"),
    );
    expect(await userStatus(creator.id)).toBe("suspended");
    expect((await templateRow(t.id)).status).not.toBe("published");
  });

  // HOLE (R11): the same check-then-act against the abuse suspension (a scanner match on one of the
  // creator's private creations, which suspends and unpublishes through suspendForAbuse).
  it.fails("publishing an unpublished template in flight while a scanner match suspends the creator leaves nothing live", async () => {
    const { creator, t } = await setup();
    await updateTemplate(creator, t.id, { status: "unpublished" });
    const { asset } = await sourceOf((await finished(creator, { params: { aspectRatio: "1:1", seed: 31337 } })).id);

    await parkedAcross(
      () => updateTemplate(creator, t.id, { status: "published", categorySlug: "any-category" }),
      () =>
        recordVerdict(
          { assetId: asset.id, mime: asset.mime, kind: "image", sha256: asset.sha256, ownerId: creator.id, origin: "backfill" },
          { status: "matched", provider: "dev", ref: "drill", category: "csam" },
        ),
    );
    expect(await userStatus(creator.id)).toBe("suspended");
    expect((await templateRow(t.id)).status).not.toBe("published");
  });

  // HOLE (R11, other entry point): POST /api/templates (publishTemplate) never checks the creator's
  // account status at all. A publish already past requireUser when the suspension commits creates
  // a brand-new published template for the suspended account.
  it.fails("a new publish in flight while an admin suspends the creator leaves nothing live", async () => {
    const { admin, creator } = await setup();
    const job = await finished(creator, { params: { aspectRatio: "1:1", seed: 4321 } });

    await parkedAcross(
      () => publish(creator, job.id, "Slipped through", "any-category"),
      () => suspendUser(admin.id, creator.id, "Harassment reports"),
    );
    expect(await userStatus(creator.id)).toBe("suspended");
    expect(await liveTemplates(creator.id)).toHaveLength(0);
  });

  it("holds: an edit queued with a real takedown, in either order, never puts the template back up", async () => {
    for (const editFirst of [true, false]) {
      await resetDb();
      const { admin, creator, t } = await setup();
      const req = await takedown("template", t.id, "copyright");
      const edit = () => updateTemplate(creator, t.id, { title: "Harmless rename", status: "published" });
      const take = () => action(admin.id, req.id);
      await queuedOnTemplate(t.id, editFirst ? [edit, take] : [take, edit]);
      expect(await templateRow(t.id)).toMatchObject({ status: "removed" });
      expect((await templateRow(t.id)).deletedAt).not.toBeNull();
    }
  });

  it("holds: an edit queued with a report removal, in either order, never puts the template back up", async () => {
    for (const editFirst of [true, false]) {
      await resetDb();
      const { admin, creator, t } = await setup();
      const [report] = await getDb()
        .insert(moderationEvents)
        .values({ subjectType: "template", subjectId: t.id, action: "report", status: "open", reason: "non_consent", details: { note: "" } })
        .returning();
      const edit = () => updateTemplate(creator, t.id, { tags: ["harmless"], status: "published" });
      const remove = () => resolveReport(admin.id, report!.id, { action: "remove", note: "" });
      const results = await queuedOnTemplate(t.id, editFirst ? [edit, remove] : [remove, edit]);
      expect((await templateRow(t.id)).status).toBe("removed");
      if (!editFirst) expect(results[1]).toMatchObject({ status: 403, code: "removed" });
      // And asked again afterwards, in any shape, it stays removed.
      for (const input of [{ status: "published" as const }, { status: "unpublished" as const }, { title: "Try again" }, {}]) {
        await expect(updateTemplate(creator, t.id, input)).rejects.toMatchObject({ status: 403, code: "removed" });
      }
      expect((await templateRow(t.id)).status).toBe("removed");
    }
  });

  it("holds: a template the scanner took down cannot be republished, and an admin cannot republish a suspended creator's template", async () => {
    const { admin, creator, t } = await setup();
    const [poster] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, t.posterAssetId!));
    await recordVerdict(
      { assetId: poster!.id, mime: poster!.mime, kind: "image", sha256: poster!.sha256, ownerId: creator.id, origin: "backfill" },
      { status: "matched", provider: "dev", ref: "drill", category: "abuse" },
    );
    expect((await templateRow(t.id)).status).toBe("removed");
    await expect(updateTemplate(creator, t.id, { status: "published" })).rejects.toMatchObject({ status: 403, code: "removed" });

    const other = await publish(creator, (await finished(creator, { params: { aspectRatio: "1:1", seed: 777 } })).id, "Other");
    await suspendUser(admin.id, creator.id, "Harassment reports");
    expect((await templateRow(other.id)).status).toBe("unpublished");
    await expect(updateTemplate(admin, other.id, { status: "published" })).rejects.toMatchObject({ status: 403, code: "creator_suspended" });
    // A metadata-only edit by the admin is allowed and does not change the status.
    await expect(updateTemplate(admin, other.id, { title: "Renamed by staff" })).resolves.toMatchObject({ status: "unpublished" });
  });
});
