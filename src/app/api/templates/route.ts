import { NextResponse } from "next/server";
import { z } from "zod";
import { viewerAccess } from "@/server/age/access";
import { browseTemplates } from "@/server/discovery/templates";
import { route } from "@/server/http";
import { publishTemplate, publishSchema } from "@/server/templates/publish";
import { requireUser, parseJson } from "@/server/http";

const query = z.object({
  q: z.string().max(100).optional(),
  category: z.string().max(40).optional(),
  media: z.enum(["image", "video"]).optional(),
  sort: z.enum(["trending", "new", "top_rated", "most_favorited"]).optional(),
  creatorId: z.string().uuid().optional(),
  offset: z.coerce.number().int().min(0).max(10_000).optional(),
  limit: z.coerce.number().int().min(1).max(60).optional(),
});

export const GET = route(async (req) => {
  const params = query.parse(Object.fromEntries(req.nextUrl.searchParams));
  // One age-rule decision per request; media URLs are withheld server-side for viewers who still need a check.
  const access = await viewerAccess();
  return NextResponse.json(await browseTemplates(params, access.viewer));
});

export const POST = route(async (req) => {
  const user = await requireUser();
  const input = await parseJson(req, publishSchema);
  const template = await publishTemplate(user, input);
  return NextResponse.json({ template }, { status: 201 });
});
