import { HttpError } from "@/server/http";
import type { AgeContext } from "./rules";
import { requirementFor, satisfied, VERIFY_PATH, type AgeSubject } from "./service";

/**
 * Server-side age-verification gate (addendum §2). Called before anything that generates or
 * uploads; the discovery queries use viewerAccess() for explicit media. The jurisdiction rules
 * live in src/config/jurisdictions.ts and src/server/age/rules.ts; the user's status comes from
 * the session loader (or one query when the caller only has an id). The older
 * AGE_ASSURANCE_STRICT_REGIONS path is folded in here: a strict region is one that requires a
 * provider check, so there is a single 451 with a path to fix it.
 */
export async function assertAgeVerified(user: AgeSubject, ctx: AgeContext): Promise<void> {
  const req = await requirementFor(user, ctx);
  if (satisfied(req)) return;
  throw new HttpError(451, "age_verification_required", "Your region requires an age check before you can create or upload. It takes a minute.", {
    verifyPath: VERIFY_PATH,
    status: req.status,
    jurisdiction: req.jurisdiction,
  });
}
