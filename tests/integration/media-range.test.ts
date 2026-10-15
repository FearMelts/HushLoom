import { randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as mediaRoute } from "@/app/api/media/route";
import { closeDb, getDb } from "@/server/db";
import { mediaAssets } from "@/server/db/schema";
import { assetUrl } from "@/server/media";
import { closeRedis } from "@/server/redis";
import { sha256, storage } from "@/server/storage";
import { makeUser, resetDb } from "../helpers";

const getMedia = (url: string, headers: Record<string, string> = {}) => mediaRoute(new NextRequest(new URL(url, "http://localhost"), { headers }));

async function clip(ownerId: string, size = 3 * 1024 * 1024) {
  const bytes = randomBytes(size);
  const key = `outputs/${ownerId}/${randomUUID()}.mp4`;
  await storage().put(key, bytes, "video/mp4");
  const [a] = await getDb()
    .insert(mediaAssets)
    .values({ ownerId, kind: "video", storageKey: key, mime: "video/mp4", bytes: bytes.length, sha256: sha256(bytes), visibility: "private", scanStatus: "clean" })
    .returning();
  return { url: (await assetUrl(a!, ownerId))!, bytes };
}

beforeEach(async () => {
  await resetDb();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("/api/media reads only the bytes a request asks for (R29)", () => {
  it("answers a one-byte range without loading the whole file", async () => {
    const u = await makeUser();
    const { url, bytes } = await clip(u.id);
    const whole = vi.spyOn(storage(), "get");
    const res = await getMedia(url, { range: "bytes=0-0" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 0-0/${bytes.length}`);
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes.subarray(0, 1))).toBe(true);
    expect(whole).not.toHaveBeenCalled();
  });

  it("serves suffix, open-ended and whole-file requests correctly, and 416 past the end", async () => {
    const u = await makeUser();
    const { url, bytes } = await clip(u.id, 4096);
    const suffix = await getMedia(url, { range: "bytes=-10" });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe(`bytes 4086-4095/4096`);
    expect(Buffer.from(await suffix.arrayBuffer()).equals(bytes.subarray(4086))).toBe(true);
    const open = await getMedia(url, { range: "bytes=4000-" });
    expect(open.headers.get("content-length")).toBe("96");
    expect(Buffer.from(await open.arrayBuffer()).equals(bytes.subarray(4000))).toBe(true);
    const all = await getMedia(url);
    expect(all.status).toBe(200);
    expect(all.headers.get("content-length")).toBe("4096");
    expect(Buffer.from(await all.arrayBuffer()).equals(bytes)).toBe(true);
    expect((await getMedia(url, { range: "bytes=5000-" })).status).toBe(416);
  });
});
