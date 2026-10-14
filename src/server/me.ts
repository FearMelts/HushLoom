import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { ageVerificationStatus } from "@/server/age";
import { requirementFor, verificationHistory, VERIFY_PATH } from "@/server/age/service";
import type { AgeContext } from "@/server/age/rules";
import { audit } from "@/server/audit";
import { getDb } from "@/server/db";
import { consentRecords, discoveryEvents, sessions, templates, userPreferences, userProfiles } from "@/server/db/schema";
import { HttpError } from "@/server/http";
import { pushStatus } from "@/server/push";

export const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(40),
  handle: z
    .string()
    .trim()
    .min(3, "Handles are 3 to 24 characters.")
    .max(24, "Handles are 3 to 24 characters.")
    .regex(/^[a-zA-Z0-9_]+$/, "Letters, numbers and underscores only."),
  bio: z.string().trim().max(280).default(""),
});

export const preferencesSchema = z
  .object({
    personalizationEnabled: z.boolean(),
    historyEnabled: z.boolean(),
    autoplayPreviews: z.boolean(),
    copilotEnabled: z.boolean(),
    interests: z.array(z.string().trim().toLowerCase().min(1).max(24)).max(12),
    /** Opt-in push when a creation finishes (addendum §4); devices subscribe separately via /api/push/subscriptions. */
    notifyOnFinish: z.boolean(),
  })
  .partial();

/** The age-verification block of Settings: status, the jurisdiction in play, what is required, and the provider (with its sandbox label). */
export async function ageVerificationFor(userId: string, ctx: AgeContext) {
  const [req, history] = await Promise.all([requirementFor({ id: userId }, ctx), verificationHistory(userId)]);
  const provider = ageVerificationStatus();
  return {
    status: req.status,
    jurisdiction: req.jurisdiction,
    required: req.required,
    verifiedAt: req.verifiedAt?.toISOString() ?? null,
    expiresAt: req.expiresAt?.toISOString() ?? null,
    verifyPath: VERIFY_PATH,
    provider: { key: provider.provider, label: provider.label, sandbox: provider.sandbox, configured: provider.configured, methods: provider.methods, validDays: provider.validDays, enforce: provider.enforce },
    history: history.map((h) => ({
      id: h.id,
      provider: h.provider,
      status: h.status,
      method: h.method,
      jurisdiction: h.jurisdiction,
      failureReason: h.failureReason,
      startedAt: h.startedAt.toISOString(),
      completedAt: h.completedAt?.toISOString() ?? null,
      expiresAt: h.expiresAt?.toISOString() ?? null,
    })),
  };
}

export type AgeVerificationSettings = Awaited<ReturnType<typeof ageVerificationFor>>;

export async function settingsFor(userId: string, ctx: AgeContext = { country: null }) {
  const db = getDb();
  const [[profile], [prefs], consents, [sessionCount], tags, ageVerification] = await Promise.all([
    db.select().from(userProfiles).where(eq(userProfiles.userId, userId)),
    db.select().from(userPreferences).where(eq(userPreferences.userId, userId)),
    db.select().from(consentRecords).where(eq(consentRecords.userId, userId)).orderBy(desc(consentRecords.grantedAt)).limit(100),
    db.select({ n: sql<number>`count(*)::int` }).from(sessions).where(and(eq(sessions.userId, userId), sql`${sessions.expiresAt} > now()`)),
    db.execute<{ tag: string }>(
      sql`select tag from ${templates}, unnest(${templates.tags}) tag where ${templates.status} = 'published' and ${templates.deletedAt} is null group by tag order by count(*) desc, tag limit 30`,
    ),
    ageVerificationFor(userId, ctx),
  ]);
  return {
    ageVerification,
    profile: { displayName: profile?.displayName ?? "", handle: profile?.handle ?? "", bio: profile?.bio ?? "" },
    preferences: {
      personalizationEnabled: prefs?.personalizationEnabled ?? true,
      historyEnabled: prefs?.historyEnabled ?? true,
      autoplayPreviews: prefs?.autoplayPreviews ?? false,
      copilotEnabled: prefs?.copilotEnabled ?? true,
      interests: prefs?.interests ?? [],
      notifyOnFinish: prefs?.notifyOnFinish ?? false,
    },
    pushEnabled: pushStatus().enabled,
    consents: consents.map((c) => ({
      id: c.id,
      kind: c.kind,
      statement: c.statement,
      subjectLabel: c.subjectLabel,
      grantedAt: c.grantedAt.toISOString(),
      withdrawnAt: c.withdrawnAt?.toISOString() ?? null,
    })),
    activeSessions: sessionCount?.n ?? 0,
    popularTags: tags.map((t) => t.tag),
  };
}

export async function updateProfile(userId: string, input: z.infer<typeof profileSchema>) {
  const [taken] = await getDb()
    .select({ id: userProfiles.userId })
    .from(userProfiles)
    .where(and(sql`lower(${userProfiles.handle}) = ${input.handle.toLowerCase()}`, ne(userProfiles.userId, userId)));
  if (taken) throw new HttpError(409, "handle_taken", "That handle is taken.", { fieldErrors: { handle: ["That handle is taken."] } });
  await getDb().update(userProfiles).set({ ...input, updatedAt: new Date() }).where(eq(userProfiles.userId, userId));
  await audit(userId, "profile.update", "user", userId, { handle: input.handle });
}

export async function updatePreferences(userId: string, input: z.infer<typeof preferencesSchema>) {
  if (!Object.keys(input).length) return;
  await getDb()
    .insert(userPreferences)
    .values({ userId, ...input })
    .onConflictDoUpdate({ target: userPreferences.userId, set: { ...input, updatedAt: new Date() } });
  // Turning history off also forgets what was recorded so far.
  if (input.historyEnabled === false) await clearHistory(userId);
}

/** Forgets viewing and making history used for For You and Continue exploring. */
export async function clearHistory(userId: string) {
  const res = await getDb().delete(discoveryEvents).where(eq(discoveryEvents.userId, userId)).returning({ id: discoveryEvents.id });
  await audit(userId, "history.clear", "user", userId, { removed: res.length });
  return res.length;
}

export async function activeConsents(userId: string) {
  return getDb()
    .select()
    .from(consentRecords)
    .where(and(eq(consentRecords.userId, userId), isNull(consentRecords.withdrawnAt)));
}
