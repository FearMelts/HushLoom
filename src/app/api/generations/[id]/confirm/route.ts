import { NextResponse } from "next/server";
import { z } from "zod";
import { assertAgeVerified } from "@/server/age/gate";
import { confirmJob } from "@/server/generation/service";
import { parseJson, requireUser, route } from "@/server/http";
import { requestCountry, requestRegion } from "@/server/request";

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await requireUser();
  // Confirming is what reserves the credits and starts the generation, so the age gate runs here too,
  // for this request's place: a draft priced elsewhere, or before a verification lapsed, starts nothing.
  await assertAgeVerified(user, { country: requestCountry(req), region: requestRegion(req) });
  const { expectedCost } = await parseJson(req, z.object({ expectedCost: z.number().int().nonnegative() }));
  const job = await confirmJob(user, (await params).id, expectedCost);
  return NextResponse.json({ job });
});
