import sharp from "sharp";
import { z } from "zod";
import { env } from "@/server/env";
import type { ScanProvider, ScanVerdict } from "../types";

/**
 * Microsoft PhotoDNA Cloud Service, "Match" operation (addendum §3).
 *
 * UNVERIFIED: written from public material and never run against the service; PhotoDNA access
 * needs Microsoft's approval, and the full API reference is only given to approved accounts.
 * What this relies on, and where it comes from:
 * - POST raw image bytes with `Content-Type: image/jpeg` (also gif/png/bmp/tiff) and the key in
 *   `Ocp-Apim-Subscription-Key`: the Content Moderator "ProcessImage/Match" reference
 *   (learn.microsoft.com/rest/api/cognitiveservices/contentmoderator/image-moderation/match) and
 *   Wikimedia's MediaModeration extension (MediaModerationPhotoDNAServiceProvider.php), which
 *   posts image bytes with those two headers to a configured PhotoDNA URL.
 * - Response JSON `{ Status: { Code, Description, Exception }, IsMatch, TrackingId, ContentId,
 *   MatchDetails, ... }`: the same Microsoft reference and Wikimedia task T336205, which also
 *   notes a 4 MB size cap and a 5 requests/second rate limit.
 * - `Status.Code === 3000` meaning success: from PhotoDNA's own documentation as remembered, not
 *   re-checked. Anything else is treated as "unavailable", so a wrong assumption fails closed.
 * The endpoint is PHOTODNA_ENDPOINT exactly as Microsoft issues it (no default is guessed).
 */
const MAX_BYTES = 4 * 1024 * 1024;
const MIN_INTERVAL_MS = 220; // stays under 5 requests per second from one process

const responseSchema = z
  .object({
    Status: z.object({ Code: z.number(), Description: z.string().nullish(), Exception: z.unknown().optional() }).passthrough(),
    IsMatch: z.boolean(),
    TrackingId: z.string().nullish(),
    ContentId: z.string().nullish(),
  })
  .passthrough();

let lastCall = 0;
async function throttle() {
  const wait = lastCall + MIN_INTERVAL_MS - Date.now();
  lastCall = Math.max(Date.now(), lastCall + MIN_INTERVAL_MS);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

/** PhotoDNA does not read WebP; send a JPEG under the size cap. */
export async function photoDnaJpeg(bytes: Buffer): Promise<Buffer> {
  for (const [side, quality] of [
    [2048, 88],
    [1600, 80],
    [1200, 72],
  ] as const) {
    const jpeg = await sharp(bytes).rotate().resize({ width: side, height: side, fit: "inside", withoutEnlargement: true }).flatten({ background: "#000" }).jpeg({ quality }).toBuffer();
    if (jpeg.length <= MAX_BYTES) return jpeg;
  }
  throw new Error("image stays above the 4 MB PhotoDNA limit after downscaling");
}

const unavailable = (detail: string): ScanVerdict => ({ status: "unavailable", provider: "photodna", detail });

export const photoDnaProvider: ScanProvider = {
  key: "photodna",
  label: "Microsoft PhotoDNA (hash match)",
  isDev: false,
  capabilities: { hashMatch: true, classifier: false, video: false, preStorage: true },
  isConfigured: () => Boolean(env().PHOTODNA_API_KEY && env().PHOTODNA_ENDPOINT),

  async scan(input) {
    const { PHOTODNA_API_KEY: apiKey, PHOTODNA_ENDPOINT: endpoint, SCAN_TIMEOUT_S } = env();
    if (!apiKey || !endpoint) return unavailable("PhotoDNA is not configured (PHOTODNA_API_KEY, PHOTODNA_ENDPOINT)");
    if (input.kind !== "image") return unavailable("PhotoDNA matches still images; videos are sent as keyframes");
    let body: Buffer;
    try {
      body = await photoDnaJpeg(input.bytes);
    } catch (err) {
      return unavailable(`could not prepare the image: ${(err as Error).message}`);
    }
    await throttle();
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "image/jpeg", "Ocp-Apim-Subscription-Key": apiKey },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(SCAN_TIMEOUT_S * 1000),
      });
    } catch (err) {
      return unavailable(`PhotoDNA request failed: ${(err as Error).name}`);
    }
    if (!res.ok) return unavailable(`PhotoDNA answered HTTP ${res.status}`);
    const parsed = responseSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) return unavailable("PhotoDNA answered with an unexpected body");
    const r = parsed.data;
    if (r.Status.Code !== 3000) return unavailable(`PhotoDNA status ${r.Status.Code}${r.Status.Description ? ` (${r.Status.Description})` : ""}`);
    const ref = r.TrackingId ?? r.ContentId ?? undefined;
    if (r.IsMatch) return { status: "matched", provider: "photodna", category: "csam", ref, detail: "PhotoDNA reported a match" };
    return { status: "clean", provider: "photodna", ref };
  },
};
