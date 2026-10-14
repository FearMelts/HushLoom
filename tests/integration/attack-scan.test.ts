import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { crc32, deflateSync } from "node:zlib";
import { NextRequest } from "next/server";
import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { GET as mediaRoute } from "@/app/api/media/route";
import { createSession } from "@/server/auth/session";
import { closeDb, getDb } from "@/server/db";
import { mediaAssets, templates } from "@/server/db/schema";
import { acceptUpload, assetUrl } from "@/server/media";
import { closeRedis } from "@/server/redis";
import { recordDerivedScan, recordVerdict, runScan } from "@/server/safety/scan";
import type { ScanProvider } from "@/server/safety/scan/types";
import { sha256, storage } from "@/server/storage";
import { makeUser, resetDb } from "../helpers";

const run = promisify(execFile);

/**
 * Independent attacker's tests against the "scan" fixes (R06, R07, R09, R13, R25, R29, R34, R42).
 * Each attempt tries to reach the pre-fix behaviour by another door. Attempts that the fix stops
 * are kept as passing regression tests; attempts that still get through are marked `it.fails` with
 * the hole named in a comment, so the suite stays green while the hole is on record.
 */

// ── Video helpers: raw RGB frames encoded to H.264, so every pixel is under test control ──

const SIZE = 64;
/** Encodes `count` frames (fps 30) built by `color(n) -> [r,g,b]` into a near-lossless MP4. */
async function rawClip(count: number, color: (n: number) => [number, number, number], size = SIZE): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hl-atk-"));
  try {
    const raw = Buffer.alloc(size * size * 3 * count);
    for (let n = 0; n < count; n++) {
      const [r, g, b] = color(n);
      for (let p = 0; p < size * size; p++) {
        const o = (n * size * size + p) * 3;
        raw[o] = r;
        raw[o + 1] = g;
        raw[o + 2] = b;
      }
    }
    const input = path.join(dir, "in.raw");
    const output = path.join(dir, "out.mp4");
    await writeFile(input, raw);
    await run("ffmpeg", [
      "-v", "error", "-y",
      "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", `${size}x${size}`, "-framerate", "30", "-i", input,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "8", "-movflags", "+faststart", output,
    ]);
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const BLUE: [number, number, number] = [0, 0, 255];
const RED: [number, number, number] = [255, 0, 0];

/** A stand-in matcher that "knows" any mostly-red frame, so a test can tell which frames the scan saw. */
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

describe("R06/R25 video scan coverage — bypass attempts", () => {
  // HOLE. The scan samples one frame per real second (ffmpeg fps=1 lands at t ≈ k + 0.467) plus every
  // frame whose scdet mafd jumps over 10%. Red content that fades in and out inside the ~0.5 s gap
  // between two periodic samples never lands on a sample, and a fade slow enough (here ±0.3 s ramps)
  // keeps every frame-to-frame mafd under 10%, so scdet never fires either. A frame that is fully red
  // at its peak (a human sees a clear red flash at ~9.97 s) is therefore never extracted, and the clip
  // is cleared. The R06 commit acknowledges this class ("content shown for under a second that fades
  // in rather than cutting in can still fall between two samples"); the addendum still requires every
  // output to be scanned before display, so matched content stored as "clean" is a live hole.
  it.fails("a sub-second red flash that fades in and out between samples is cleared, not matched", async () => {
    const CENTER = 9.967; // mid-gap between the periodic samples at 9.467 s and 10.467 s
    const HALF = 0.3; // ramp each side: slow enough that no frame-to-frame change trips scdet (>10% mafd)
    const pulse = (t: number) => Math.max(0, Math.min(1, 1 - Math.abs(t - CENTER) / HALF));
    const fade = await rawClip(15 * 30, (n) => {
      const p = pulse(n / 30);
      return [Math.round(255 * p), 0, Math.round(255 * (1 - p))];
    });
    // The clip genuinely contains a fully-red frame (visible content), yet the scanner never sees it.
    const verdict = await scanClip(fade);
    expect(verdict).toMatchObject({ status: "matched" });
  });

  it("the same red content shown as a hard cut (not a fade) is caught by scene detection", async () => {
    // Three red frames dropped in at the same mid-gap moment; the blue->red jump trips scdet.
    const cut = await rawClip(15 * 30, (n) => (n >= 298 && n <= 300 ? RED : BLUE));
    expect(await scanClip(cut)).toMatchObject({ status: "matched" });
  });

  it("content that sits on a periodic sample is caught even with no scene change", async () => {
    // Red held for a full second straddling a sample point; no cut, but the once-a-second frame sees it.
    const held = await rawClip(15 * 30, (n) => (n >= 284 && n <= 314 ? RED : BLUE));
    expect(await scanClip(held)).toMatchObject({ status: "matched" });
  });

  it("a 60 s clip (the boundary) is still scanned rather than refused", async () => {
    const red = await rawClip(60 * 30, () => RED);
    expect(await scanClip(red)).toMatchObject({ status: "matched" });
  });
});

describe("R09 image decode bounds — bypass attempts", () => {
  const consent = { statement: "x", subjectLabel: null };

  it("a raster image over the pixel limit is still refused with 413 before decode", async () => {
    const u = await makeUser();
    // A declared 16000x16000 image: small file, huge canvas, well over the 40 MP limit. This was an SVG; SVG
    // no longer reaches the decoder at all (R09-svg), so the pixel guard is exercised with a 94-byte PNG.
    const chunk = (type: string, data: Buffer) => {
      const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
      const out = Buffer.alloc(12 + data.length);
      out.writeUInt32BE(data.length, 0);
      typed.copy(out, 4);
      out.writeUInt32BE(crc32(typed), 8 + data.length);
      return out;
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(16000, 0);
    ihdr.writeUInt32BE(16000, 4);
    ihdr[8] = 8; // 8-bit greyscale
    const huge = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(Buffer.alloc(16001))),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    expect(huge.length).toBeLessThan(200);
    await expect(
      acceptUpload(u.id, { bytes: huge, declaredMime: "image/png" }, consent, "source"),
    ).rejects.toMatchObject({ status: 413 });
    // The same canvas declared by an SVG is refused as a type we do not read, before any parse.
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="16000" height="16000"><rect width="10" height="10"/></svg>`,
    );
    await expect(
      acceptUpload(u.id, { bytes: svg, declaredMime: "image/svg+xml" }, consent, "source"),
    ).rejects.toMatchObject({ status: 415, code: "unsupported_type" });
    expect(await getDb().select().from(mediaAssets).where(eq(mediaAssets.ownerId, u.id))).toHaveLength(0);
  });

  // Was a hole (R09-svg): untrustedImage.limitInputPixels bounds the raster output area only. An SVG
  // with a tiny declared canvas but a very large element tree is under the pixel limit, so sharp
  // parsed it in full before the format check rejected it (~100k nodes cost ~0.8 s and ~170 MB; a
  // 20 MB SVG ~8 s / ~1.5 GB), on both upload routes. Only JPEG, PNG and WebP, told apart by their
  // first bytes, now reach the decoder; anything else is refused 415 without being parsed.
  it("a small-canvas SVG with a huge node tree is refused cheaply, not decoded", async () => {
    const u = await makeUser();
    const body =
      `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8">` +
      `<rect width="1" height="1"/>`.repeat(100_000) +
      `</svg>`;
    const started = Date.now();
    await acceptUpload(u.id, { bytes: Buffer.from(body), declaredMime: "image/svg+xml" }, consent, "source").catch(() => undefined);
    const elapsed = Date.now() - started;
    // A bounded decode rejects this near-instantly; it used to spend real CPU parsing the tree.
    expect(elapsed).toBeLessThan(300);
  });

  it("a few hundred bytes of SVG whose entities expand into a huge tree are refused cheaply", async () => {
    // A byte cap would not bound SVG: 100,000 elements come out of a ~370-byte document.
    const u = await makeUser();
    const tens = (name: string, of: string) => `<!ENTITY ${name} "${of.repeat(10)}">`;
    const bomb =
      `<?xml version="1.0"?><!DOCTYPE svg [${tens("r", "<rect/>")}${tens("s", "&r;")}${tens("t", "&s;")}${tens("u", "&t;")}${tens("v", "&u;")}]>` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8">&v;</svg>`;
    expect(bomb.length).toBeLessThan(1024);
    const started = Date.now();
    await expect(acceptUpload(u.id, { bytes: Buffer.from(bomb), declaredMime: "image/svg+xml" }, consent, "source")).rejects.toMatchObject({ status: 415 });
    expect(Date.now() - started).toBeLessThan(300);
  });
});

// ── Media serving helpers (local driver) ──

const getMedia = (url: string, session?: string) =>
  mediaRoute(new NextRequest(new URL(url, "http://localhost"), session ? { headers: { cookie: `hl_session=${session}` } } : {}));

async function publicAsset(ownerId: string, attachTemplate: boolean) {
  const bytes = Buffer.from(`public ${randomUUID()}`.repeat(64));
  const key = `templates/${ownerId}/${randomUUID()}.webp`;
  await storage().put(key, bytes, "image/webp");
  const [a] = await getDb()
    .insert(mediaAssets)
    .values({ ownerId, kind: "image", storageKey: key, mime: "image/webp", bytes: bytes.length, sha256: sha256(bytes), visibility: "public", scanStatus: "clean" })
    .returning();
  if (attachTemplate) {
    await getDb()
      .insert(templates)
      .values({ slug: `t-${randomUUID().slice(0, 8)}`, creatorId: ownerId, title: "T", mediaType: "image", mode: "text_to_image", status: "published", posterAssetId: a!.id, publishedAt: new Date() });
  }
  return { asset: a!, bytes };
}

describe("R13/R34 media serving — bypass attempts (local driver)", () => {
  it("a public asset that backs no published template is not served to a signed-out viewer", async () => {
    const u = await makeUser();
    const { asset } = await publicAsset(u.id, false);
    const url = (await assetUrl(asset, null))!;
    // The signature is valid and the asset is clean, but no live template uses it: strangers get 404.
    expect((await getMedia(url)).status).toBe(404);
    // A different signed-in user is also refused.
    const other = await createSession((await makeUser()).id, null);
    expect((await getMedia(url, other.token)).status).toBe(404);
    // Only the owner, read from the cookie, may load it.
    const owner = await createSession(u.id, null);
    expect((await getMedia(url, owner.token)).status).toBe(200);
  });

  it("unpublishing the template stops a link minted earlier, for everyone but the owner", async () => {
    const u = await makeUser();
    const { asset } = await publicAsset(u.id, true);
    const url = (await assetUrl(asset, null))!;
    expect((await getMedia(url)).status).toBe(200);
    await getDb().update(templates).set({ status: "unpublished" }).where(eq(templates.posterAssetId, asset.id));
    expect((await getMedia(url)).status).toBe(404);
    const other = await createSession((await makeUser()).id, null);
    expect((await getMedia(url, other.token)).status).toBe(404);
  });

  it("a signature for a key with no asset row is a 404, never a 500", async () => {
    // A well-formed, unexpired signature over a key that does not exist must not throw.
    const url = await storage().signedUrl(`templates/${randomUUID()}/${randomUUID()}.webp`, 300);
    expect((await getMedia(url)).status).toBe(404);
  });
});

describe("R29 range reads — regression (local driver)", () => {
  async function servedAsset() {
    const u = await makeUser();
    const { asset, bytes } = await publicAsset(u.id, true);
    const url = (await assetUrl(asset, null))!;
    return { url, bytes };
  }
  const ranged = (url: string, range: string) =>
    mediaRoute(new NextRequest(new URL(url, "http://localhost"), { headers: { range } }));

  it("a suffix range returns the last N bytes as 206", async () => {
    const { url, bytes } = await servedAsset();
    const res = await ranged(url, "bytes=-5");
    expect(res.status).toBe(206);
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes.subarray(bytes.length - 5))).toBe(true);
    expect(res.headers.get("content-range")).toBe(`bytes ${bytes.length - 5}-${bytes.length - 1}/${bytes.length}`);
  });

  it("an open-ended range returns from the offset to the end", async () => {
    const { url, bytes } = await servedAsset();
    const res = await ranged(url, "bytes=10-");
    expect(res.status).toBe(206);
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes.subarray(10))).toBe(true);
  });

  it("a range that starts past the end is 416", async () => {
    const { url, bytes } = await servedAsset();
    const res = await ranged(url, `bytes=${bytes.length + 10}-`);
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe(`bytes */${bytes.length}`);
  });

  it("a garbled range header falls back to the whole file (200)", async () => {
    const { url, bytes } = await servedAsset();
    const res = await ranged(url, "bytes=abc-def");
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).length).toBe(bytes.length);
  });
});

