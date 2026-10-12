import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJson, route } from "@/server/http";

export const POST = route(async (req) => {
  await parseJson(req, z.object({ confirm: z.literal(true) }));
  const res = NextResponse.json({ ok: true });
  res.cookies.set("hl_age_ok", "1", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30, secure: process.env.NODE_ENV === "production" });
  return res;
});
