import { NextResponse } from "next/server";
import { parseJson, requireAdmin, route } from "@/server/http";
import { resolveEscalation, reviewActionSchema } from "@/server/safety/review";

/** Confirms a scanner match with its report reference, or clears it as a false positive. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const admin = await requireAdmin();
  await resolveEscalation(admin.id, (await params).id, await parseJson(req, reviewActionSchema));
  return NextResponse.json({ ok: true });
});
