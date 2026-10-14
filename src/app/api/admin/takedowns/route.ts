import { NextResponse } from "next/server";
import { requireAdmin, route } from "@/server/http";
import { listTakedowns } from "@/server/safety/takedowns";

export const GET = route(async (req) => {
  await requireAdmin();
  const status = req.nextUrl.searchParams.get("status") === "closed" ? "closed" : "open";
  return NextResponse.json({ takedowns: await listTakedowns({ status }) });
});
