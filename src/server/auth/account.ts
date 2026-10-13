import { randomUUID } from "node:crypto";
import { and, arrayOverlaps, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { audit } from "@/server/audit";
import { applyMovement } from "@/server/credits/ledger";
import { getDb } from "@/server/db";
import {
  characterReferences,
  consentRecords,
  creditAccounts,
  discoveryEvents,
  generationJobs,
  generationOutputs,
  mediaAssets,
  templates,
  uploads,
  userPreferences,
  userProfiles,
  users,
} from "@/server/db/schema";
import { env } from "@/server/env";
import { HttpError } from "@/server/http";
import { purgeAssetsNow } from "@/server/media";
import { ADULT_AGE, ageOn } from "@/server/safety/policy";
import { destroyAllSessions, hashPassword, verifyPassword } from "./session";

export const TERMS_STATEMENT =
  "I agree to the Terms and Content Policy. I will only upload or create content of consenting adults, and never of minors or of anyone without their permission.";
export const ADULT_STATEMENT = "I confirm I am at least 18 years old and the age of majority where I live.";

export const signupSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email."),
  password: z.string().min(10, "Use at least 10 characters.").max(200),
  handle: z
    .string()
    .trim()
    .min(3, "Handles are 3 to 24 characters.")
    .max(24, "Handles are 3 to 24 characters.")
    .regex(/^[a-zA-Z0-9_]+$/, "Letters, numbers and underscores only."),
  displayName: z.string().trim().min(1).max(40),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter your date of birth."),
  acceptTerms: z.literal(true, { errorMap: () => ({ message: "Accept the terms to continue." }) }),
  confirmAdult: z.literal(true, { errorMap: () => ({ message: "You must confirm you are an adult." }) }),
});

/** `jurisdiction` is the "GB" / "US-TX" code from the edge headers at signup, if any; the age-verification rules read it later. */
export async function registerUser(input: z.infer<typeof signupSchema>, opts: { jurisdiction?: string | null } = {}) {
  const age = ageOn(input.dateOfBirth);
  if (!Number.isFinite(age) || age > 120) throw new HttpError(422, "invalid_input", "Enter a real date of birth.", { fieldErrors: { dateOfBirth: ["Enter a real date of birth."] } });
  if (age < ADULT_AGE) {
    // Do not store anything about an underage visitor.
    throw new HttpError(403, "underage", "Hushloom is for adults only.");
  }
  const db = getDb();
  const passwordHash = await hashPassword(input.password);
  try {
    return await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          email: input.email,
          passwordHash,
          dateOfBirth: input.dateOfBirth,
          ageAssuranceMethod: "self_declaration",
          ageAssuredAt: new Date(),
          jurisdiction: opts.jurisdiction ?? null,
        })
        .returning();
      await tx.insert(userProfiles).values({ userId: user!.id, handle: input.handle, displayName: input.displayName });
      await tx.insert(userPreferences).values({ userId: user!.id });
      await tx.insert(creditAccounts).values({ userId: user!.id });
      await tx.insert(consentRecords).values([
        { userId: user!.id, kind: "terms", statement: TERMS_STATEMENT },
        { userId: user!.id, kind: "adult_attestation", statement: ADULT_STATEMENT },
      ]);
      const grant = env().SIGNUP_GRANT_CREDITS;
      if (grant > 0) {
        await applyMovement(tx, {
          userId: user!.id,
          kind: "signup_grant",
          availableDelta: grant,
          reservedDelta: 0,
          idempotencyKey: `signup:${user!.id}`,
          note: "Welcome credits",
        });
      }
      await audit(user!.id, "account.create", "user", user!.id, {}, tx);
      return user!;
    });
  } catch (e) {
    const msg = String((e as { message?: string }).message ?? "");
    const cause = String((e as { cause?: { message?: string } }).cause?.message ?? "");
    if (/users_email_uq/.test(msg + cause)) throw new HttpError(409, "email_taken", "That email already has an account.", { fieldErrors: { email: ["That email already has an account."] } });
    if (/user_profiles_handle_uq/.test(msg + cause)) throw new HttpError(409, "handle_taken", "That handle is taken.", { fieldErrors: { handle: ["That handle is taken."] } });
    throw e;
  }
}

let dummyHash: string | undefined;

export async function authenticate(email: string, password: string) {
  const [user] = await getDb()
    .select()
    .from(users)
    .where(and(sql`lower(${users.email}) = ${email.trim().toLowerCase()}`, eq(users.status, "active"), isNull(users.deletedAt)));
  // Compare against a dummy hash when the user is missing so timing does not reveal accounts.
  dummyHash ??= await hashPassword("not-a-real-password");
  const ok = await verifyPassword(password, user?.passwordHash ?? dummyHash);
  return ok && user ? user : null;
}

