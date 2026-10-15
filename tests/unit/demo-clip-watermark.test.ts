import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { getModel, type GenerationMode } from "@/server/ai/registry";
import { DEMO_WATERMARK, demoProvider, demoSvg } from "@/server/ai/providers/demo";
import type { ProviderInput, ProviderRequest } from "@/server/ai/providers/types";
import type { GenerationParams } from "@/server/db/schema";
import { videoPoster } from "@/server/generation/poster";

// Every demo clip carries the still's watermark band, whole and in place, in every frame: the camera moves
// the picture, never the band. Real clips are rendered with ffmpeg and compared with the demo still made
// from the same prompt, seed, aspect ratio and start (text or photo), which is what the image model returns.

const still = getModel("demo-still")!;
const motion = getModel("demo-motion")!;
const PROMPT = "a quiet lakeside cabin at dusk, warm window light";
const FPS = 24;
// The default motion and every named one (orbit, handheld and static fall back to the default today).
const CAMERAS = [undefined, "slow push in", "pull back", "pan left", "pan right", "tilt up", "tilt down", "static", "orbit", "handheld"] as const;
// Mean absolute difference (0 to 255, over R, G and B) allowed between a frame's band and the still's band.
// H.264 at CRF 26 with 4:2:0 chroma costs about 3; a band shifted by one row already costs about 6, and one
// that was scaled, moved or cropped away costs from 8 to over 60.
const MAX_BAND_DIFF = 4.5;

const ctx = () => ({ signal: new AbortController().signal, onProviderJobId: async () => undefined });

function request(mode: GenerationMode, params: GenerationParams, inputs: ProviderInput[]): ProviderRequest {
  const model = mode.endsWith("video") ? motion : still;
  return { jobId: `wm-${Math.random().toString(36).slice(2)}`, model, mode, prompt: PROMPT, negativePrompt: "", params, inputs };
}

function ffmpeg(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-400)}`))));
  });
}

/** The band rows (bottom 9%) of every frame of the clip, as raw RGB. */
async function clipBands(clip: Buffer, width: number, height: number, band: number): Promise<Buffer[]> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hl-wm-test-"));
  try {
    const file = path.join(dir, "clip.mp4");
    await writeFile(file, clip);
    const raw = await ffmpeg(["-v", "error", "-i", file, "-vf", `format=rgb24,crop=${width}:${band}:0:${height - band}`, "-fps_mode", "passthrough", "-f", "rawvideo", "pipe:1"]);
    const size = width * band * 3;
    return Array.from({ length: raw.length / size }, (_, i) => raw.subarray(i * size, (i + 1) * size));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function rgbBand(image: Buffer, width: number, height: number, band: number): Promise<Buffer> {
  return sharp(image).removeAlpha().extract({ left: 0, top: height - band, width, height: band }).raw().toBuffer();
}

const meanDiff = (a: Buffer, b: Buffer) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length;
};

let photo: Buffer | undefined;
/** A stand-in upload: a colored gradient with noise, so a band made from it would show. */
async function upload(): Promise<ProviderInput> {
  photo ??= await sharp({ create: { width: 900, height: 1200, channels: 3, background: "#6a4a8c", noise: { type: "gaussian", mean: 140, sigma: 50 } } })
    .png()
    .toBuffer();
  return { kind: "image", mime: "image/png", bytes: photo, width: 900, height: 1200, role: "source" };
}

/** Renders one clip and its still, and checks the band in every frame of the clip and on its poster. */
async function checkClip(camera: (typeof CAMERAS)[number], i: number, start: "text" | "photo") {
  // Spread aspect ratios, intensities and lengths over the cases, so each camera meets several of each.
  const aspectRatio = motion.aspectRatios[(i + (start === "photo" ? 1 : 0)) % motion.aspectRatios.length]!;
  const motionIntensity = [1, 10, 5, 7, 3][(i * 2 + (start === "photo" ? 1 : 0)) % 5]!;
  // Short clips keep the suite quick; one 3 s clip covers the case the fact-check measured (default motion, t = 3 s).
  const durationS = camera === undefined && start === "text" ? 3 : 1;
  const inputs = start === "photo" ? [await upload()] : [];
  const params = { aspectRatio, seed: 7 + i, motionIntensity, durationS, ...(camera ? { cameraMovement: camera } : {}) };

  const [image] = await demoProvider.execute(request(start === "photo" ? "image_to_image" : "text_to_image", { aspectRatio, seed: 7 + i, quality: "hd" }, inputs), ctx());
  const [clip] = await demoProvider.execute(request(start === "photo" ? "image_to_video" : "text_to_video", params, inputs), ctx());
  const { width, height } = clip!;
  expect([width, height]).toEqual([image!.width, image!.height]);
  const band = Math.round(height! * 0.09);
  const expected = await rgbBand(image!.bytes, width!, height!, band);

  const label = `${camera ?? "default"}, ${start} start, ${aspectRatio}, intensity ${motionIntensity}`;
  const frames = await clipBands(clip!.bytes, width!, height!, band);
  expect(frames.length, `${label}: frame count`).toBe(durationS * FPS);
  const picks = { first: 0, middle: Math.floor(frames.length / 2), last: frames.length - 1 };
  for (const [name, n] of Object.entries(picks)) {
    expect(meanDiff(frames[n]!, expected), `${label}: band in the ${name} frame`).toBeLessThan(MAX_BAND_DIFF);
  }
  const worst = Math.max(...frames.map((f) => meanDiff(f, expected)));
  expect(worst, `${label}: band in the worst frame`).toBeLessThan(MAX_BAND_DIFF);

  // The poster the processor stores (a frame at 0.5 s) carries the band too.
  const poster = await videoPoster(clip!.bytes);
  expect(poster, `${label}: poster frame`).not.toBeNull();
  expect(meanDiff(await rgbBand(poster!.bytes, width!, height!, band), expected), `${label}: band on the poster`).toBeLessThan(MAX_BAND_DIFF);
}

describe("demo clips keep the watermark band in every frame", () => {
  CAMERAS.forEach((camera, i) => {
    it(`${camera ?? "default motion"}: text start and photo start`, async () => {
      await Promise.all([checkClip(camera, i, "text"), checkClip(camera, i, "photo")]);
    });
  });

  it("still draws the band into demo images themselves", async () => {
    const svg = demoSvg(PROMPT, 3, 1024, 1280);
    expect(svg).toContain(DEMO_WATERMARK);
    expect(demoSvg(PROMPT, 3, 1024, 1280, { band: false })).not.toContain(DEMO_WATERMARK);
    const [image] = await demoProvider.execute(request("text_to_image", { aspectRatio: "4:5", seed: 3, quality: "hd" }, []), ctx());
    expect([image!.width, image!.height]).toEqual([1024, 1280]);
    const art = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer();
    expect(meanDiff(await sharp(image!.bytes).removeAlpha().raw().toBuffer(), art)).toBeLessThan(3);
  });
});
