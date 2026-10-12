import type { Tx } from "@/server/db";

/**
 * Hook points for the abuse-scanning track (addendum §3). Until that track lands, these are
 * no-ops that mark nothing: assets keep scan_status = "pending" and the media route decides
 * what a pending asset means. The scanning track must make every path fail closed.
 */
export type ScanSubject = { assetId: string; bytes: Buffer; mime: string; kind: "image" | "video"; sha256: string; ownerId: string | null; origin: "upload" | "output" | "seed" };

/** Scans one stored asset and records the verdict on media_assets. Returns the recorded status. */
export async function scanAsset(subject: ScanSubject, tx?: Tx): Promise<"clean" | "matched" | "unavailable"> {
  void subject;
  void tx;
  return "clean";
}
