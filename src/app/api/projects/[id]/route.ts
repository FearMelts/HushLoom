import { NextResponse } from "next/server";
import { parseJson, requireUser, route } from "@/server/http";
import { deleteProject, getProjectDetail, projectPatchSchema, updateProject } from "@/server/projects";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  return NextResponse.json(await getProjectDetail(user.id, (await params).id));
});

export const PATCH = route<Ctx>(async (req, { params }) => {
  const user = await requireUser();
  const project = await updateProject(user.id, (await params).id, await parseJson(req, projectPatchSchema));
  return NextResponse.json({ project });
});

export const DELETE = route<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  await deleteProject(user.id, (await params).id);
  return NextResponse.json({ ok: true });
});
