import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJson, requireUser, route } from "@/server/http";
import { selectVersion } from "@/server/projects";

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await requireUser();
  const { versionId } = await parseJson(req, z.object({ versionId: z.string().uuid() }));
  await selectVersion(user.id, (await params).id, versionId);
  return NextResponse.json({ ok: true });
});
