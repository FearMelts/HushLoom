import { NextResponse } from "next/server";
import { modelConfigSchema, setModelConfig } from "@/server/admin";
import { parseJson, requireAdmin, route } from "@/server/http";

export const PATCH = route<{ params: Promise<{ key: string }> }>(async (req, { params }) => {
  const admin = await requireAdmin();
  await setModelConfig(admin.id, (await params).key, await parseJson(req, modelConfigSchema));
  return NextResponse.json({ ok: true });
});
