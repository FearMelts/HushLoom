import { NextResponse } from "next/server";
import { deleteFolder } from "@/server/folders";
import { requireUser, route } from "@/server/http";

export const DELETE = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const user = await requireUser();
  await deleteFolder(user.id, (await params).id);
  return NextResponse.json({ ok: true });
});
