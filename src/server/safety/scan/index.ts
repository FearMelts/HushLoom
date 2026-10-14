import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, ne, or } from "drizzle-orm";
import { z } from "zod";
import { audit } from "@/server/audit";
import { getDb, type Tx } from "@/server/db";
import { accountFlags, mediaAssets, moderationEvents, sessions, templates, users } from "@/server/db/schema";
import { env } from "@/server/env";
import { logger } from "@/server/log";
import { sha256 } from "@/server/storage";
import { cloudflareEdgeProvider } from "./providers/cloudflare";
import { devScanProvider } from "./providers/dev";
import { photoDnaProvider } from "./providers/photodna";
import type { ScanInput, ScanProvider, ScanVerdict } from "./types";

/**
 * Abuse scanning (addendum §3). Every stored asset gets a recorded verdict on media_assets, and
 * only "clean" assets are ever signed, served, used as inputs or published (src/server/media.ts,
 * src/app/api/media/route.ts, src/server/templates/publish.ts). The pipeline fails closed:
 *
 * | verdict     | asset                         | owner                         | caller                                    |
 * | clean       | scan_status=clean             | -                             | continues                                 |
 * | matched     | matched + legal_hold, kept    | suspended + csam_match flag   | upload 403 / output job failed, refunded  |
 * | unavailable | unavailable, never served     | -                             | fail-closed: bytes deleted, 503 / retried |
 *
 * A match also opens a moderation "escalate" event (the human review queue at /admin/review)
 * and writes audit rows for the block and the suspension. Nothing here logs bytes or prompts:
 * only ids, hashes and provider references.
 */
export type ScanStatus = "clean" | "matched" | "unavailable";

export type ScanSubject = {
  assetId: string;
  bytes: Buffer;
  mime: string;
  kind: "image" | "video";
  sha256: string;
  ownerId: string | null;
  origin: "upload" | "output" | "seed" | "backfill";
  /** SHA-256 of an upload as received, before re-encoding. */
  sourceSha256?: string;
  /** The generation job an output came from, for the review queue. */
  jobId?: string;
};

export { setDevScanOverride, DEV_SCAN_FIXTURE_SHA256 } from "./providers/dev";

const PROVIDERS: Record<ScanProvider["key"], ScanProvider> = { dev: devScanProvider, photodna: photoDnaProvider, cloudflare: cloudflareEdgeProvider };

/** The active scanner, chosen by SCAN_PROVIDER. */
export function scanProvider(): ScanProvider {
  return PROVIDERS[env().SCAN_PROVIDER];
}

export function scanFailClosed(): boolean {
  return env().SCAN_FAIL_CLOSED === "true";
}

/** What the review page and the verification report say about scanning. Holds no secrets. */
export function scanSettings() {
  const p = scanProvider();
  return { provider: p.key, label: p.label, isDev: p.isDev, configured: p.isConfigured(), failClosed: scanFailClosed(), preStorage: p.capabilities.preStorage };
}

/** The longest clip the scan covers end to end. Longer clips are refused at upload and never cleared. */
export const MAX_SCANNED_VIDEO_S = 60;
/** The largest frame side the scan decodes. Larger clips are refused at upload and never cleared. */
export const MAX_VIDEO_SIDE = 4096;
/** Frames are scanned downscaled to fit this side (PhotoDNA hashes a much smaller grid), so each one stays a few MB. */
const FRAME_SIDE = 1024;
/** One frame for every second of the clip, plus every frame that differs sharply from the one before, up to these counts. */
const PERIODIC_MAX = MAX_SCANNED_VIDEO_S + 1;
const CHANGES_MAX = 60;
/** Mean absolute difference from the previous frame, in percent (ffmpeg scdet's mafd), that counts as a sharp change. Ordinary motion stays under 3; a cut is 15 or more. */
const CHANGE_MAFD = 10;

export type VideoInfo = { durationS: number; width: number; height: number };

const probeSchema = z.object({
  streams: z.array(z.object({ width: z.number().int().positive(), height: z.number().int().positive(), duration: z.coerce.number().optional() })).min(1),
  format: z.object({ duration: z.coerce.number().optional() }).optional(),
});

