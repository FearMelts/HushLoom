import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { env } from "@/server/env";
import { untrustedImage } from "@/server/images";
import { ProviderError, type ExecuteContext, type ProviderAdapter, type ProviderOutput, type ProviderRequest } from "./types";

/**
 * Development demonstration provider. It produces clearly watermarked procedural
 * art so the whole pipeline (queue, storage, credits, collection) can run end to
 * end without an AI vendor. It is never presented as AI output.
 */

export const DEMO_WATERMARK = "DEMO OUTPUT · NOT AI-GENERATED";

function dims(aspect: string | undefined, longSide: number): { width: number; height: number } {
  const [w, h] = (aspect ?? "4:5").split(":").map(Number) as [number, number];
  const ratio = w / h;
  const width = ratio >= 1 ? longSide : Math.round(longSide * ratio);
  const height = ratio >= 1 ? Math.round(longSide / ratio) : longSide;
  // Encoders need even sizes.
  return { width: width - (width % 2), height: height - (height % 2) };
}

function escapeXml(s: string) {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}

function seededPalette(seedText: string) {
  const h = createHash("sha256").update(seedText).digest();
  const hue = (i: number) => (h[i]! * 360) / 255;
  return {
    a: `hsl(${hue(0)}, 70%, 45%)`,
    b: `hsl(${hue(1)}, 65%, 30%)`,
    c: `hsl(${hue(2)}, 80%, 60%)`,
    x: [h[3]! / 255, h[4]! / 255, h[5]! / 255],
    y: [h[6]! / 255, h[7]! / 255, h[8]! / 255],
  };
}

