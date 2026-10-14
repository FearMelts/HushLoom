import { NextResponse } from "next/server";
import { viewerAccessFor } from "@/server/age/service";
import { deleteJob } from "@/server/generation/service";
import { getCreation } from "@/server/generation/views";
import { notFound, requireUser, route } from "@/server/http";
import { requestCountry, requestRegion } from "@/server/request";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (req, { params }) => {
  const user = await requireUser();
  const { id } = await params;
  const access = await viewerAccessFor(user, { country: requestCountry(req), region: requestRegion(req) });
  const job = /^[0-9a-f-]{36}$/.test(id) ? await getCreation(user.id, id, access) : null;
  if (!job) throw notFound();
  return NextResponse.json({ job });
});

export const DELETE = route<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  await deleteJob(user, (await params).id);
  return NextResponse.json({ ok: true });
});
