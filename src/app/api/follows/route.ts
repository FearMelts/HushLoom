import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJson, requireUser, route } from "@/server/http";
import { setFollow } from "@/server/social";

const body = z.object({ creatorId: z.string().uuid() });

export const POST = route(async (req) => {
  const user = await requireUser();
  await setFollow(user.id, (await parseJson(req, body)).creatorId, true);
  return NextResponse.json({ ok: true });
});

export const DELETE = route(async (req) => {
  const user = await requireUser();
  await setFollow(user.id, (await parseJson(req, body)).creatorId, false);
  return NextResponse.json({ ok: true });
});
