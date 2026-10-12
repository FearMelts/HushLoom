import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/server/db";
import { moderationEvents } from "@/server/db/schema";
import { HttpError, notFound, parseJson, requireUser, route } from "@/server/http";
import { rateLimit } from "@/server/redis";
import { templateForViewer } from "@/server/templates/queries";

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await requireUser();
  if (!(await rateLimit(`report:${user.id}`, 20, 3600))) throw new HttpError(429, "rate_limited", "Report limit reached for now.");
  const body = await parseJson(
    req,
    z.object({ reason: z.enum(["minor", "non_consent", "real_person", "illegal", "spam", "other"]), note: z.string().max(1000).default("") }),
  );
  const t = await templateForViewer((await params).id, user.id);
  if (!t) throw notFound();
  await getDb().insert(moderationEvents).values({
    subjectType: "template",
    subjectId: t.t.id,
    action: "report",
    status: "open",
    reporterId: user.id,
    reason: body.reason,
    details: { note: body.note },
  });
  return NextResponse.json({ ok: true }, { status: 201 });
});
