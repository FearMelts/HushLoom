import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { suspendUser } from "@/server/admin";
import { deleteAccount, registerUser } from "@/server/auth/account";
import { closeDb, getDb } from "@/server/db";
import { auditLogs, generationJobs, mediaAssets, templates, userProfiles, users } from "@/server/db/schema";
import { confirmJob, createDraft } from "@/server/generation/service";
import { processJob } from "@/server/generation/processor";
import { closeRedis } from "@/server/redis";
import { publishTemplate } from "@/server/templates/publish";
import type { SessionUser } from "@/server/auth/session";
import { key, makeUser, resetDb } from "../helpers";

const ctx = { country: null };
const FKS = [
  "credit_ledger_payment_event_id_payment_events_id_fk",
  "generation_jobs_parent_job_id_generation_jobs_id_fk",
  "scene_versions_parent_version_id_scene_versions_id_fk",
  "templates_remixed_from_id_templates_id_fk",
  "user_profiles_avatar_asset_id_media_assets_id_fk",
];

const draftInput = (overrides: Record<string, unknown> = {}) => ({
  idempotencyKey: key(),
  mode: "text_to_image" as const,
  modelKey: "demo-still",
  prompt: "an adult couple sharing a toast by candlelight, warm film grain",
  negativePrompt: "",
  params: { aspectRatio: "1:1" },
  inputAssetIds: [],
  ...overrides,
});

