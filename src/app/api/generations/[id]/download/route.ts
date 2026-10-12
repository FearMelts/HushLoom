import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/server/db";
import { generationOutputs, mediaAssets } from "@/server/db/schema";
import { getOwnedJob } from "@/server/generation/service";
import { notFound, requireUser, route } from "@/server/http";
import { assetUrl } from "@/server/media";

/** Redirects the owner to a short-lived signed URL that downloads the file. */
export const GET = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await requireUser();
  const job = await getOwnedJob(user.id, (await params).id);
  const [row] = await getDb()
    .select({ asset: mediaAssets })
    .from(generationOutputs)
    .innerJoin(mediaAssets, eq(mediaAssets.id, generationOutputs.assetId))
    .where(and(eq(generationOutputs.jobId, job.id), isNull(generationOutputs.deletedAt)))
    .limit(1);
  if (!row) throw notFound();
  const ext = row.asset.mime === "video/mp4" ? "mp4" : "webp";
  const url = await assetUrl(row.asset, user.id, { download: `hushloom-${job.id.slice(0, 8)}${job.isDemo ? "-demo" : ""}.${ext}` });
  if (!url) throw notFound();
  return NextResponse.redirect(new URL(url, req.nextUrl.origin), 302);
});
