import { NextResponse } from "next/server";
import { z } from "zod";
import { suspendUser } from "@/server/admin";
import { parseJson, requireAdmin, route } from "@/server/http";

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const admin = await requireAdmin();
  const { reason } = await parseJson(req, z.object({ reason: z.string().trim().min(3).max(200) }));
  await suspendUser(admin.id, (await params).id, reason);
  return NextResponse.json({ ok: true });
});
