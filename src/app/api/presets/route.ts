import { NextResponse } from "next/server";
import { parseJson, requireUser, route } from "@/server/http";
import { createPreset, listPresets, presetSchema } from "@/server/presets";

export const GET = route(async () => {
  const user = await requireUser();
  return NextResponse.json({ presets: await listPresets(user.id) });
});

export const POST = route(async (req) => {
  const user = await requireUser();
  const preset = await createPreset(user.id, await parseJson(req, presetSchema));
  return NextResponse.json({ preset }, { status: 201 });
});
