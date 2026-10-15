import { NextResponse } from "next/server";
import { z } from "zod";
import { deriveDraft } from "@/server/generation/service";
import { parseJson, requireUser, route } from "@/server/http";
import { requestCountry, requestRegion } from "@/server/request";

const body = z.object({
  relation: z.enum(["retry", "variation", "continuation", "extension"]),
  idempotencyKey: z.string().min(8).max(100),
});

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await requireUser();
  const { relation, idempotencyKey } = await parseJson(req, body);
  const job = await deriveDraft(user, (await params).id, relation, idempotencyKey, { country: requestCountry(req), region: requestRegion(req) });
  return NextResponse.json({ job }, { status: 201 });
});
