import { NextResponse } from "next/server";
import { adjustCredits, adjustSchema } from "@/server/admin";
import { parseJson, requireAdmin, route } from "@/server/http";

export const POST = route(async (req) => {
  const admin = await requireAdmin();
  return NextResponse.json(await adjustCredits(admin.id, await parseJson(req, adjustSchema)));
});
