import { NextResponse } from "next/server";
import { parseJson, requireUser, route } from "@/server/http";
import { deleteScene, scenePatchSchema, updateScene } from "@/server/projects";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = route<Ctx>(async (req, { params }) => {
  const user = await requireUser();
  const scene = await updateScene(user.id, (await params).id, await parseJson(req, scenePatchSchema));
  return NextResponse.json({ scene });
});

export const DELETE = route<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  await deleteScene(user.id, (await params).id);
  return NextResponse.json({ ok: true });
});
