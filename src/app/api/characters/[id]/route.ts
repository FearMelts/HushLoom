import { NextResponse } from "next/server";
import { removeCharacter } from "@/server/characters";
import { requireUser, route } from "@/server/http";

export const DELETE = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const user = await requireUser();
  await removeCharacter(user.id, (await params).id);
  return NextResponse.json({ ok: true });
});
