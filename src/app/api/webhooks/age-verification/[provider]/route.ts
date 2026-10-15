import { NextResponse } from "next/server";
import { handleCallback } from "@/server/age/service";
import { route } from "@/server/http";

/**
 * The age-verification provider calls this. The raw body is handed to the active provider's
 * signature check before anything is read from it; unsigned, forged and replayed callbacks are
 * refused and change nothing. Sandbox callbacks come from the internal /verify/sandbox page.
 */
export const POST = route(async (req, { params }: { params: Promise<{ provider: string }> }) => {
  const { provider } = await params;
  const raw = await req.text();
  const result = await handleCallback(provider, { rawBody: raw, headers: req.headers, url: req.nextUrl });
  return NextResponse.json({ received: true, outcome: result.outcome });
});
