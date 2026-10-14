import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, isNotNull, isNull, lt, ne, notLike, or } from "drizzle-orm";
import sharp from "sharp";
import { getDb } from "@/server/db";
import { consentRecords, mediaAssets, templates, uploads } from "@/server/db/schema";
import { env } from "@/server/env";
import { HttpError } from "@/server/http";
import { acceptedImageFormat, isPixelLimitError, MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE, untrustedImage } from "@/server/images";
import { logger } from "@/server/log";
import { newStorageKey, sha256, storage } from "@/server/storage";
import { MAX_SCANNED_VIDEO_S, MAX_VIDEO_SIDE, probeVideo, scanAsset, scanFailClosed, type VideoInfo } from "@/server/safety/scan";

export type Asset = typeof mediaAssets.$inferSelect;

/**
 * Signed URL for an asset the viewer may see: public assets, or the viewer's own. Only assets the
 * abuse scanner cleared are ever signed (addendum §3); pending, unavailable and matched assets get
 * null, exactly like a deleted one, so nothing about them is confirmed.
 */
export async function assetUrl(
  asset: Pick<Asset, "storageKey" | "visibility" | "ownerId" | "deletedAt" | "scanStatus">,
  viewerId: string | null,
  opts?: { download?: string },
): Promise<string | null> {
  if (asset.deletedAt || asset.scanStatus !== "clean") return null;
  if (asset.visibility !== "public" && asset.ownerId !== viewerId) return null;
  const ttl = asset.visibility === "public" ? 3600 : env().MEDIA_URL_TTL_S;
  return storage().signedUrl(asset.storageKey, ttl, opts);
}

/**
 * True while a public asset is on show: a published, undeleted template uses it as its poster or
 * preview. Public assets are only ever template copies, so once the template is removed,
 * unpublished or its creator suspended, links issued earlier stop working (src/app/api/media).
 */
export async function publicAssetLive(assetId: string): Promise<boolean> {
  const [t] = await getDb()
    .select({ id: templates.id })
    .from(templates)
    .where(and(or(eq(templates.posterAssetId, assetId), eq(templates.previewAssetId, assetId)), eq(templates.status, "published"), isNull(templates.deletedAt)))
    .limit(1);
  return Boolean(t);
}

export async function assetUrlById(assetId: string | null, viewerId: string | null): Promise<string | null> {
  if (!assetId) return null;
  const [a] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
  return a ? assetUrl(a, viewerId) : null;
}

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
/** Room for the multipart framing and the small form fields around the file. */
export const FORM_OVERHEAD_BYTES = 1024 * 1024;

export type UploadResult = { assetId: string; kind: "image" | "video"; width: number | null; height: number | null; warnings: string[] };

/**
 * Accepts an upload only with a consent record that covers the people in it.
 * Images are decoded and re-encoded without transparency, which drops EXIF/GPS metadata and rejects
 * anything that is not really an image. Videos must be MP4, and are rewritten without their
 * container metadata (stripVideoMetadata) before they are stored or scanned.
 */
