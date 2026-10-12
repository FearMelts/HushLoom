import { NextResponse } from "next/server";
import { z } from "zod";
import { createDraft, draftSchema } from "@/server/generation/service";
import { listCreations } from "@/server/generation/views";
import { parseJson, requireUser, route } from "@/server/http";
import { rateLimit } from "@/server/redis";
import { HttpError } from "@/server/http";
import { requestCountry, requestRegion } from "@/server/request";

const listQuery = z.object({
  active: z.enum(["1"]).optional(),
  media: z.enum(["image", "video"]).optional(),
  status: z.enum(["queued", "processing", "completed", "failed", "cancelled"]).optional(),
  favorites: z.enum(["1"]).optional(),
  projectId: z.string().uuid().optional(),
  templateId: z.string().uuid().optional(),
  modelKey: z.string().max(60).optional(),
  folderId: z.string().uuid().optional(),
  sort: z.enum(["newest", "oldest"]).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const GET = route(async (req) => {
  const user = await requireUser();
  const q = listQuery.parse(Object.fromEntries(req.nextUrl.searchParams));
  const items = await listCreations(user.id, { ...q, active: q.active === "1", favorites: q.favorites === "1" });
  return NextResponse.json({ items });
});

export const POST = route(async (req) => {
  const user = await requireUser();
  if (!(await rateLimit(`draft:${user.id}`, 30, 60))) throw new HttpError(429, "rate_limited", "Slow down a little and try again in a minute.");
  const input = await parseJson(req, draftSchema);
  const job = await createDraft(user, input, { country: requestCountry(req), region: requestRegion(req) });
  return NextResponse.json({ job }, { status: 201 });
});
