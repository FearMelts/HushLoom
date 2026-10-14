import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb } from "@/server/db";
import { mediaAssets } from "@/server/db/schema";
import { acceptUpload } from "@/server/media";
import { closeRedis } from "@/server/redis";
import { runScan } from "@/server/safety/scan";
import type { ScanProvider } from "@/server/safety/scan/types";
import { sha256 } from "@/server/storage";
import { makeUser, resetDb } from "../helpers";

const run = promisify(execFile);

/** Builds an H.264 MP4 from lavfi sources played one after another (4 fps unless a source says otherwise). */
async function clip(sources: string[]): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hl-test-clip-"));
  try {
    const out = path.join(dir, "clip.mp4");
    const graph = `${sources.map((_, i) => `[${i}:v]format=yuv420p,setsar=1[s${i}];`).join("")}${sources.map((_, i) => `[s${i}]`).join("")}concat=n=${sources.length}:v=1:a=0[v]`;
    await run("ffmpeg", ["-v", "error", "-y", ...sources.flatMap((s) => ["-f", "lavfi", "-i", s]), "-filter_complex", graph, "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const solid = (color: string, seconds: number, size = "64x64") => `color=c=${color}:s=${size}:r=4:d=${seconds}`;

/** A stand-in hash matcher that "knows" any mostly red frame, so a test can tell which frames the scanner was shown. */
const redMatcher: ScanProvider = {
  key: "dev",
  label: "test matcher: red frames match",
  isDev: true,
  capabilities: { hashMatch: true, classifier: false, video: false, preStorage: true },
  isConfigured: () => true,
  async scan(input) {
    const [r, g, b] = (await sharp(input.bytes).stats()).channels.map((c) => c.mean);
    if (r! > 150 && g! < 80 && b! < 80) return { status: "matched", provider: "dev", category: "csam", ref: "test:red" };
    return { status: "clean", provider: "dev", ref: "test:clean" };
  },
};
const scanClip = (bytes: Buffer) => runScan({ bytes, mime: "video/mp4", kind: "video", sha256: sha256(bytes) }, redMatcher);

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("video scan coverage (R06)", () => {
  it("sees content that starts after the first 30 seconds", async () => {
    expect(await scanClip(await clip([solid("blue", 30.5), solid("red", 15)]))).toMatchObject({ status: "matched" });
  });

  it("sees a cut that falls between two once-a-second samples", async () => {
    // One red frame at 10.0 s; the once-a-second sample for that second lands on the blue frame after it.
    expect(await scanClip(await clip([solid("blue", 10), solid("red", 0.25), solid("blue", 5)]))).toMatchObject({ status: "matched" });
  });

  it("never clears a clip longer than the scan covers", async () => {
    expect(await scanClip(await clip([solid("blue", 61.5)]))).toMatchObject({ status: "unavailable" });
  });

  it("never clears a clip with more sharp changes than it samples (a strobe)", async () => {
    // Every frame differs from the one before: green, blue, green, ... for 20 seconds.
    const strobe = "nullsrc=s=64x64:r=4:d=20,geq=r=0:g='255*mod(N,2)':b='255*(1-mod(N,2))'";
    expect(await scanClip(await clip([strobe]))).toMatchObject({ status: "unavailable" });
  });

  it("refuses an upload longer than the scan covers before storing anything", async () => {
    const u = await makeUser();
    const long = await clip([solid("blue", 61.5)]);
    await expect(acceptUpload(u.id, { bytes: long, declaredMime: "video/mp4" }, { statement: "x", subjectLabel: null }, "source")).rejects.toMatchObject({ status: 422, code: "too_long" });
    expect(await getDb().select().from(mediaAssets).where(eq(mediaAssets.ownerId, u.id))).toHaveLength(0);
  });
});

describe("video decoding for the scan is bounded (R25)", () => {
  it("refuses an upload larger than 4096 px on a side before storing anything", async () => {
    const u = await makeUser();
    const wide = await clip([solid("blue", 1, "4160x32")]);
    await expect(acceptUpload(u.id, { bytes: wide, declaredMime: "video/mp4" }, { statement: "x", subjectLabel: null }, "source")).rejects.toMatchObject({ status: 413, code: "too_large" });
    expect(await getDb().select().from(mediaAssets).where(eq(mediaAssets.ownerId, u.id))).toHaveLength(0);
  });

  it("never clears a clip larger than the scan reads", async () => {
    expect(await scanClip(await clip([solid("blue", 1, "4160x32")]))).toMatchObject({ status: "unavailable" });
  });

  it("scans frames downscaled to fit 1024 px, and still sees what is in them", async () => {
    const sizes: number[] = [];
    const sizing: ScanProvider = {
      ...redMatcher,
      async scan(input) {
        const { width, height } = await sharp(input.bytes).metadata();
        sizes.push(Math.max(width!, height!));
        return redMatcher.scan(input);
      },
    };
    const bytes = await clip([solid("blue", 2, "2048x1152"), solid("red", 1, "2048x1152")]);
    expect(await runScan({ bytes, mime: "video/mp4", kind: "video", sha256: sha256(bytes) }, sizing)).toMatchObject({ status: "matched" });
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(1024);
  });
});
