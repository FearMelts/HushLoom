import { and, eq, inArray, isNotNull, lt, notLike } from "drizzle-orm";
import sharp from "sharp";
import { getDb } from "@/server/db";
import { consentRecords, mediaAssets, uploads } from "@/server/db/schema";
import { env } from "@/server/env";
import { HttpError } from "@/server/http";
import { logger } from "@/server/log";
import { newStorageKey, sha256, storage } from "@/server/storage";
import { scanAsset } from "@/server/safety/scan";

export type Asset = typeof mediaAssets.$inferSelect;

/** Signed URL for an asset the viewer may see: public assets, or the viewer's own. */
export async function assetUrl(asset: Pick<Asset, "storageKey" | "visibility" | "ownerId" | "deletedAt">, viewerId: string | null, opts?: { download?: string }): Promise<string | null> {
  if (asset.deletedAt) return null;
  if (asset.visibility !== "public" && asset.ownerId !== viewerId) return null;
  const ttl = asset.visibility === "public" ? 3600 : env().MEDIA_URL_TTL_S;
  return storage().signedUrl(asset.storageKey, ttl, opts);
}

export async function assetUrlById(assetId: string | null, viewerId: string | null): Promise<string | null> {
  if (!assetId) return null;
  const [a] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
  return a ? assetUrl(a, viewerId) : null;
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

export type UploadResult = { assetId: string; kind: "image" | "video"; width: number | null; height: number | null; warnings: string[] };

/**
 * Accepts an upload only with a consent record that covers the people in it.
 * Images are decoded and re-encoded, which drops EXIF/GPS metadata and rejects
 * anything that is not really an image. Videos must be MP4.
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
    body = file.bytes;
    mime = "video/mp4";
  } else {
    if (file.bytes.length > MAX_IMAGE_BYTES) throw new HttpError(413, "too_large", "Images can be up to 20 MB.");
    let meta: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
    try {
      meta = await sharp(file.bytes).metadata();
    } catch {
      throw new HttpError(415, "unsupported_type", "That file is not an image we can read. Use JPG, PNG or WebP.");
    }
    if (!meta.width || !meta.height || !["jpeg", "png", "webp"].includes(meta.format ?? "")) {
      throw new HttpError(415, "unsupported_type", "Use a JPG, PNG or WebP image.");
    }
    body = await sharp(file.bytes).rotate().webp({ quality: 92 }).toBuffer();
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
  // Abuse scan before the asset can be used anywhere (addendum §3). The scanning track decides what
  // a "matched" or "unavailable" verdict does; nothing is served until the asset is "clean".
  const digest = sha256(body);
  const verdict = await scanAsset({ assetId, bytes: body, mime, kind, sha256: digest, ownerId: userId, origin: "upload" });
  if (verdict !== "clean") warnings.push(`scan_${verdict}`);
  return { assetId, kind, width, height, warnings };
}

/** Removes stored bytes for assets soft-deleted longer ago than the retention window. */
export async function purgeDeletedMedia(retentionDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const rows = await getDb()
    .select({ id: mediaAssets.id, key: mediaAssets.storageKey })
    .from(mediaAssets)
    .where(and(isNotNull(mediaAssets.deletedAt), lt(mediaAssets.deletedAt, cutoff), notLike(mediaAssets.storageKey, "purged/%")))
    .limit(500);
  return purgeRows(rows);
}

/** Removes the files of already soft-deleted assets right away, without waiting for the retention window. */
export async function purgeAssetsNow(assetIds: string[]): Promise<number> {
  if (!assetIds.length) return 0;
  const rows = await getDb()
    .select({ id: mediaAssets.id, key: mediaAssets.storageKey })
    .from(mediaAssets)
    .where(and(inArray(mediaAssets.id, assetIds), isNotNull(mediaAssets.deletedAt), notLike(mediaAssets.storageKey, "purged/%")));
  return purgeRows(rows);
}

async function purgeRows(rows: { id: string; key: string }[]): Promise<number> {
  let n = 0;
  for (const r of rows) {
    try {
      await storage().delete(r.key);
      await getDb().update(mediaAssets).set({ bytes: 0, storageKey: `purged/${r.id}` }).where(eq(mediaAssets.id, r.id));
      n++;
    } catch (err) {
      logger.warn("purge failed for asset", { assetId: r.id, err });
    }
  }
  return n;
}
