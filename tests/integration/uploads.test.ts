import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createCharacter } from "@/server/characters";
import { closeDb, getDb } from "@/server/db";
import { qualityCheck } from "@/server/generation/processor";
import { mediaAssets } from "@/server/db/schema";
import { acceptUpload } from "@/server/media";
import { closeRedis } from "@/server/redis";
import { photoDnaJpeg } from "@/server/safety/scan/providers/photodna";
import { storage } from "@/server/storage";
import { makeUser, resetDb } from "../helpers";

const consent = { statement: "x", subjectLabel: null };

/** An RGBA PNG built pixel by pixel. */
async function rgbaPng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]) {
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set(pixel(x, y), (y * width + x) * 4);
  return sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

/**
 * Mean R, G, B of one half of an image as someone holding the file can see it: with the alpha channel
 * dropped, or shown over a white or a black page.
 */
type View = "alpha dropped" | "on white" | "on black";
async function halfMeans(bytes: Buffer, half: "left" | "right", view: View = "alpha dropped") {
  const base = sharp(bytes);
  const img = view === "alpha dropped" ? base.removeAlpha() : base.flatten({ background: view === "on white" ? "#ffffff" : "#000000" });
  const { width, height } = await sharp(bytes).metadata();
  const w = Math.floor(width! / 2);
  const region = await img.extract({ left: half === "left" ? 0 : w, top: 0, width: w, height: height! }).toBuffer();
  return (await sharp(region).stats()).channels.slice(0, 3).map((c) => Math.round(c.mean));
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("image uploads keep no alpha channel to hide content from the hash matcher (R07)", () => {
  const variants: [string, (x: number, y: number) => [number, number, number, number]][] = [
    // The picture is in the colour channels, made almost fully transparent.
    ["a picture with alpha 1/255", (x) => (x < 300 ? [255, 0, 0, 1] : [0, 0, 255, 1])],
    // The colour channels are black and the picture is only in the alpha channel.
    ["a picture drawn only in alpha", (x) => (x < 300 ? [0, 0, 0, 255] : [0, 0, 0, 0])],
  ];
  for (const [name, pixel] of variants) {
    it(`stores exactly what the matcher sees: ${name}`, async () => {
      const u = await makeUser();
      const { assetId } = await acceptUpload(u.id, { bytes: await rgbaPng(600, 600, pixel), declaredMime: "image/png" }, consent, "source");
      const [asset] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
      const stored = await storage().get(asset!.storageKey);
      const scanned = await photoDnaJpeg(stored);
      for (const view of ["alpha dropped", "on white", "on black"] as const) {
        for (const half of ["left", "right"] as const) {
          const [kept, seen] = [await halfMeans(stored, half, view), await halfMeans(scanned, half)];
          kept.forEach((v, i) => expect(Math.abs(v - seen[i]!), `${view}, ${half} half: stored ${kept} vs scanned ${seen}`).toBeLessThanOrEqual(4));
        }
      }
      // Nothing for a viewer's background to reveal either.
      expect((await sharp(stored).metadata()).hasAlpha).toBe(false);
    });
  }
});

describe("image decoding is bounded (R09)", () => {
  // 6400 x 6400 = 41 megapixels in a ~560 KB PNG: a decompression bomb by ratio.
  const bomb = () => sharp({ create: { width: 6400, height: 6400, channels: 3, background: "#553344" } }).png().toBuffer();

  it("refuses an upload over the pixel limit with a 413 before decoding it, on both upload paths", async () => {
    const u = await makeUser();
    const bytes = await bomb();
    expect(bytes.length).toBeLessThan(1024 * 1024);
    await expect(acceptUpload(u.id, { bytes, declaredMime: "image/png" }, consent, "source")).rejects.toMatchObject({ status: 413, code: "too_large" });
    await expect(createCharacter(u.id, { bytes, declaredMime: "image/png" }, "Big", null)).rejects.toMatchObject({ status: 413, code: "too_large" });
    expect(await getDb().select().from(mediaAssets).where(eq(mediaAssets.ownerId, u.id))).toHaveLength(0);
  });

  it("the PhotoDNA copy refuses to decode an image over the pixel limit", async () => {
    await expect(photoDnaJpeg(await bomb())).rejects.toThrow(/pixel limit/);
  });

  it("a provider output over the pixel limit fails the quality check instead of being stored", async () => {
    const report = await qualityCheck({ mime: "image/png", bytes: await bomb() });
    expect(report.ok).toBe(false);
  });

  it("an image whose header reads but whose data does not is a 415, not a 500", async () => {
    const u = await makeUser();
    const png = await sharp({ create: { width: 640, height: 640, channels: 3, background: "#335544" } }).png().toBuffer();
    await expect(acceptUpload(u.id, { bytes: png.subarray(0, 120), declaredMime: "image/png" }, consent, "source")).rejects.toMatchObject({ status: 415 });
  });

  it("large images are stored downscaled to fit 4096 px", async () => {
    const u = await makeUser();
    const wide = await sharp({ create: { width: 6000, height: 3000, channels: 3, background: "#335544" } }).png().toBuffer();
    const up = await acceptUpload(u.id, { bytes: wide, declaredMime: "image/png" }, consent, "source");
    expect(up).toMatchObject({ width: 4096, height: 2048 });
  });
});
