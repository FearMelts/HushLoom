import { NextResponse } from "next/server";
import { deleteJob } from "@/server/generation/service";
import { getCreation } from "@/server/generation/views";
import { notFound, requireUser, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  const { id } = await params;
  const job = /^[0-9a-f-]{36}$/.test(id) ? await getCreation(user.id, id) : null;
  if (!job) throw notFound();
  return NextResponse.json({ job });
});

export const DELETE = route<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  await deleteJob(user, (await params).id);
  return NextResponse.json({ ok: true });
});
