/**
 * Scans every asset that has no verdict yet (scan_status = 'pending') through the configured
 * abuse scanner and records the result (addendum §3). Run it once on a database created before
 * scanning existed: until then those assets are never served. Safe to re-run; it only touches
 * pending rows (plus 'unavailable' ones with --include-unavailable).
 *
 *   npx tsx scripts/scan-backfill.ts [--include-unavailable]
 *
 * Purged assets (files already deleted) cannot be scanned; they are counted and left pending,
 * which is harmless because they are deleted and never served. Exits 1 when an asset that still
 * has its file remains without a verdict, or the scanner was unavailable for any asset, so
 * scripts can stop on it.
 */
import { and, asc, eq, gt, inArray, notLike, sql } from "drizzle-orm";
import { closeDb, getDb } from "@/server/db";
import { mediaAssets } from "@/server/db/schema";
import { closeRedis } from "@/server/redis";
import { scanAsset, scanSettings } from "@/server/safety/scan";
import { storage } from "@/server/storage";

const includeUnavailable = process.argv.includes("--include-unavailable");
const statuses: ("pending" | "unavailable")[] = includeUnavailable ? ["pending", "unavailable"] : ["pending"];
const db = getDb();
const settings = scanSettings();
console.log(`Scanner: ${settings.label}; fail-closed ${settings.failClosed ? "on" : "off"}.`);

const counts = { scanned: 0, clean: 0, matched: 0, unavailable: 0, missingFile: 0 };
let cursor = "00000000-0000-0000-0000-000000000000";
for (;;) {
  const batch = await db
    .select()
    .from(mediaAssets)
    .where(and(inArray(mediaAssets.scanStatus, statuses), notLike(mediaAssets.storageKey, "purged/%"), gt(mediaAssets.id, cursor)))
    .orderBy(asc(mediaAssets.id))
    .limit(100);
  if (!batch.length) break;
  for (const a of batch) {
    cursor = a.id;
    let bytes: Buffer;
    try {
      bytes = await storage().get(a.storageKey);
    } catch {
      counts.missingFile++;
      continue;
    }
    const verdict = await scanAsset({ assetId: a.id, bytes, mime: a.mime, kind: a.kind, sha256: a.sha256, ownerId: a.ownerId, origin: "backfill" });
    counts.scanned++;
    counts[verdict]++;
  }
}

const [left] = await db
  .select({
    pending: sql<number>`count(*) filter (where ${mediaAssets.storageKey} not like 'purged/%')::int`,
    purged: sql<number>`count(*) filter (where ${mediaAssets.storageKey} like 'purged/%')::int`,
  })
  .from(mediaAssets)
  .where(eq(mediaAssets.scanStatus, "pending"));

console.log(
  `Scanned ${counts.scanned}: ${counts.clean} clean, ${counts.matched} matched (held, escalated), ${counts.unavailable} unavailable. ` +
    `Missing files: ${counts.missingFile}. Still pending: ${left?.pending ?? 0} with files, ${left?.purged ?? 0} purged (never served).`,
);
if (counts.matched) console.log("Matches are in the review queue at /admin/review.");
await closeRedis();
await closeDb();
if (counts.unavailable) console.log("The scanner was unavailable for some assets; they stay unserved. Re-run with --include-unavailable.");
process.exit((left?.pending ?? 0) > 0 || counts.unavailable > 0 ? 1 : 0);
