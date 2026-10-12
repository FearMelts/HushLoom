import { NextResponse } from "next/server";
import { z } from "zod";
import { notFound, parseJson, requireUser, route } from "@/server/http";
import { rateTemplate } from "@/server/templates/publish";
import { templateForViewer } from "@/server/templates/queries";

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await requireUser();
  const { score } = await parseJson(req, z.object({ score: z.number().int().min(1).max(5) }));
  const t = await templateForViewer((await params).id, user.id);
  if (!t || t.t.status !== "published") throw notFound();
  await rateTemplate(user.id, t.t.id, score);
  return NextResponse.json({ ok: true });
});
