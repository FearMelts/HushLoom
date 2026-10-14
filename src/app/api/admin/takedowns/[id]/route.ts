import { NextResponse } from "next/server";
import { parseJson, requireAdmin, route } from "@/server/http";
import { resolveTakedown, takedownActionSchema } from "@/server/safety/takedowns";

/** Actions a takedown request (removes what it points at) or dismisses it with a note. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const admin = await requireAdmin();
  await resolveTakedown(admin.id, (await params).id, await parseJson(req, takedownActionSchema));
  return NextResponse.json({ ok: true });
});
