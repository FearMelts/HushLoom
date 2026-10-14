import { NextResponse } from "next/server";
import { requireAdmin, route } from "@/server/http";
import { scanSettings } from "@/server/safety/scan";
import { listEscalations } from "@/server/safety/review";
import { countTakedowns, listTakedowns } from "@/server/safety/takedowns";

/** The abuse review queue: open scanner escalations and the first page of open takedown requests (see /api/admin/takedowns for the rest). Admins only. */
export const GET = route(async () => {
  await requireAdmin();
  const [escalations, takedowns, takedownsOpen] = await Promise.all([listEscalations({ status: "open" }), listTakedowns({ status: "open" }), countTakedowns("open")]);
  return NextResponse.json({ scanner: scanSettings(), escalations, takedowns, takedownsOpen });
});
