import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { GET as mediaRoute } from "@/app/api/media/route";
import { resolveReport, suspendUser } from "@/server/admin";
import { createSession } from "@/server/auth/session";
import { closeDb, getDb } from "@/server/db";
import { mediaAssets, moderationEvents, templates } from "@/server/db/schema";
import { assetUrl } from "@/server/media";
import { closeRedis } from "@/server/redis";
import { sha256, storage } from "@/server/storage";
import { makeUser, resetDb } from "../helpers";

const getMedia = (url: string, session?: string) => mediaRoute(new NextRequest(new URL(url, "http://localhost"), session ? { headers: { cookie: `hl_session=${session}` } } : {}));

/** A published video template with a public poster and preview, as publishTemplate leaves it. */
async function publishedTemplate(creatorId: string) {
  const asset = async (kind: "image" | "video") => {
    const bytes = Buffer.from(`${kind} ${randomUUID()}`.repeat(50));
    const key = `templates/${creatorId}/${randomUUID()}.${kind === "video" ? "mp4" : "webp"}`;
    await storage().put(key, bytes, kind === "video" ? "video/mp4" : "image/webp");
    const [a] = await getDb()
      .insert(mediaAssets)
      .values({ ownerId: creatorId, kind, storageKey: key, mime: kind === "video" ? "video/mp4" : "image/webp", bytes: bytes.length, sha256: sha256(bytes), visibility: "public", scanStatus: "clean" })
      .returning();
    return a!;
  };
  const poster = await asset("image");
  const preview = await asset("video");
  const [t] = await getDb()
    .insert(templates)
    .values({ slug: `t-${randomUUID().slice(0, 8)}`, creatorId, title: "T", mediaType: "video", mode: "text_to_video", status: "published", posterAssetId: poster.id, previewAssetId: preview.id, publishedAt: new Date() })
    .returning();
  // Links a visitor was handed while the template was live.
  return { template: t!, poster, preview, links: [(await assetUrl(poster, null))!, (await assetUrl(preview, null))!] };
}

async function report(templateId: string, reason: string) {
  const reporter = await makeUser();
  const [e] = await getDb()
    .insert(moderationEvents)
    .values({ subjectType: "template", subjectId: templateId, action: "report", status: "open", reporterId: reporter.id, reason, details: { note: "" } })
    .returning();
  return e!.id;
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("taking a template down stops its media at once (R34)", () => {
  it("a template removed from the Reports panel stops serving through links handed out before", async () => {
    const [creator, admin] = [await makeUser(), await makeUser({ role: "admin" })];
    const { template, poster, preview, links } = await publishedTemplate(creator.id);
    for (const l of links) expect((await getMedia(l)).status).toBe(200);
    await resolveReport(admin.id, await report(template.id, "spam"), { action: "remove", note: "" });
    for (const l of links) expect((await getMedia(l)).status).toBe(404);
    // Its files are removed like any other deleted media (purged after the retention window).
    for (const a of [poster, preview]) {
      const [row] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, a.id));
      expect(row!.deletedAt).not.toBeNull();
      expect(row!.legalHold).toBe(false);
    }
  });

  it("a template removed after a report of a minor is held as evidence and sent to the review queue", async () => {
    const [creator, admin] = [await makeUser(), await makeUser({ role: "admin" })];
    const { template, poster, preview, links } = await publishedTemplate(creator.id);
    await resolveReport(admin.id, await report(template.id, "minor"), { action: "remove", note: "" });
    for (const l of links) expect((await getMedia(l)).status).toBe(404);
    for (const a of [poster, preview]) {
      const [row] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, a.id));
      expect(row).toMatchObject({ legalHold: true });
      expect(row!.deletedAt).not.toBeNull();
      const escalations = await getDb()
        .select()
        .from(moderationEvents)
        .where(and(eq(moderationEvents.subjectId, a.id), eq(moderationEvents.action, "escalate"), eq(moderationEvents.status, "open")));
      expect(escalations).toHaveLength(1);
      expect(escalations[0]).toMatchObject({ reason: "csam_report" });
    }
  });

  it("suspending the creator stops their template media through links handed out before", async () => {
    const [creator, admin] = [await makeUser(), await makeUser({ role: "admin" })];
    const { links } = await publishedTemplate(creator.id);
    for (const l of links) expect((await getMedia(l)).status).toBe(200);
    await suspendUser(admin.id, creator.id, "test");
    for (const l of links) expect((await getMedia(l)).status).toBe(404);
  });

  it("a creator still sees their own unpublished template's media; nobody else does", async () => {
    const creator = await makeUser();
    const { template, poster } = await publishedTemplate(creator.id);
    await getDb().update(templates).set({ status: "unpublished" }).where(eq(templates.id, template.id));
    const link = (await assetUrl(poster, creator.id))!;
    expect((await getMedia(link)).status).toBe(404);
    expect((await getMedia(link, (await createSession((await makeUser()).id, null)).token)).status).toBe(404);
    expect((await getMedia(link, (await createSession(creator.id, null)).token)).status).toBe(200);
  });
});
