import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, or } from "drizzle-orm";
import { audit } from "@/server/audit";
import { getDb, type Tx } from "@/server/db";
import { accountFlags, mediaAssets, moderationEvents, templates } from "@/server/db/schema";
import { env } from "@/server/env";
import { logger } from "@/server/log";
import { suspendForAbuse } from "@/server/safety/suspend";
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

const KEYFRAME_FPS = 1;
const KEYFRAME_MAX = 30;

/** Pulls up to 30 frames at one per second as PNG. Throws when ffmpeg is missing or the clip cannot be read. */
export async function extractKeyframes(clip: Buffer): Promise<Buffer[]> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hl-scan-"));
  try {
    const input = path.join(dir, "in.mp4");
    await writeFile(input, clip);
    await new Promise<void>((resolve, reject) => {
      const child = spawn("ffmpeg", ["-v", "error", "-y", "-i", input, "-vf", `fps=${KEYFRAME_FPS}`, "-frames:v", String(KEYFRAME_MAX), path.join(dir, "f-%03d.png")], {
        stdio: ["ignore", "ignore", "pipe"],
        signal: AbortSignal.timeout(env().SCAN_TIMEOUT_S * 2000),
      });
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-300)));
      child.on("error", (e) => reject(new Error(`ffmpeg unavailable: ${e.name}`)));
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr}`))));
    });
    const names = (await readdir(dir)).filter((n) => n.startsWith("f-")).sort();
    return Promise.all(names.map((n) => readFile(path.join(dir, n))));
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
  let frames: Buffer[];
  try {
    frames = await extractKeyframes(input.bytes);
  } catch (err) {
    return unavailable(provider.key, `could not read keyframes: ${(err as Error).message.slice(0, 160)}`);
  }
  if (!frames.length) return unavailable(provider.key, "the video has no readable frames");
  let firstRef: string | undefined;
  let recordedProvider = provider.key as string;
  for (const [i, frame] of frames.entries()) {
    const v = await withTimeout(provider.scan({ bytes: frame, mime: "image/png", kind: "image", sha256: sha256(frame) }), provider.key);
    if (v.status === "matched") return { ...v, detail: `keyframe at ${i}s${v.detail ? `: ${v.detail}` : ""}` };
    if (v.status === "unavailable") return v;
    firstRef ??= v.ref;
    recordedProvider = v.provider;
  }
  return { status: "clean", provider: recordedProvider, ref: `keyframes:${frames.length}${firstRef ? `;${firstRef}` : ""}`.slice(0, 200) };
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
    await (tx ?? getDb())
      .update(mediaAssets)
      .set({ scanStatus: verdict.status, scanProvider: verdict.provider, scanRef: verdict.status === "clean" ? (verdict.ref ?? null) : null, scannedAt: now })
      .where(eq(mediaAssets.id, subject.assetId));
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
    return (await suspendForAbuse(t, ownerId, { reason: "scan_match", assetId: asset.id, escalationId: event!.id })) ? ownerId : null;
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
