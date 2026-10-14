import { and, eq, isNull, ne, or } from "drizzle-orm";
import { audit } from "@/server/audit";
import type { SessionUser } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { ageVerifications, users } from "@/server/db/schema";
import { env } from "@/server/env";
import { HttpError } from "@/server/http";
import { logger } from "@/server/log";
import { ageVerificationProvider } from "./index";
import { contextJurisdiction, expiryFor, jurisdictionRequired, type AgeContext } from "./rules";
import { CallbackRejected, type VerificationResult } from "./types";

export type AgeStatus = (typeof users.$inferSelect)["ageVerificationStatus"];

/** The columns on users that the gate needs; the session loader carries them so the check costs no extra query. */
export type AgeFields = {
  jurisdiction: string | null;
  ageVerificationStatus: AgeStatus;
  ageVerifiedAt: Date | null;
  ageVerificationProvider: string | null;
};

export type AgeSubject = Pick<SessionUser, "id"> & Partial<AgeFields>;

export type AgeRequirement = {
  jurisdiction: string | null;
  required: boolean;
  status: AgeStatus;
  verifiedAt: Date | null;
  expiresAt: Date | null;
  provider: string | null;
};

/** What a page or API route needs to decide whether to issue explicit media URLs. */
export type Viewer = { id: string | null; explicitAllowed: boolean };

export type ViewerAccess = {
  user: SessionUser | null;
  jurisdiction: string | null;
  required: boolean;
  status: AgeStatus | null;
  explicitAllowed: boolean;
  viewer: Viewer;
};

export const VERIFY_PATH = "/settings#age-verification";

async function ageFields(user: AgeSubject): Promise<AgeFields> {
  if (user.ageVerificationStatus !== undefined && user.jurisdiction !== undefined && user.ageVerifiedAt !== undefined && user.ageVerificationProvider !== undefined) {
    return { jurisdiction: user.jurisdiction, ageVerificationStatus: user.ageVerificationStatus, ageVerifiedAt: user.ageVerifiedAt, ageVerificationProvider: user.ageVerificationProvider };
  }
  const [row] = await getDb()
    .select({ jurisdiction: users.jurisdiction, ageVerificationStatus: users.ageVerificationStatus, ageVerifiedAt: users.ageVerifiedAt, ageVerificationProvider: users.ageVerificationProvider })
    .from(users)
    .where(eq(users.id, user.id));
  if (!row) throw new HttpError(401, "unauthorized", "Sign in to continue.");
  return row;
}

/**
 * The verification requirement for a user in the context of one request. Verification is required
 * when either the jurisdiction stored on the account (signup, refreshed at sign-in) or the current
 * request's geo headers require it, so a stored uncovered place never unlocks a request from a
 * covered one. With no location on the request, the stored value decides alone. The jurisdiction
 * reported is the one that requires the check, else the stored one, else the request's.
 * A verified status past its expiry reads as expired and must be redone.
 */
export async function requirementFor(user: AgeSubject, ctx: AgeContext): Promise<AgeRequirement> {
  const f = await ageFields(user);
  const current = contextJurisdiction(ctx);
  const codes = current ? [f.jurisdiction, current].filter((c) => c !== null) : [f.jurisdiction];
  const required = codes.some((c) => jurisdictionRequired(c));
  const jurisdiction = codes.find((c) => jurisdictionRequired(c)) ?? f.jurisdiction ?? current;
  const expiresAt = f.ageVerificationStatus === "verified" ? expiryFor(f.ageVerifiedAt) : null;
  const status: AgeStatus = f.ageVerificationStatus === "verified" && (!expiresAt || expiresAt.getTime() <= Date.now()) ? "expired" : f.ageVerificationStatus;
  return { jurisdiction, required, status, verifiedAt: f.ageVerifiedAt, expiresAt, provider: f.ageVerificationProvider };
}

export function satisfied(req: AgeRequirement): boolean {
  return !req.required || req.status === "verified";
}