export function demoSvg(prompt: string, seed: number, width: number, height: number): string {
  const p = seededPalette(`${prompt}|${seed}`);
  const caption = escapeXml(prompt.length > 70 ? `${prompt.slice(0, 67)}…` : prompt);
  const band = Math.round(height * 0.09);
  const fs = Math.max(14, Math.round(width / 26));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <radialGradient id="g1" cx="${p.x[0]}" cy="${p.y[0]}" r="0.8"><stop offset="0" stop-color="${p.c}"/><stop offset="1" stop-color="${p.c}" stop-opacity="0"/></radialGradient>
    <radialGradient id="g2" cx="${p.x[1]}" cy="${p.y[1]}" r="0.7"><stop offset="0" stop-color="${p.a}"/><stop offset="1" stop-color="${p.a}" stop-opacity="0"/></radialGradient>
    <pattern id="stripe" width="24" height="24" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="12" height="24" fill="#000" fill-opacity="0.18"/></pattern>
  </defs>
  <rect width="100%" height="100%" fill="${p.b}"/>
  <rect width="100%" height="100%" fill="url(#g2)"/>
  <rect width="100%" height="100%" fill="url(#g1)"/>
  <circle cx="${Math.round(width * p.x[2]!)}" cy="${Math.round(height * p.y[2]!)}" r="${Math.round(Math.min(width, height) * 0.22)}" fill="#fff" fill-opacity="0.08"/>
  <rect y="${height - band}" width="100%" height="${band}" fill="url(#stripe)"/>
  <rect y="${height - band}" width="100%" height="${band}" fill="#000" fill-opacity="0.55"/>
  <text x="50%" y="${height - band / 2}" dominant-baseline="middle" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700" font-size="${Math.round(band * 0.36)}" fill="#fff" letter-spacing="2">${DEMO_WATERMARK}</text>
  <text x="${Math.round(width * 0.06)}" y="${Math.round(height * 0.1)}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${fs}" fill="#fff" fill-opacity="0.85">${caption}</text>
</svg>`;
}

async function renderStill(req: ProviderRequest, longSide: number): Promise<{ png: Buffer; width: number; height: number }> {
  const { width, height } = dims(req.params.aspectRatio, longSide);
  const seed = req.params.seed ?? 0;
  const art = Buffer.from(demoSvg(req.prompt, seed, width, height));
  // Image-to-image uses the upload; reference-guided uses the character reference. The demo treats
  // both the same way: the photo, recolored, under the same watermark band. It is not a likeness match.
  const source = req.inputs.find((i) => i.kind === "image" && i.role !== "reference") ?? req.inputs.find((i) => i.kind === "image" && i.role === "reference");
  let img = sharp(art);
  if (source) {
    const base = await sharp(source.bytes, untrustedImage).resize(width, height, { fit: "cover" }).modulate({ saturation: 0.6 }).toBuffer();
    const overlay = await sharp(art).ensureAlpha(0.55).toBuffer();
    img = sharp(base).composite([{ input: overlay, blend: "over" }]);
  }
  const png = await img.png().toBuffer();
  return { png, width, height };
}

function run(cmd: string, args: string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"], signal });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) =>
      reject(e.name === "AbortError" ? new ProviderError("timeout", "demo render aborted", true) : new ProviderError("unsupported", `ffmpeg unavailable: ${e.message}`, false)),
    );
    child.on("close", (code) => (code === 0 ? resolve() : reject(new ProviderError("internal", `ffmpeg exited ${code}: ${stderr.slice(-400)}`, false))));
  });
}

function zoompanFor(camera: string | undefined, intensity: number, frames: number): string {
  const z = (0.0006 * intensity).toFixed(4);
  const move: Record<string, string> = {
    "slow push in": `z='min(zoom+${z},1.5)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
    "pull back": `z='if(eq(on,1),1.4,max(zoom-${z},1))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
    "pan left": `z=1.2:x='(iw-iw/zoom)*(1-on/${frames})':y='ih/2-(ih/zoom/2)'`,
    "pan right": `z=1.2:x='(iw-iw/zoom)*on/${frames}':y='ih/2-(ih/zoom/2)'`,
    "tilt up": `z=1.2:x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*(1-on/${frames})'`,
    "tilt down": `z=1.2:x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*on/${frames}'`,
  };
  return move[camera ?? ""] ?? `z='min(zoom+${z},1.3)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
}

export const demoProvider: ProviderAdapter = {
  key: "demo",
  isDemo: true,
  isConfigured: () => env().ENABLE_DEMO_PROVIDER === "true",

  async execute(req: ProviderRequest, ctx: ExecuteContext): Promise<ProviderOutput[]> {
    await ctx.onProviderJobId(`demo-${req.jobId}`);
    if (ctx.signal.aborted) throw new ProviderError("cancelled", "aborted before start", false);

    if (req.model.output === "image") {
      const longSide = req.params.quality === "4k" ? 2048 : 1280;
      const { png, width, height } = await renderStill(req, longSide);
      const webp = await sharp(png).webp({ quality: 88 }).toBuffer();
      return [{ mime: "image/webp", bytes: webp, width, height }];
    }

    const durationS = req.params.durationS ?? 5;
    const fps = 24;
    const frames = durationS * fps;
    const { png, width, height } = await renderStill(req, 1280);
    const dir = await mkdtemp(path.join(os.tmpdir(), "hl-demo-"));
    try {
      const inPath = path.join(dir, "still.png");
      const outPath = path.join(dir, "out.mp4");
      await writeFile(inPath, png);
      const zp = zoompanFor(req.params.cameraMovement, req.params.motionIntensity ?? 5, frames);
      await run(
        "ffmpeg",
        [
          "-v", "error", "-y", "-loop", "1", "-i", inPath,
          "-vf", `scale=${width * 2}:${height * 2},zoompan=${zp}:d=${frames}:s=${width}x${height}:fps=${fps},format=yuv420p`,
          "-t", String(durationS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-movflags", "+faststart", "-an", outPath,
        ],
        ctx.signal,
      );
      const bytes = await readFile(outPath);
      return [{ mime: "video/mp4", bytes, width, height, durationMs: durationS * 1000 }];
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};
