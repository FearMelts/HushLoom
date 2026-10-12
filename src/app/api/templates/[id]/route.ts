import { NextResponse } from "next/server";
import { requireUser, parseJson, route } from "@/server/http";
import { updateTemplate, updateTemplateSchema } from "@/server/templates/publish";

export const PATCH = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await requireUser();
  const input = await parseJson(req, updateTemplateSchema);
  const template = await updateTemplate(user, (await params).id, input);
  return NextResponse.json({ template });
});
