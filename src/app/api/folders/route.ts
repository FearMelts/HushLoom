import { NextResponse } from "next/server";
import { z } from "zod";
import { createFolder, listFolders } from "@/server/folders";
import { parseJson, requireUser, route } from "@/server/http";

export const GET = route(async () => {
  const user = await requireUser();
  return NextResponse.json({ folders: await listFolders(user.id) });
});

export const POST = route(async (req) => {
  const user = await requireUser();
  const { name } = await parseJson(req, z.object({ name: z.string().trim().min(1).max(40) }));
  return NextResponse.json({ folder: await createFolder(user.id, name) }, { status: 201 });
});