/** Withdrawing consent removes everything made from what it covered. */
export async function withdrawConsent(userId: string, consentId: string) {
  const removed = await getDb().transaction(async (tx) => {
    const [record] = await tx
      .update(consentRecords)
      .set({ withdrawnAt: new Date() })
      .where(and(eq(consentRecords.id, consentId), eq(consentRecords.userId, userId), isNull(consentRecords.withdrawnAt)))
      .returning();
    if (!record) throw new HttpError(404, "not_found", "Not found.");
    if (record.kind === "terms" || record.kind === "adult_attestation") {
      throw new HttpError(422, "use_account_deletion", "To withdraw this, delete your account in Settings.");
    }
    const now = new Date();
    const ups = await tx.select({ assetId: uploads.assetId }).from(uploads).where(eq(uploads.consentRecordId, consentId));
    const refs = await tx.select({ id: characterReferences.id, assetId: characterReferences.assetId }).from(characterReferences).where(eq(characterReferences.consentRecordId, consentId));
    const assetIds = [...ups.map((u) => u.assetId), ...refs.map((r) => r.assetId)];
    const refIds = refs.map((r) => r.id);
    if (refIds.length) await tx.update(characterReferences).set({ deletedAt: now }).where(inArray(characterReferences.id, refIds));
    const conds = [];
    if (assetIds.length) conds.push(arrayOverlaps(generationJobs.inputAssetIds, assetIds));
    if (refIds.length) conds.push(inArray(generationJobs.characterReferenceId, refIds));
    if (conds.length) {
      const jobs = await tx.select({ id: generationJobs.id }).from(generationJobs).where(and(eq(generationJobs.userId, userId), or(...conds)));
      if (jobs.length) {
        const jobIds = jobs.map((j) => j.id);
        const outs = await tx
          .select({ assetId: generationOutputs.assetId, posterAssetId: generationOutputs.posterAssetId })
          .from(generationOutputs)
          .where(inArray(generationOutputs.jobId, jobIds));
        await tx.update(generationOutputs).set({ deletedAt: now }).where(inArray(generationOutputs.jobId, jobIds));
        assetIds.push(...outs.flatMap((o) => (o.posterAssetId ? [o.assetId, o.posterAssetId] : [o.assetId])));
        await tx.update(generationJobs).set({ deletedAt: now, cancelRequested: true }).where(inArray(generationJobs.id, jobIds));
      }
    }
    if (assetIds.length) await tx.update(mediaAssets).set({ deletedAt: now }).where(inArray(mediaAssets.id, assetIds));
    await audit(userId, "consent.withdraw", "consent_record", consentId, { removedAssets: assetIds.length }, tx);
    return assetIds;
  });
  // Withdrawn likeness or upload consent is the case where waiting out the retention window would do harm.
  await purgeAssetsNow(removed);
}

/** Deletes an account: sessions end now, content is soft-deleted and purged after the retention window. */
export async function deleteAccount(userId: string, password: string) {
  const [user] = await getDb().select().from(users).where(eq(users.id, userId));
  if (!user || !(await verifyPassword(password, user.passwordHash))) throw new HttpError(403, "bad_password", "Password is incorrect.");
  const now = new Date();
  await getDb().transaction(async (tx) => {
    await tx
      .update(users)
      .set({ status: "deleted", deletedAt: now, email: `deleted-${randomUUID()}@invalid`, passwordHash: "!" })
      .where(eq(users.id, userId));
    await tx.update(userProfiles).set({ handle: `deleted_${userId.slice(0, 8)}`, displayName: "Deleted account", bio: "" }).where(eq(userProfiles.userId, userId));
    await tx.update(mediaAssets).set({ deletedAt: now }).where(and(eq(mediaAssets.ownerId, userId), isNull(mediaAssets.deletedAt)));
    await tx.update(generationOutputs).set({ deletedAt: now }).where(eq(generationOutputs.userId, userId));
    await tx.update(generationJobs).set({ deletedAt: now, cancelRequested: true }).where(eq(generationJobs.userId, userId));
    await tx.update(templates).set({ status: "removed", deletedAt: now }).where(eq(templates.creatorId, userId));
    await tx.delete(discoveryEvents).where(eq(discoveryEvents.userId, userId));
    await tx.update(consentRecords).set({ withdrawnAt: now }).where(and(eq(consentRecords.userId, userId), isNull(consentRecords.withdrawnAt)));
    await audit(userId, "account.delete", "user", userId, {}, tx);
  });
  await destroyAllSessions(userId);
}
