import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db";
import { mediaAssets } from "@/server/db/schema";
import { storage, verifyLocalSignature } from "@/server/storage";

/**
 * Serves all stored media, from the local disk or the S3 bucket alike (the bucket is never linked
 * directly). Access is granted only by a valid, unexpired signature, which the server issues after
 * its own ownership check.
 * Supports Range requests so video can seek on mobile.
 * Only assets the abuse scanner cleared are served; anything else is the same 404 as a deleted
 * asset, even with a link signed before the verdict changed (addendum §3).
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const key = sp.get("k") ?? "";
  const exp = Number(sp.get("e"));
  const download = sp.get("d") ?? "";
  if (!verifyLocalSignature(key, exp, download, sp.get("s") ?? "")) {
    return NextResponse.json({ error: { code: "forbidden", message: "Link expired or invalid." } }, { status: 403 });
  }
  const [asset] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.storageKey, key));
  if (!asset || asset.deletedAt || asset.scanStatus !== "clean") return NextResponse.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });

  // Only the requested bytes are read, so a one-byte Range request costs one byte, not the whole file.
  let size: number;
  try {
    size = await storage().size(key);
  } catch {
    return NextResponse.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
  }
  const headers: Record<string, string> = {
    "Content-Type": asset.mime,
    "Accept-Ranges": "bytes",
    "Cache-Control": `private, max-age=${Math.max(0, exp - Math.floor(Date.now() / 1000))}`,
    "X-Robots-Tag": "noindex",
  };
  if (download) headers["Content-Disposition"] = `attachment; filename="${download.replace(/[^\w.-]/g, "")}"`;

  const range = req.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (range) {
    // "bytes=-N" asks for the last N bytes.
    const suffix = !range[1] && range[2] ? Number(range[2]) : null;
    const start = suffix !== null ? Math.max(0, size - suffix) : range[1] ? Number(range[1]) : 0;
    const end = suffix === null && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    return new NextResponse(await storage().read(key, { start, end }), {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
    });
  }
  return new NextResponse(await storage().read(key), { headers: { ...headers, "Content-Length": String(size) } });
}