describe("R42 evidence writes — bypass attempts", () => {
  async function matchedAsset(ownerId: string) {
    const bytes = Buffer.from(`held ${randomUUID()}`.repeat(32));
    const key = `outputs/${ownerId}/${randomUUID()}.webp`;
    await storage().put(key, bytes, "image/webp");
    const [a] = await getDb()
      .insert(mediaAssets)
      .values({ ownerId, kind: "image", storageKey: key, mime: "image/webp", bytes: bytes.length, sha256: sha256(bytes), visibility: "private", scanStatus: "matched", legalHold: true })
      .returning();
    return a!;
  }

  it("a later clean verdict never overwrites a matched asset (recordVerdict)", async () => {
    const u = await makeUser();
    const a = await matchedAsset(u.id);
    const status = await recordVerdict(
      { assetId: a.id, origin: "backfill", ownerId: u.id, sha256: a.sha256, mime: "image/webp", kind: "image" },
      { status: "clean", provider: "dev", ref: "race:clean" },
    );
    expect(status).toBe("matched");
    const [row] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, a.id));
    expect(row).toMatchObject({ scanStatus: "matched", legalHold: true });
  });

  // Was a hole (R42-derived): recordDerivedScan, the other verdict writer, set the child's scan_status
  // to the parent's with no `scan_status <> 'matched'` guard, so a clean parent flipped a matched, held
  // poster back to "clean" (servable by /api/media) with legal_hold still true. It now keeps the match.
  it("recordDerivedScan does not overwrite a matched child", async () => {
    const u = await makeUser();
    const matchedPoster = await matchedAsset(u.id);
    // A clean parent clip.
    const parentBytes = Buffer.from(`parent ${randomUUID()}`.repeat(32));
    const parentKey = `outputs/${u.id}/${randomUUID()}.webp`;
    await storage().put(parentKey, parentBytes, "image/webp");
    const [parent] = await getDb()
      .insert(mediaAssets)
      .values({ ownerId: u.id, kind: "image", storageKey: parentKey, mime: "image/webp", bytes: parentBytes.length, sha256: sha256(parentBytes), visibility: "private", scanStatus: "clean" })
      .returning();
    expect(await recordDerivedScan(matchedPoster.id, parent!.id)).toBe("matched");
    const [row] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, matchedPoster.id));
    expect(row).toMatchObject({ scanStatus: "matched", legalHold: true });
  });
});