/** One decision per request: may this viewer (signed in or not) see explicit media here? */
export async function viewerAccessFor(user: SessionUser | null, ctx: AgeContext): Promise<ViewerAccess> {
  if (user) {
    const req = await requirementFor(user, ctx);
    const explicitAllowed = satisfied(req);
    return { user, jurisdiction: req.jurisdiction, required: req.required, status: req.status, explicitAllowed, viewer: { id: user.id, explicitAllowed } };
  }
  const jurisdiction = contextJurisdiction(ctx);
  const required = jurisdictionRequired(jurisdiction);
  return { user: null, jurisdiction, required, status: null, explicitAllowed: !required, viewer: { id: null, explicitAllowed: !required } };
}

/** Stores the jurisdiction seen at signup or sign-in. A missing header keeps what was stored. */
export async function rememberJurisdiction(userId: string, code: string | null): Promise<void> {
  if (!code) return;
  await getDb()
    .update(users)
    .set({ jurisdiction: code, updatedAt: new Date() })
    .where(and(eq(users.id, userId), or(isNull(users.jurisdiction), ne(users.jurisdiction, code))));
}

export type StartedVerification = { url: string; providerRef: string; verificationId: string; provider: string; sandbox: boolean };

/** Opens a check with the active provider: a pending age_verifications row, the user marked pending, an audit entry. */
export async function startVerification(user: SessionUser, ctx: AgeContext): Promise<StartedVerification> {
  const provider = ageVerificationProvider();
  if (!provider.isConfigured()) throw new HttpError(503, "age_verification_unavailable", "Age checks are not set up on this server yet. Try again later.");
  const req = await requirementFor(user, ctx);
  if (req.status === "verified") throw new HttpError(409, "already_verified", "Your age is already verified.");
  const db = getDb();
  const [row] = await db.insert(ageVerifications).values({ userId: user.id, provider: provider.key, status: "pending", jurisdiction: req.jurisdiction }).returning();
  const verification = row!;
  let started;
  try {
    started = await provider.start({ userId: user.id, verificationId: verification.id, returnUrl: new URL(VERIFY_PATH, env().APP_URL).toString(), jurisdiction: req.jurisdiction });
  } catch (err) {
    logger.error("age verification start failed", { provider: provider.key, verificationId: verification.id, err });
    await db.update(ageVerifications).set({ status: "failed", failureReason: "start_failed", completedAt: new Date() }).where(eq(ageVerifications.id, verification.id));
    throw new HttpError(502, "age_verification_unavailable", "The age-check provider did not respond. Try again in a minute.");
  }
  await db.transaction(async (tx) => {
    await tx.update(ageVerifications).set({ providerRef: started.providerRef, method: started.method }).where(eq(ageVerifications.id, verification.id));
    await tx.update(users).set({ ageVerificationStatus: "pending", ageVerificationProvider: provider.key, updatedAt: new Date() }).where(eq(users.id, user.id));
    await audit(user.id, "age_verification.pending", "age_verification", verification.id, { provider: provider.key, providerRef: started.providerRef, jurisdiction: req.jurisdiction, sandbox: provider.isSandbox }, tx);
  });
  return { url: started.url, providerRef: started.providerRef, verificationId: verification.id, provider: provider.key, sandbox: provider.isSandbox };
}

export type AppliedResult = { outcome: VerificationResult["outcome"]; verificationId: string; userId: string };

/**
 * Records a provider outcome against its pending row. A reference that is already completed is a
 * replay and changes nothing. Only the outcome is stored: never images, documents or biometrics.
 */
