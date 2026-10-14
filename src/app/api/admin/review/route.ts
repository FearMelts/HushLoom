import { NextResponse } from "next/server";
import { requireAdmin, route } from "@/server/http";
import { scanSettings } from "@/server/safety/scan";
import { listEscalations } from "@/server/safety/review";
import { listTakedowns } from "@/server/safety/takedowns";

/** The abuse review queue: open scanner escalations and open takedown requests. Admins only. */
export const GET = route(async () => {
  await requireAdmin();
  const [escalations, takedowns] = await Promise.all([listEscalations({ status: "open" }), listTakedowns({ status: "open" })]);
  return NextResponse.json({ scanner: scanSettings(), escalations, takedowns });
});
