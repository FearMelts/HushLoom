import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJson, requireAdmin, route } from "@/server/http";
import { clearFlag, listFlags } from "@/server/payments/service";

export const GET = route(async (req) => {
  await requireAdmin();
  const includeCleared = req.nextUrl.searchParams.get("all") === "1";
  return NextResponse.json({ flags: await listFlags({ includeCleared }) });
});

const clearSchema = z.object({ action: z.literal("clear"), flagId: z.string().uuid(), note: z.string().trim().max(300).default("") });

export const POST = route(async (req) => {
  const admin = await requireAdmin();
  const input = await parseJson(req, clearSchema);
  const flag = await clearFlag(admin.id, input.flagId, input.note);
  return NextResponse.json({ ok: true, flag: { id: flag.id, kind: flag.kind, clearedAt: flag.clearedAt } });
});
