import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env, mediaSigningSecret } from "@/server/env";

export interface StorageDriver {
  put(key: string, body: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** A short-lived URL. Callers must check ownership before asking for one. */
  signedUrl(key: string, ttlSeconds: number, opts?: { download?: string }): Promise<string>;
}

export function newStorageKey(scope: "uploads" | "outputs" | "templates" | "avatars", ownerId: string, ext: string): string {
  return `${scope}/${ownerId}/${randomUUID()}.${ext}`;
}

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

// ── Local driver: files on disk, served by /api/media with an HMAC signature ──

function signLocal(key: string, exp: number, download: string): string {
  return createHmac("sha256", mediaSigningSecret()).update(`${key}\n${exp}\n${download}`).digest("base64url");
}

export function verifyLocalSignature(key: string, exp: number, download: string, sig: string, now = Date.now()): boolean {
  if (!Number.isFinite(exp) || exp * 1000 < now) return false;
  const expected = Buffer.from(signLocal(key, exp, download));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

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
  async delete(key: string) {
    await rm(safeLocalPath(this.root, key), { force: true });
  }
  async signedUrl(key: string, ttlSeconds: number, opts?: { download?: string }) {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const download = opts?.download ?? "";
    const q = new URLSearchParams({ k: key, e: String(exp), s: signLocal(key, exp, download) });
    if (download) q.set("d", download);
    return `/api/media?${q.toString()}`;
  }
}

// ── S3-compatible driver (AWS S3, R2, MinIO, …) ──

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
  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
  async signedUrl(key: string, ttlSeconds: number, opts?: { download?: string }) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: opts?.download ? `attachment; filename="${opts.download}"` : undefined,
      }),
      { expiresIn: ttlSeconds },
    );
  }
}

let driver: StorageDriver | undefined;

export function storage(): StorageDriver {
  if (driver) return driver;
  const e = env();
  driver = e.STORAGE_DRIVER === "s3" ? new S3Driver(e.S3_BUCKET!) : new LocalDriver(path.resolve(e.STORAGE_LOCAL_DIR));
  return driver;
}
