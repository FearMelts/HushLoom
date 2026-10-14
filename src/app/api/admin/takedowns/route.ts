import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, route } from "@/server/http";
import { countTakedowns, listTakedowns, TAKEDOWN_PAGE } from "@/server/safety/takedowns";

const offsetSchema = z.coerce.number().int().min(0).max(1_000_000).catch(0);

/** One page of takedown requests (urgent first, then oldest), with the total so the queue can page. */
export const GET = route(async (req) => {
  await requireAdmin();
  const status = req.nextUrl.searchParams.get("status") === "closed" ? "closed" : "open";
  const offset = offsetSchema.parse(req.nextUrl.searchParams.get("offset") ?? 0);
  const [takedowns, total] = await Promise.all([listTakedowns({ status, offset }), countTakedowns(status)]);
  return NextResponse.json({ takedowns, total, offset, limit: TAKEDOWN_PAGE });
});
