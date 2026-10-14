import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env, mediaSigningSecret } from "@/server/env";

export interface StorageDriver {
  put(key: string, body: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** The stored size in bytes. Throws when there is no such file. */
  size(key: string): Promise<number>;
  /** Streams the bytes from start to end inclusive (the whole file without a range), without loading the rest. */
  read(key: string, range?: { start: number; end: number }): Promise<ReadableStream<Uint8Array>>;
  delete(key: string): Promise<void>;
  /** A short-lived /api/media URL (mediaUrl). Callers must check ownership before asking for one. */
  signedUrl(key: string, ttlSeconds: number, opts?: { download?: string }): Promise<string>;
}

export function newStorageKey(scope: "uploads" | "outputs" | "templates" | "avatars", ownerId: string, ext: string): string {
  return `${scope}/${ownerId}/${randomUUID()}.${ext}`;
}

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

// ── Media links: every driver's files are served by /api/media with an HMAC signature ──

function signLocal(key: string, exp: number, download: string): string {
  return createHmac("sha256", mediaSigningSecret()).update(`${key}\n${exp}\n${download}`).digest("base64url");
}

export function verifyLocalSignature(key: string, exp: number, download: string, sig: string, now = Date.now()): boolean {
  if (!Number.isFinite(exp) || exp * 1000 < now) return false;
  const expected = Buffer.from(signLocal(key, exp, download));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * The link for a stored file, whichever driver holds it. It always points at /api/media, never at
 * the bucket: that route re-reads the asset row on every request and refuses anything deleted,
 * held or not cleared by the abuse scan, so a removed or matched asset stops being served at once,
 * even through a link issued before. A presigned bucket URL would keep serving until it expired,
 * and nothing could revoke it.
 */
export function mediaUrl(key: string, ttlSeconds: number, opts?: { download?: string }): string {
  // Round expiry up to a boundary a tenth of the TTL long, so URLs stay stable (and cacheable) for that
  // long while a link never lives more than 1.1 x its TTL (rounding to the whole TTL allowed almost 2x).
  const now = Math.floor(Date.now() / 1000);
  const window = Math.max(1, Math.floor(ttlSeconds / 10));
  const exp = Math.ceil((now + ttlSeconds) / window) * window;
  const download = opts?.download ?? "";
  const q = new URLSearchParams({ k: key, e: String(exp), s: signLocal(key, exp, download) });
  if (download) q.set("d", download);
  return `/api/media?${q.toString()}`;
}

// ── Local driver: files on disk ──

function safeLocalPath(root: string, key: string): string {
  if (!/^[a-z]+\/[0-9a-zA-Z-]+\/[0-9a-zA-Z-]+\.[a-z0-9]+$/.test(key)) throw new Error("invalid storage key");
  const resolved = path.resolve(root, key);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new Error("invalid storage key");
  return resolved;
}

class LocalDriver implements StorageDriver {
  constructor(private readonly root: string) {}
  async put(key: string, body: Buffer) {
    const p = safeLocalPath(this.root, key);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, body);
  }
  async get(key: string) {
    return readFile(safeLocalPath(this.root, key));
  }
  async size(key: string) {
    return (await stat(safeLocalPath(this.root, key))).size;
  }
  async read(key: string, range?: { start: number; end: number }) {
    return Readable.toWeb(createReadStream(safeLocalPath(this.root, key), range)) as ReadableStream<Uint8Array>;
  }
  async delete(key: string) {
    await rm(safeLocalPath(this.root, key), { force: true });
  }
  async signedUrl(key: string, ttlSeconds: number, opts?: { download?: string }) {
    return mediaUrl(key, ttlSeconds, opts);
  }
}

// ── S3-compatible driver (AWS S3, R2, MinIO, …): a private bucket, read only by the app ──

class S3Driver implements StorageDriver {
  private client: S3Client;
  constructor(private readonly bucket: string) {
    const e = env();
    this.client = new S3Client({
      region: e.S3_REGION ?? "auto",
      endpoint: e.S3_ENDPOINT,
      forcePathStyle: Boolean(e.S3_ENDPOINT),
      credentials:
        e.S3_ACCESS_KEY_ID && e.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY }
          : undefined,
    });
  }
  async put(key: string, body: Buffer, mime: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: mime }));
  }
  async get(key: string) {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const bytes = await res.Body?.transformToByteArray();
    if (!bytes) throw new Error("empty object");
    return Buffer.from(bytes);
  }
  async size(key: string) {
    const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    return res.ContentLength ?? 0;
  }
  async read(key: string, range?: { start: number; end: number }) {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: range ? `bytes=${range.start}-${range.end}` : undefined }));
    if (!res.Body) throw new Error("empty object");
    return res.Body.transformToWebStream() as ReadableStream<Uint8Array>;
  }
  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
  /** Not a presigned bucket URL: S3 media is served through /api/media too, so removal takes effect at once (mediaUrl). */
  async signedUrl(key: string, ttlSeconds: number, opts?: { download?: string }) {
    return mediaUrl(key, ttlSeconds, opts);
  }
}

let driver: StorageDriver | undefined;

export function storage(): StorageDriver {
  if (driver) return driver;
  const e = env();
  driver = e.STORAGE_DRIVER === "s3" ? new S3Driver(e.S3_BUCKET!) : new LocalDriver(path.resolve(e.STORAGE_LOCAL_DIR));
  return driver;
}
