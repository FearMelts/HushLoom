import { NextResponse } from "next/server";
import { withdrawConsent } from "@/server/auth/account";
import { requireUser, route } from "@/server/http";

/** Withdraws a consent record and deletes everything made under it. */
export const DELETE = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const user = await requireUser();
  await withdrawConsent(user.id, (await params).id);
  return NextResponse.json({ ok: true });
});
