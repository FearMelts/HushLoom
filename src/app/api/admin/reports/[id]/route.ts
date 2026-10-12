import { NextResponse } from "next/server";
import { resolveReport, resolveSchema } from "@/server/admin";
import { parseJson, requireAdmin, route } from "@/server/http";

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const admin = await requireAdmin();
  await resolveReport(admin.id, (await params).id, await parseJson(req, resolveSchema));
  return NextResponse.json({ ok: true });
});
