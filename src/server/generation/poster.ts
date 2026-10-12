import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

/**
 * Pulls one frame from a clip and returns it as WebP. Returns null when ffmpeg is
 * missing or the clip cannot be read; a poster is a convenience, never a reason to fail a job.
 */
export async function videoPoster(clip: Buffer, atSeconds = 0.5): Promise<{ bytes: Buffer; width: number; height: number } | null> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hl-poster-"));
  try {
    const input = path.join(dir, "in.mp4");
    const output = path.join(dir, "frame.png");
    await writeFile(input, clip);
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn("ffmpeg", ["-v", "error", "-y", "-ss", String(atSeconds), "-i", input, "-frames:v", "1", output], { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    });
    if (!ok) return null;
    const bytes = await sharp(await readFile(output)).webp({ quality: 82 }).toBuffer();
    const meta = await sharp(bytes).metadata();
    return { bytes, width: meta.width ?? 0, height: meta.height ?? 0 };
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
