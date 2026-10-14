import { NextResponse } from "next/server";
import { assertSameOrigin, HttpError, readForm, requireUser, route } from "@/server/http";
import { acceptUpload, FORM_OVERHEAD_BYTES, MAX_VIDEO_BYTES } from "@/server/media";
import { rateLimit } from "@/server/redis";
import { assertAgeVerified } from "@/server/age/gate";
import { requestCountry, requestRegion } from "@/server/request";

const CONSENT_STATEMENT =
  "Everyone in this upload is an adult (18+), and it is me or they agreed to me using their image here, including for sexual content.";

export const POST = route(async (req) => {
  assertSameOrigin(req);
  const user = await requireUser();
  await assertAgeVerified(user, { country: requestCountry(req), region: requestRegion(req) });
  if (!(await rateLimit(`upload:${user.id}`, 40, 3600))) throw new HttpError(429, "rate_limited", "Upload limit reached for this hour.");
  const form = await readForm(req, MAX_VIDEO_BYTES + FORM_OVERHEAD_BYTES, "Videos can be up to 100 MB and images up to 20 MB.");
  const file = form.get("file");
  if (!(file instanceof File)) throw new HttpError(422, "invalid_input", "Attach a file.");
  if (form.get("consent") !== "true") throw new HttpError(422, "consent_required", "Confirm consent for everyone in the upload.");
  const result = await acceptUpload(
    user.id,
    { bytes: Buffer.from(await file.arrayBuffer()), declaredMime: file.type },
    { statement: CONSENT_STATEMENT, subjectLabel: String(form.get("subject") ?? "").slice(0, 80) || null },
    "source",
  );
  return NextResponse.json(result, { status: 201 });
});