export async function applyResult(providerKey: string, result: VerificationResult): Promise<AppliedResult> {
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(ageVerifications)
      .where(and(eq(ageVerifications.provider, providerKey), eq(ageVerifications.providerRef, result.providerRef)))
      .for("update");
    if (!row) throw new HttpError(404, "unknown_reference", "No age check matches that reference.");
    if (row.status !== "pending") throw new HttpError(409, "callback_replayed", "This age check was already completed.");
    if (result.outcome === "pending") return { outcome: "pending" as const, verificationId: row.id, userId: row.userId };
    const now = new Date();
    const method = result.method ?? row.method;
    const base = { provider: providerKey, providerRef: result.providerRef, userId: row.userId, jurisdiction: row.jurisdiction, method };
    if (result.outcome === "verified") {
      const expiresAt = expiryFor(now)!;
      await tx.update(ageVerifications).set({ status: "verified", method, completedAt: now, expiresAt }).where(eq(ageVerifications.id, row.id));
      await tx.update(users).set({ ageVerificationStatus: "verified", ageVerifiedAt: now, ageVerificationProvider: providerKey, updatedAt: now }).where(eq(users.id, row.userId));
      await audit(null, "age_verification.verified", "age_verification", row.id, { ...base, expiresAt: expiresAt.toISOString() }, tx);
    } else {
      const reason = result.failureReason ?? "failed";
      await tx.update(ageVerifications).set({ status: "failed", method, completedAt: now, failureReason: reason }).where(eq(ageVerifications.id, row.id));
      // A failed attempt never downgrades an account that another attempt already verified.
      await tx
        .update(users)
        .set({ ageVerificationStatus: "failed", ageVerificationProvider: providerKey, updatedAt: now })
        .where(and(eq(users.id, row.userId), ne(users.ageVerificationStatus, "verified")));
      await audit(null, "age_verification.failed", "age_verification", row.id, { ...base, reason }, tx);
    }
    return { outcome: result.outcome, verificationId: row.id, userId: row.userId };
  });
}

/** A provider callback: signature first, then the outcome goes through applyResult. Rejections change nothing. */
export async function handleCallback(providerKey: string, input: { rawBody: string; headers: Headers; url: URL }): Promise<AppliedResult> {
  const provider = ageVerificationProvider();
  if (provider.key !== providerKey) throw new HttpError(404, "not_found", "Not found.");
  let result: VerificationResult;
  try {
    result = await provider.verifyCallback(input);
  } catch (err) {
    if (err instanceof CallbackRejected) {
      logger.warn("age verification callback rejected", { provider: providerKey, reason: err.reason });
      throw new HttpError(err.reason === "unconfigured" ? 503 : 400, `callback_${err.reason}`, err.message);
    }
    throw err;
  }
  return applyResult(provider.key, result);
}

/** For providers that report synchronously: the signed-in owner of a pending check asks the provider for its result. */
export async function syncVerification(user: SessionUser, providerRef: string): Promise<AppliedResult> {
  const provider = ageVerificationProvider();
  if (!provider.fetchResult) throw new HttpError(404, "not_found", "Not found.");
  const [row] = await getDb()
    .select({ id: ageVerifications.id, status: ageVerifications.status })
    .from(ageVerifications)
    .where(and(eq(ageVerifications.userId, user.id), eq(ageVerifications.provider, provider.key), eq(ageVerifications.providerRef, providerRef)));
  if (!row) throw new HttpError(404, "not_found", "Not found.");
  if (row.status !== "pending") return { outcome: row.status === "verified" ? "verified" : "failed", verificationId: row.id, userId: user.id };
  return applyResult(provider.key, await provider.fetchResult(providerRef));
}

/** The user's verification history for Settings: outcomes and timestamps only. */
export async function verificationHistory(userId: string, limit = 10) {
  return getDb()
    .select({
      id: ageVerifications.id,
      provider: ageVerifications.provider,
      status: ageVerifications.status,
      method: ageVerifications.method,
      jurisdiction: ageVerifications.jurisdiction,
      failureReason: ageVerifications.failureReason,
      startedAt: ageVerifications.startedAt,
      completedAt: ageVerifications.completedAt,
      expiresAt: ageVerifications.expiresAt,
    })
    .from(ageVerifications)
    .where(eq(ageVerifications.userId, userId))
    .orderBy(ageVerifications.createdAt)
    .limit(limit);
}