export async function acceptUpload(
  userId: string,
  file: { bytes: Buffer; declaredMime: string },
  consent: { statement: string; subjectLabel: string | null },
  purpose: "source" | "reference",
): Promise<UploadResult> {
  const warnings: string[] = [];
  let kind: "image" | "video";
  let body: Buffer;
  let mime: string;
  let width: number | null = null;
  let height: number | null = null;

  if (file.declaredMime.startsWith("video/")) {
    if (file.bytes.length > MAX_VIDEO_BYTES) throw new HttpError(413, "too_large", "Videos can be up to 100 MB.");
    if (file.bytes.subarray(4, 8).toString("ascii") !== "ftyp") throw new HttpError(415, "unsupported_type", "Videos must be MP4.");
    kind = "video";
    // Container metadata (GPS, device, creation time, titles) is dropped before anything is stored or scanned.
    body = await stripVideoMetadata(file.bytes);
    mime = "video/mp4";
  } else {
    if (file.bytes.length > MAX_IMAGE_BYTES) throw new HttpError(413, "too_large", "Images can be up to 20 MB.");
    // Only a JPEG, PNG or WebP by its first bytes is handed to sharp: anything else (an SVG above all, whose
    // parse cost the pixel limit does not bound) is refused without being parsed, whatever mime the client sent.
    if (!acceptedImageFormat(file.bytes)) throw new HttpError(415, "unsupported_type", "Use a JPG, PNG or WebP image.");
    // The pixel limit is checked from the header, before anything is decoded (a small PNG can hold a huge image).
    const unreadable = (err: unknown) =>
      isPixelLimitError(err)
        ? new HttpError(413, "too_large", `Images can be up to ${MAX_IMAGE_PIXELS / 1_000_000} megapixels.`)
        : new HttpError(415, "unsupported_type", "That file is not an image we can read. Use JPG, PNG or WebP.");
    let meta: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
    try {
      meta = await sharp(file.bytes, untrustedImage).metadata();
    } catch (err) {
      throw unreadable(err);
    }
    if (!meta.width || !meta.height || !["jpeg", "png", "webp"].includes(meta.format ?? "")) {
      throw new HttpError(415, "unsupported_type", "Use a JPG, PNG or WebP image.");
    }
    try {
      // Transparency is flattened onto black, as photoDnaJpeg flattens what it sends, so the stored file holds
      // exactly the pixels the hash matcher sees: no alpha channel is kept to hide a picture from the scan.
      body = await sharp(file.bytes, untrustedImage)
        .rotate()
        .resize({ width: MAX_IMAGE_SIDE, height: MAX_IMAGE_SIDE, fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#000000" })
        .webp({ quality: 92 })
        .toBuffer();
    } catch (err) {
      throw unreadable(err);
    }
    const out = await sharp(body).metadata();
    kind = "image";
    mime = "image/webp";
    width = out.width ?? null;
    height = out.height ?? null;
    if (Math.min(width ?? 0, height ?? 0) < 512) warnings.push("low_resolution");
  }

  const key = newStorageKey("uploads", userId, kind === "video" ? "mp4" : "webp");
  await storage().put(key, body, mime);
  const assetId = await getDb().transaction(async (tx) => {
    const [record] = await tx
      .insert(consentRecords)
      .values({ userId, kind: purpose === "reference" ? "likeness" : "upload_subject", statement: consent.statement, subjectLabel: consent.subjectLabel })
      .returning({ id: consentRecords.id });
    const [asset] = await tx
      .insert(mediaAssets)
      .values({ ownerId: userId, kind, storageKey: key, mime, bytes: body.length, width, height, sha256: sha256(body), visibility: "private" })
      .returning({ id: mediaAssets.id });
    await tx.insert(uploads).values({ userId, assetId: asset!.id, purpose, consentRecordId: record!.id });
    return asset!.id;
  });
  // Abuse scan before the asset can be used or shown anywhere (addendum §3).
  const verdict = await scanAsset({ assetId, bytes: body, mime, kind, sha256: sha256(body), sourceSha256: sha256(file.bytes), ownerId: userId, origin: "upload" });
  // A match is held as evidence and the account is suspended; the reply says nothing about why.
  if (verdict === "matched") throw new HttpError(403, "upload_rejected", "This upload was rejected.");
  if (verdict === "unavailable") {
    if (scanFailClosed()) {
      // Fail closed: nothing unscanned is kept. The upload never happened as far as the library knows.
      await discardUnscannedUpload(assetId);
      throw new HttpError(503, "scan_unavailable", "We couldn't check this file right now. Try again in a few minutes.");
    }
    // Fail-open (operator's choice): kept as "unavailable", never served or usable until a rescan clears it.
    warnings.push("scan_pending");
  }
  // The upload was removed while it was being scanned (its consent withdrawn, say). The purge then left
  // the file alone because it had no verdict yet; now that it has one that is not a match, it goes.
  if (await purgeAssetsNow([assetId])) throw new HttpError(410, "upload_removed", "This upload was removed while it was being checked.");
  return { assetId, kind, width, height, warnings };
}

/**
 * Rewrites an MP4 without its container metadata: `ffmpeg -map_metadata -1 -c copy`, so no frame is
 * re-encoded. Global and per-stream tags (location, device, creation time, titles) and chapters go;
 * only the default video and audio streams are kept, which also drops timed-metadata tracks. A file
 * ffmpeg cannot read is refused rather than stored with its metadata, and so is a clip longer or
 * larger than the abuse scan covers (MAX_SCANNED_VIDEO_S, MAX_VIDEO_SIDE), since no part of a stored
 * clip may go unscanned.
 */
async function stripVideoMetadata(clip: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hl-upload-"));
  const processingUnavailable = (err: string) => {
    logger.error("upload.video_strip_unavailable", { err });
    return new HttpError(503, "video_processing_unavailable", "We couldn't process videos right now. Try again in a few minutes.");
  };
  const unreadable = () => new HttpError(415, "unsupported_type", "We couldn't read that video. Use an MP4.");
  try {
    const input = path.join(dir, "in.mp4");
    const output = path.join(dir, "out.mp4");
    await writeFile(input, clip);
    await new Promise<void>((resolve, reject) => {
      const child = spawn("ffmpeg", ["-v", "error", "-y", "-i", input, "-map_metadata", "-1", "-map_chapters", "-1", "-c", "copy", "-movflags", "+faststart", "-f", "mp4", output], {
        stdio: ["ignore", "ignore", "ignore"],
        signal: AbortSignal.timeout(120_000),
      });
      child.on("error", (e) => reject(processingUnavailable(e.name)));
      child.on("close", (code) => (code === 0 ? resolve() : reject(unreadable())));
    });
    let info: VideoInfo;
    try {
      info = await probeVideo(output);
    } catch (err) {
      throw (err as { code?: string }).code === "tool_unavailable" ? processingUnavailable("ffprobe") : unreadable();
    }
    if (info.durationS > MAX_SCANNED_VIDEO_S) throw new HttpError(422, "too_long", `Videos can be up to ${MAX_SCANNED_VIDEO_S} seconds.`);
    if (Math.max(info.width, info.height) > MAX_VIDEO_SIDE) throw new HttpError(413, "too_large", `Videos can be up to ${MAX_VIDEO_SIDE} pixels on a side.`);
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Removes an upload the scanner could not check: its rows go, and its bytes are deleted now. Held evidence is left alone. */
async function discardUnscannedUpload(assetId: string) {
  await getDb().transaction(async (tx) => {
    const [asset] = await tx.select({ legalHold: mediaAssets.legalHold }).from(mediaAssets).where(eq(mediaAssets.id, assetId)).for("update");
    if (!asset || asset.legalHold) return;
    const [row] = await tx.delete(uploads).where(eq(uploads.assetId, assetId)).returning({ consentRecordId: uploads.consentRecordId });
    if (row?.consentRecordId) await tx.delete(consentRecords).where(eq(consentRecords.id, row.consentRecordId));
    await tx.update(mediaAssets).set({ deletedAt: new Date() }).where(and(eq(mediaAssets.id, assetId), eq(mediaAssets.legalHold, false)));
  });
  await purgeAssetsNow([assetId]);
}

/**
 * Removes stored bytes for assets soft-deleted longer ago than the retention window.
 * Assets under legal hold (abuse-scan evidence) are never purged, and neither is a file with no
 * verdict (scan_status 'pending', such as a match nothing could be written for): it waits for
 * scripts/scan-backfill.ts to scan it, however long that takes, and goes on a later run if clean.
 */
export async function purgeDeletedMedia(retentionDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const rows = await getDb()
    .select({ id: mediaAssets.id, key: mediaAssets.storageKey })
    .from(mediaAssets)
    .where(
      and(
        isNotNull(mediaAssets.deletedAt),
        lt(mediaAssets.deletedAt, cutoff),
        notLike(mediaAssets.storageKey, "purged/%"),
        eq(mediaAssets.legalHold, false),
        ne(mediaAssets.scanStatus, "pending"),
      ),
    )
    .limit(500);
  return purgeRows(rows);
}

/**
 * Removes the files of already soft-deleted assets right away, without waiting for the retention window.
 * Held assets are skipped, and so is a file with no verdict yet (scan_status 'pending'): its scan may
 * still be running and about to hold it as evidence. acceptUpload purges an upload removed mid-scan
 * once its verdict is in; anything else left pending is rescanned by scripts/scan-backfill.ts.
 */
export async function purgeAssetsNow(assetIds: string[]): Promise<number> {
  if (!assetIds.length) return 0;
  const rows = await getDb()
    .select({ id: mediaAssets.id, key: mediaAssets.storageKey })
    .from(mediaAssets)
    .where(
      and(
        inArray(mediaAssets.id, assetIds),
        isNotNull(mediaAssets.deletedAt),
        notLike(mediaAssets.storageKey, "purged/%"),
        eq(mediaAssets.legalHold, false),
        ne(mediaAssets.scanStatus, "pending"),
      ),
    );
  return purgeRows(rows);
}

/**
 * Deletes each file under a lock on its row, after reading the row again: a hold placed since the
 * batch was chosen (a takedown, a scan match) wins, and a hold placed during the delete waits for it.
 */
async function purgeRows(rows: { id: string; key: string }[]): Promise<number> {
  let n = 0;
  for (const r of rows) {
    try {
      const purged = await getDb().transaction(async (tx) => {
        const [still] = await tx
          .select({ id: mediaAssets.id })
          .from(mediaAssets)
          .where(and(eq(mediaAssets.id, r.id), eq(mediaAssets.storageKey, r.key), isNotNull(mediaAssets.deletedAt), eq(mediaAssets.legalHold, false)))
          .for("update");
        if (!still) return false;
        await storage().delete(r.key);
        await tx.update(mediaAssets).set({ bytes: 0, storageKey: `purged/${r.id}` }).where(eq(mediaAssets.id, r.id));
        return true;
      });
      if (purged) n++;
    } catch (err) {
      logger.warn("purge failed for asset", { assetId: r.id, err });
    }
  }
  return n;
}
