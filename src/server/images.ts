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

/** True for sharp's refusal of an image over limitInputPixels. */
export function isPixelLimitError(err: unknown): boolean {
  return err instanceof Error && /pixel limit/i.test(err.message);
}
