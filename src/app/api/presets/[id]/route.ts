import { NextResponse } from "next/server";
import { requireUser, route } from "@/server/http";
import { deletePreset } from "@/server/presets";

export const DELETE = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const user = await requireUser();
  await deletePreset(user.id, (await params).id);
  return NextResponse.json({ ok: true });
});
