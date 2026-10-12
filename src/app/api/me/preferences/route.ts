import { NextResponse } from "next/server";
import { parseJson, requireUser, route } from "@/server/http";
import { preferencesSchema, updatePreferences } from "@/server/me";

export const PATCH = route(async (req) => {
  const user = await requireUser();
  await updatePreferences(user.id, await parseJson(req, preferencesSchema));
  return NextResponse.json({ ok: true });
});
