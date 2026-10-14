import { NextResponse } from "next/server";
import { route } from "@/server/http";
import { pushStatus } from "@/server/push";

/** The VAPID public key browsers subscribe with, or why push is off on this server. The key is public by design. */
export const GET = route(async () => {
  const status = pushStatus();
  return NextResponse.json({ enabled: status.enabled, reason: status.reason, publicKey: status.publicKey });
});
