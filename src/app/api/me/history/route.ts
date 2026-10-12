import { NextResponse } from "next/server";
import { requireUser, route } from "@/server/http";
import { clearHistory } from "@/server/me";

export const DELETE = route(async () => {
  const user = await requireUser();
  return NextResponse.json({ removed: await clearHistory(user.id) });
});
