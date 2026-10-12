import { NextResponse } from "next/server";
import { parseJson, requireUser, route } from "@/server/http";
import { createProject, listProjects, projectSchema } from "@/server/projects";

export const GET = route(async () => {
  const user = await requireUser();
  return NextResponse.json({ projects: await listProjects(user.id) });
});

export const POST = route(async (req) => {
  const user = await requireUser();
  const project = await createProject(user.id, await parseJson(req, projectSchema));
  return NextResponse.json({ project }, { status: 201 });
});
