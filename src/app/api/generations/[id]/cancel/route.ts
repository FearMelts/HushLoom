import { NextResponse } from "next/server";
import { cancelJob } from "@/server/generation/service";
import { requireUser, route } from "@/server/http";

export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const user = await requireUser();
  const job = await cancelJob(user, (await params).id);
  return NextResponse.json({ job });
});
