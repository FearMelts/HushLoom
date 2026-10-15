import { NextResponse } from "next/server";
import { viewerAccessFor } from "@/server/age/service";
import { parseJson, requireUser, route } from "@/server/http";
import { createProject, listProjects, projectSchema } from "@/server/projects";
import { requestCountry, requestRegion } from "@/server/request";

export const GET = route(async (req) => {
  const user = await requireUser();
  const access = await viewerAccessFor(user, { country: requestCountry(req), region: requestRegion(req) });
  return NextResponse.json({ projects: await listProjects(user.id, access) });
});

export const POST = route(async (req) => {
  const user = await requireUser();
  const project = await createProject(user.id, await parseJson(req, projectSchema));
  return NextResponse.json({ project }, { status: 201 });
});
