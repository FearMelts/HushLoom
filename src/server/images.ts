import type { SharpOptions } from "sharp";

/**
 * Bounds for decoding images that arrive from users or providers. Without them sharp decodes up to
 * 268 megapixels, so one small, highly compressed PNG costs well over a gigabyte of memory.
 * A 40 MP decode peaks around 275 MB; uploads are then stored downscaled to fit MAX_IMAGE_SIDE.
 */
export const MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_IMAGE_SIDE = 4096;

/** sharp input options for every untrusted image: only the first frame of an animation or a multi-page file, and never more than MAX_IMAGE_PIXELS. */
export const untrustedImage = { limitInputPixels: MAX_IMAGE_PIXELS, pages: 1 } satisfies SharpOptions;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The accepted image format of outside bytes, read from their first bytes, or null. Only these reach a
 * decoder: limitInputPixels bounds what a JPEG, PNG or WebP costs, but not formats whose cost is in the
 * document rather than the pixels. An 8 x 8 SVG of a few hundred bytes can expand entities into 100,000
 * elements, and sharp parses all of them (most of a second each time) before the format is known.
 */
export function acceptedImageFormat(bytes: Buffer): "jpeg" | "png" | "webp" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "png";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

/** True for sharp's refusal of an image over limitInputPixels. */
export function isPixelLimitError(err: unknown): boolean {
  return err instanceof Error && /pixel limit/i.test(err.message);
}
