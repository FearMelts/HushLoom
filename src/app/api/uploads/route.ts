import { NextResponse } from "next/server";
import { HttpError, requireUser, route } from "@/server/http";
import { acceptUpload } from "@/server/media";
import { rateLimit } from "@/server/redis";

const CONSENT_STATEMENT =
  "Everyone in this upload is an adult (18+), and it is me or they agreed to me using their image here, including for sexual content.";

export const POST = route(async (req) => {
  const user = await requireUser();
  if (!(await rateLimit(`upload:${user.id}`, 40, 3600))) throw new HttpError(429, "rate_limited", "Upload limit reached for this hour.");
  const form = await req.formData();
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