async function finished(user: SessionUser) {
  const draft = await createDraft(user, draftInput(), ctx);
  await confirmJob(user, draft.id, draft.costCredits);
  await processJob(draft.id);
  return draft;
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

class Rollback extends Error {}

describe("migration 0003", () => {
  it("adds the five foreign keys with ON DELETE SET NULL", async () => {
    const rows = await getDb().execute<{ conname: string; confdeltype: string }>(
      sql`select conname, confdeltype from pg_constraint where conname in (${sql.join(FKS.map((n) => sql`${n}`), sql`, `)}) order by conname`,
    );
    expect(rows.map((r) => r.conname)).toEqual(FKS);
    expect(rows.every((r) => r.confdeltype === "n")).toBe(true);
  });

  it("clears a lineage link when its target row is removed", async () => {
    const user = await makeUser({ credits: 50 });
    const parent = await createDraft(user, draftInput(), ctx);
    const child = await createDraft(user, draftInput({ parentJobId: parent.id, relation: "remix" }), ctx);
    const [asset] = await getDb()
      .insert(mediaAssets)
      .values({ ownerId: user.id, kind: "image", storageKey: `avatars/${user.id}/a.webp`, mime: "image/webp", bytes: 1, sha256: "x", visibility: "public" })
      .returning();
    await getDb().update(userProfiles).set({ avatarAssetId: asset!.id }).where(eq(userProfiles.userId, user.id));

    await getDb().delete(generationJobs).where(eq(generationJobs.id, parent.id));
    await getDb().delete(mediaAssets).where(eq(mediaAssets.id, asset!.id));
    const [c] = await getDb().select().from(generationJobs).where(eq(generationJobs.id, child.id));
    const [p] = await getDb().select().from(userProfiles).where(eq(userProfiles.userId, user.id));
    expect(c!.parentJobId).toBeNull();
    expect(p!.avatarAssetId).toBeNull();
  });

  it("applies cleanly to a database holding dangling references and a deleted account's date of birth", async () => {
    const user = await makeUser({ credits: 50 });
    const gone = await makeUser({ credits: 5 });
    const job = await finished(user);
    const t = await publishTemplate(user, { jobId: job.id, title: "Old Recipe", description: "", tags: [], isVip: false });
    const file = readFileSync(path.resolve("drizzle/0003_integrity_fks_and_dob.sql"), "utf8");
    const statements = file.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
    expect(statements.length).toBeGreaterThan(5);

    let observed: Record<string, unknown> = {};
    const run = getDb().transaction(async (tx) => {
      // Back to the state before 0003: no constraints, so references can dangle.
      const tables = ["credit_ledger", "generation_jobs", "scene_versions", "templates", "user_profiles"];
      for (const [i, name] of FKS.entries()) await tx.execute(sql.raw(`ALTER TABLE "${tables[i]}" DROP CONSTRAINT "${name}"`));
      await tx.execute(sql`update generation_jobs set parent_job_id = gen_random_uuid() where id = ${job.id}`);
      await tx.execute(sql`update templates set remixed_from_id = gen_random_uuid() where id = ${t.id}`);
      await tx.execute(sql`update user_profiles set avatar_asset_id = gen_random_uuid() where user_id = ${user.id}`);
      await tx.execute(sql`update credit_ledger set payment_event_id = gen_random_uuid() where user_id = ${user.id}`);
      await tx.execute(sql`update users set status = 'deleted' where id = ${gone.id}`);

      for (const statement of statements) await tx.execute(sql.raw(statement));

      const [j] = await tx.select({ parent: generationJobs.parentJobId }).from(generationJobs).where(eq(generationJobs.id, job.id));
      const [tt] = await tx.select({ from: templates.remixedFromId }).from(templates).where(eq(templates.id, t.id));
      const [pr] = await tx.select({ avatar: userProfiles.avatarAssetId }).from(userProfiles).where(eq(userProfiles.userId, user.id));
      const ledger = await tx.execute<{ n: number }>(sql`select count(*)::int as n from credit_ledger where payment_event_id is not null`);
      const [g] = await tx.select({ dob: users.dateOfBirth }).from(users).where(eq(users.id, gone.id));
      const [kept] = await tx.select({ dob: users.dateOfBirth }).from(users).where(eq(users.id, user.id));
      const constraints = await tx.execute<{ n: number }>(sql`select count(*)::int as n from pg_constraint where conname in (${sql.join(FKS.map((n) => sql`${n}`), sql`, `)})`);
      observed = { parent: j!.parent, remixedFrom: tt!.from, avatar: pr!.avatar, ledgerLinks: ledger[0]!.n, deletedDob: g!.dob, activeDob: kept!.dob, constraints: constraints[0]!.n };
      throw new Rollback();
    });
    await expect(run).rejects.toBeInstanceOf(Rollback);
    expect(observed).toEqual({ parent: null, remixedFrom: null, avatar: null, ledgerLinks: 0, deletedDob: null, activeDob: "1990-01-01", constraints: 5 });
  });
});

describe("account deletion", () => {
  it("erases the date of birth and keeps the record that age was checked", async () => {
    const reg = await registerUser({ email: "leaving@example.test", password: "long-enough-pass", handle: "leaving", displayName: "L", dateOfBirth: "1991-02-03", acceptTerms: true, confirmAdult: true });
    const [before] = await getDb().select().from(users).where(eq(users.id, reg.id));
    expect(before!.dateOfBirth).toBe("1991-02-03");
    await deleteAccount(reg.id, "long-enough-pass");
    const [after] = await getDb().select().from(users).where(eq(users.id, reg.id));
    expect(after!.status).toBe("deleted");
    expect(after!.dateOfBirth).toBeNull();
    expect(after!.ageAssuredAt).toEqual(before!.ageAssuredAt);
    expect(after!.ageAssuranceMethod).toBe(before!.ageAssuranceMethod);
  });
});

describe("suspension", () => {
  it("unpublishes the account's live templates in the same step and records how many", async () => {
    const admin = await makeUser({ role: "admin" });
    const creator = await makeUser({ credits: 50 });
    const bystander = await makeUser({ credits: 50 });
    const a = await publishTemplate(creator, { jobId: (await finished(creator)).id, title: "First", description: "", tags: [], isVip: false });
    const b = await publishTemplate(creator, { jobId: (await finished(creator)).id, title: "Second", description: "", tags: [], isVip: false });
    const c = await publishTemplate(creator, { jobId: (await finished(creator)).id, title: "Removed", description: "", tags: [], isVip: false });
    await getDb().update(templates).set({ status: "removed" }).where(eq(templates.id, c.id));
    const other = await publishTemplate(bystander, { jobId: (await finished(bystander)).id, title: "Someone else", description: "", tags: [], isVip: false });

    expect(await suspendUser(admin.id, creator.id, "test")).toEqual({ unpublishedTemplates: 2 });
    const status = async (id: string) => (await getDb().select({ s: templates.status }).from(templates).where(eq(templates.id, id)))[0]!.s;
    expect(await status(a.id)).toBe("unpublished");
    expect(await status(b.id)).toBe("unpublished");
    expect(await status(c.id)).toBe("removed");
    expect(await status(other.id)).toBe("published");
    const [u] = await getDb().select().from(users).where(eq(users.id, creator.id));
    expect(u!.status).toBe("suspended");
    const [entry] = await getDb().select().from(auditLogs).where(and(eq(auditLogs.action, "user.suspend"), eq(auditLogs.targetId, creator.id)));
    expect(entry!.metadata).toEqual({ reason: "test", unpublishedTemplates: 2 });

    // Suspending again finds no active account and changes nothing.
    await expect(suspendUser(admin.id, creator.id, "again")).rejects.toMatchObject({ status: 404 });
  });
});
