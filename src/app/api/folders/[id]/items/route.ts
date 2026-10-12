import { NextResponse } from "next/server";
import { z } from "zod";
import { addToFolder } from "@/server/folders";
import { parseJson, requireUser, route } from "@/server/http";

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await requireUser();
  const { jobIds } = await parseJson(req, z.object({ jobIds: z.array(z.string().uuid()).min(1).max(100) }));
  const added = await addToFolder(user.id, (await params).id, jobIds);
  return NextResponse.json({ added });
});
