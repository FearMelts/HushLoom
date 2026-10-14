import { NextResponse } from "next/server";
import { assertAgeVerified } from "@/server/age/gate";
import { createCharacter, listCharacters } from "@/server/characters";
import { HttpError, requireUser, route } from "@/server/http";
import { rateLimit } from "@/server/redis";
import { requestCountry, requestRegion } from "@/server/request";

export const GET = route(async () => {
  const user = await requireUser();
  return NextResponse.json({ characters: await listCharacters(user.id) });
});

export const POST = route(async (req) => {
  const user = await requireUser();
  // A character photo is an upload: the same age-verification gate as /api/uploads (addendum §2).
  await assertAgeVerified(user, { country: requestCountry(req), region: requestRegion(req) });
  if (!(await rateLimit(`character:${user.id}`, 10, 3600))) throw new HttpError(429, "rate_limited", "Character limit reached for this hour.");
  const form = await req.formData();
  const file = form.get("file");
  const name = String(form.get("name") ?? "").trim().slice(0, 40);
  if (!(file instanceof File)) throw new HttpError(422, "invalid_input", "Attach a photo.");
  if (!name) throw new HttpError(422, "invalid_input", "Name the character.");
  if (form.get("consentAdult") !== "true" || form.get("consentLikeness") !== "true") {
    throw new HttpError(422, "consent_required", "Both confirmations are required to add a likeness.");
  }
  const result = await createCharacter(user.id, { bytes: Buffer.from(await file.arrayBuffer()), declaredMime: file.type }, name, null);
  return NextResponse.json(result, { status: 201 });
});
