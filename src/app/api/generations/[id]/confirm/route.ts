import { NextResponse } from "next/server";
import { z } from "zod";
import { confirmJob } from "@/server/generation/service";
import { parseJson, requireUser, route } from "@/server/http";

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await requireUser();
  const { expectedCost } = await parseJson(req, z.object({ expectedCost: z.number().int().nonnegative() }));
  const job = await confirmJob(user, (await params).id, expectedCost);
  return NextResponse.json({ job });
});
