import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJson, requireUser, route } from "@/server/http";
import { addScene, reorderScenes, sceneSchema } from "@/server/projects";

type Ctx = { params: Promise<{ id: string }> };

export const POST = route<Ctx>(async (req, { params }) => {
  const user = await requireUser();
  const scene = await addScene(user.id, (await params).id, await parseJson(req, sceneSchema));
  return NextResponse.json({ scene }, { status: 201 });
});

/** Reorders scenes: body is { order: sceneId[] } listing every scene once. */
export const PUT = route<Ctx>(async (req, { params }) => {
  const user = await requireUser();
  const { order } = await parseJson(req, z.object({ order: z.array(z.string().uuid()).min(1).max(50) }));
  await reorderScenes(user.id, (await params).id, order);
  return NextResponse.json({ ok: true });
});
