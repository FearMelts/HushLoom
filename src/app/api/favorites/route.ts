import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJson, requireUser, route } from "@/server/http";
import { setFavorite } from "@/server/social";

const body = z.object({ targetType: z.enum(["template", "creation"]), targetId: z.string().uuid() });

export const POST = route(async (req) => {
  const user = await requireUser();
  const b = await parseJson(req, body);
  await setFavorite(user.id, b.targetType, b.targetId, true);
  return NextResponse.json({ ok: true });
});

export const DELETE = route(async (req) => {
  const user = await requireUser();
  const b = await parseJson(req, body);
  await setFavorite(user.id, b.targetType, b.targetId, false);
  return NextResponse.json({ ok: true });
});
