import type { SessionUser } from "@/server/auth/session";
import type { RequestContext } from "@/server/generation/service";

/**
 * Server-side age-verification gate (addendum §2). Called before anything that generates,
 * uploads or reveals explicit content. The age-verification track replaces this stub with
 * the jurisdiction check in src/config/jurisdictions.ts and the user's verification status.
 * Throws an HttpError(451, "age_verification_required") when the user must verify first.
 */
export async function assertAgeVerified(user: Pick<SessionUser, "id" | "ageAssuranceMethod">, ctx: Pick<RequestContext, "country"> & { region?: string | null }): Promise<void> {
  void user;
  void ctx;
}