/**
 * Reads a clip's duration and frame size with ffprobe; the longer of the container and stream
 * durations counts. Throws when the clip has no readable video stream, and an error with
 * `code: "tool_unavailable"` when ffprobe is missing.
 */
export async function probeVideo(file: string): Promise<VideoInfo> {
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,duration:format=duration", "-of", "json", file], {
      stdio: ["ignore", "pipe", "ignore"],
      signal: AbortSignal.timeout(30_000),
    });
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout = (stdout + d.toString()).slice(0, 65_536)));
    child.on("error", (e) => reject(Object.assign(new Error(`ffprobe unavailable: ${e.name}`), { code: "tool_unavailable" })));
    child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`ffprobe exited ${code}`))));
  });
  let parsed: z.infer<typeof probeSchema>;
  try {
    parsed = probeSchema.parse(JSON.parse(out));
  } catch {
    throw new Error("the clip has no readable video stream");
  }
  const s = parsed.streams[0]!;
  const durations = [parsed.format?.duration, s.duration].filter((d): d is number => d !== undefined && Number.isFinite(d) && d > 0);
  if (!durations.length) throw new Error("the clip has no readable duration");
  return { durationS: Math.max(...durations), width: s.width, height: s.height };
}

function ffmpeg(args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"], signal: AbortSignal.timeout(env().SCAN_TIMEOUT_S * 2000) });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-300)));
    child.on("error", (e) => reject(new Error(`ffmpeg unavailable: ${e.name}`)));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr}`))));
  });
}

/**
 * Pulls frames as PNG across the whole clip: the frame on screen at every second (fps=1), plus every
 * frame that differs sharply from the frame before it (a cut, a flash, an inserted frame), so a shot
 * shorter than a second between two samples is still seen. Frames are downscaled to fit FRAME_SIDE
 * and read from disk one at a time as the caller asks for them. Throws, so the verdict is
 * "unavailable" and never clean, when ffmpeg is missing, the clip cannot be read, it runs longer
 * than MAX_SCANNED_VIDEO_S or is larger than MAX_VIDEO_SIDE, or it holds more frames than the caps
 * allow (frames past its stated duration, or more sharp changes than are sampled, such as a strobe).
 */
export async function* extractKeyframes(clip: Buffer): AsyncGenerator<{ frame: Buffer; index: number; total: number }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hl-scan-"));
  try {
    const input = path.join(dir, "in.mp4");
    await writeFile(input, clip);
    const info = await probeVideo(input);
    if (info.durationS > MAX_SCANNED_VIDEO_S) throw new Error(`the clip runs ${Math.ceil(info.durationS)} s, longer than the ${MAX_SCANNED_VIDEO_S} s the scan covers`);
    if (Math.max(info.width, info.height) > MAX_VIDEO_SIDE) throw new Error(`the clip is ${info.width}x${info.height}, larger than the ${MAX_VIDEO_SIDE} px the scan reads`);
    const fit = `scale=w='min(${FRAME_SIDE},iw)':h='min(${FRAME_SIDE},ih)':force_original_aspect_ratio=decrease`;
    await ffmpeg([
      // Two decoder threads at most, so one upload cannot take every core while it is scanned.
      "-v", "error", "-y", "-threads", "2", "-i", input, "-filter_complex_threads", "1",
      "-filter_complex", `[0:v]${fit},split=2[p][c];[p]fps=1[po];[c]scdet=threshold=100,metadata=mode=select:key=lavfi.scd.mafd:value=${CHANGE_MAFD}:function=greater[co]`,
      "-map", "[po]", "-fps_mode", "passthrough", "-frames:v", String(PERIODIC_MAX + 1), path.join(dir, "p-%04d.png"),
      "-map", "[co]", "-fps_mode", "passthrough", "-frames:v", String(CHANGES_MAX + 1), path.join(dir, "c-%04d.png"),
    ]);
    const names = await readdir(dir);
    const periodic = names.filter((n) => n.startsWith("p-")).sort();
    const changes = names.filter((n) => n.startsWith("c-")).sort();
    if (periodic.length > PERIODIC_MAX) throw new Error(`the clip has frames past the ${MAX_SCANNED_VIDEO_S} s the scan covers`);
    if (changes.length > CHANGES_MAX) throw new Error(`the clip changes sharply more than the ${CHANGES_MAX} times the scan samples`);
    const all = [...periodic, ...changes];
    for (const [index, n] of all.entries()) yield { frame: await readFile(path.join(dir, n)), index, total: all.length };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const unavailable = (provider: string, detail: string): ScanVerdict => ({ status: "unavailable", provider, detail });

async function withTimeout(p: Promise<ScanVerdict>, provider: string): Promise<ScanVerdict> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<ScanVerdict>((resolve) => {
    timer = setTimeout(() => resolve(unavailable(provider, "scanner timed out")), env().SCAN_TIMEOUT_S * 1000);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function scanVideo(input: ScanInput, provider: ScanProvider): Promise<ScanVerdict> {
  if (provider.capabilities.video) {
    const whole = await withTimeout(provider.scan(input), provider.key);
    if (whole.status !== "clean") return whole;
  }
  const frames = extractKeyframes(input.bytes);
  let scanned = 0;
  let firstRef: string | undefined;
  let recordedProvider = provider.key as string;
  try {
    for (;;) {
      let next: IteratorResult<{ frame: Buffer; index: number; total: number }>;
      try {
        next = await frames.next();
      } catch (err) {
        return unavailable(provider.key, `could not read keyframes: ${(err as Error).message.slice(0, 160)}`);
      }
      if (next.done) break;
      const { frame, index, total } = next.value;
      const v = await withTimeout(provider.scan({ bytes: frame, mime: "image/png", kind: "image", sha256: sha256(frame) }), provider.key);
      if (v.status === "matched") return { ...v, detail: `keyframe ${index + 1} of ${total}${v.detail ? `: ${v.detail}` : ""}` };
      if (v.status === "unavailable") return v;
      scanned++;
      firstRef ??= v.ref;
      recordedProvider = v.provider;
    }
  } finally {
    // Closes the generator when the scan stops early, which removes the frames from disk.
    await frames.return(undefined);
  }
  if (!scanned) return unavailable(provider.key, "the video has no readable frames");
  return { status: "clean", provider: recordedProvider, ref: `keyframes:${scanned}${firstRef ? `;${firstRef}` : ""}`.slice(0, 200) };
}

/** Runs the scanner on bytes. Never throws: any failure is an "unavailable" verdict. */
export async function runScan(input: ScanInput, provider: ScanProvider = scanProvider()): Promise<ScanVerdict> {
  try {
    if (input.kind === "video") return await scanVideo(input, provider);
    return await withTimeout(provider.scan(input), provider.key);
  } catch (err) {
    return unavailable(provider.key, `scanner error: ${(err as Error).message?.slice(0, 160) ?? "unknown"}`);
  }
}

/** Scans one stored asset and records the verdict on media_assets. Returns the recorded status. */
export async function scanAsset(subject: ScanSubject, tx?: Tx): Promise<ScanStatus> {
  const verdict = await runScan({ bytes: subject.bytes, mime: subject.mime, kind: subject.kind, sha256: subject.sha256, sourceSha256: subject.sourceSha256 });
  return recordVerdict(subject, verdict, tx);
}

/** Writes a verdict. A match holds the asset, suspends and flags the owner, and opens a review entry. */
export async function recordVerdict(subject: Omit<ScanSubject, "bytes">, verdict: ScanVerdict, tx?: Tx): Promise<ScanStatus> {
  const now = new Date();
  const log = { assetId: subject.assetId, origin: subject.origin, provider: verdict.provider };
  if (verdict.status !== "matched") {
    // A match stands until a person clears it in the review queue: a later verdict for the same asset
    // (a live scan that lost a race with the backfill, a retry) never overwrites it, and the caller is
    // told the asset is matched, so nothing treats the held evidence as unscanned and discards it.
    const [updated] = await (tx ?? getDb())
      .update(mediaAssets)
      .set({ scanStatus: verdict.status, scanProvider: verdict.provider, scanRef: verdict.status === "clean" ? (verdict.ref ?? null) : null, scannedAt: now })
      .where(and(eq(mediaAssets.id, subject.assetId), ne(mediaAssets.scanStatus, "matched")))
      .returning({ id: mediaAssets.id });
    if (!updated) {
      const [row] = await (tx ?? getDb()).select({ status: mediaAssets.scanStatus }).from(mediaAssets).where(eq(mediaAssets.id, subject.assetId));
      if (row?.status === "matched") return "matched";
    }
    if (verdict.status === "unavailable") logger.warn("scan.unavailable", { ...log, detail: verdict.detail, failClosed: scanFailClosed() });
    return verdict.status;
  }

  const handle = async (t: Tx): Promise<string | null> => {
    const [asset] = await t.select().from(mediaAssets).where(eq(mediaAssets.id, subject.assetId)).for("update");
    // Already handled (a repeat scan or a backfill re-run): one escalation and one flag per asset.
    if (!asset || asset.scanStatus === "matched") return null;
    await t
      .update(mediaAssets)
      .set({ scanStatus: "matched", scanProvider: verdict.provider, scanRef: verdict.ref ?? null, scannedAt: now, legalHold: true })
      .where(eq(mediaAssets.id, asset.id));
    if (asset.visibility === "public") {
      // A public copy found on a later scan takes its template down with it.
      await t
        .update(templates)
        .set({ status: "removed", updatedAt: now })
        .where(or(eq(templates.posterAssetId, asset.id), eq(templates.previewAssetId, asset.id)));
    }
    const ownerId = subject.ownerId ?? asset.ownerId;
    const subjectType = subject.origin === "upload" || (subject.origin !== "output" && asset.storageKey.startsWith("uploads/")) ? "upload" : "output";
    const details = {
      assetId: asset.id,
      sha256: asset.sha256,
      ...(subject.sourceSha256 && subject.sourceSha256 !== asset.sha256 ? { sourceSha256: subject.sourceSha256 } : {}),
      provider: verdict.provider,
      ref: verdict.ref ?? null,
      category: verdict.category,
      origin: subject.origin,
      ownerId,
      ...(subject.jobId ? { jobId: subject.jobId } : {}),
      storageKey: asset.storageKey,
    };
    const [event] = await t
      .insert(moderationEvents)
      .values({ subjectType, subjectId: asset.id, action: "escalate", status: "open", reason: verdict.category === "csam" ? "csam_match" : "abuse_match", details })
      .returning({ id: moderationEvents.id });
    await audit(null, "scan.block", "media_asset", asset.id, { provider: verdict.provider, ref: verdict.ref ?? null, origin: subject.origin, sha256: asset.sha256, escalationId: event!.id }, t);
    if (!ownerId) return null;
    await t.insert(accountFlags).values({
      userId: ownerId,
      kind: verdict.category === "csam" ? "csam_match" : "manual_review",
      reason: "An upload or creation matched the abuse scanner. Held for human review.",
      details: { assetId: asset.id, escalationId: event!.id, provider: verdict.provider, ref: verdict.ref ?? null, origin: subject.origin },
    });
    if (verdict.category !== "csam") return null;
    const [suspended] = await t
      .update(users)
      .set({ status: "suspended", updatedAt: now })
      .where(and(eq(users.id, ownerId), eq(users.status, "active")))
      .returning({ id: users.id });
    if (!suspended) return null;
    await audit(null, "user.suspend", "user", ownerId, { reason: "scan_match", assetId: asset.id, escalationId: event!.id }, t);
    await t.delete(sessions).where(eq(sessions.userId, ownerId));
    return ownerId;
  };

  const suspended = tx ? await handle(tx) : await getDb().transaction(handle);
  logger.warn("scan.matched", { ...log, ref: verdict.ref ?? null, suspended: Boolean(suspended) });
  return "matched";
}

/**
 * Records a derived asset (a clip's poster frame) with its parent's verdict, without a second
 * scan: the frame comes from a clip whose keyframes were already checked.
 */
export async function recordDerivedScan(childAssetId: string, parentAssetId: string, tx?: Tx): Promise<ScanStatus | "pending"> {
  const db = tx ?? getDb();
  const [parent] = await db.select({ status: mediaAssets.scanStatus, provider: mediaAssets.scanProvider }).from(mediaAssets).where(eq(mediaAssets.id, parentAssetId));
  if (!parent || parent.status === "pending" || parent.status === "matched") return "pending";
  await db
    .update(mediaAssets)
    .set({ scanStatus: parent.status, scanProvider: parent.provider, scanRef: `derived:${parentAssetId}`, scannedAt: new Date() })
    .where(eq(mediaAssets.id, childAssetId));
  return parent.status;
}
