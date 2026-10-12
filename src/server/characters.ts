import { and, desc, eq, isNull } from "drizzle-orm";
import { withdrawConsent } from "@/server/auth/account";
import { getDb } from "@/server/db";
import { characterReferences, consentRecords, mediaAssets, uploads } from "@/server/db/schema";
import { HttpError, notFound } from "@/server/http";
import { acceptUpload, assetUrl } from "@/server/media";

export const LIKENESS_STATEMENT =
  "This person is an adult (18+). It is me, or they gave me explicit permission to create sexual content with their likeness, and I can show that permission if asked. I understand removing this reference deletes it and every creation made with it.";

/**
 * A character reference is a consented photo the generator conditions on. This build
 * does not fine-tune or train a model on it; providers that accept a reference image
 * receive it at generation time.
 */
export async function listCharacters(userId: string) {
  const rows = await getDb()
    .select({ ref: characterReferences, asset: mediaAssets, grantedAt: consentRecords.grantedAt })
    .from(characterReferences)
    .innerJoin(mediaAssets, eq(mediaAssets.id, characterReferences.assetId))
    .innerJoin(consentRecords, eq(consentRecords.id, characterReferences.consentRecordId))
    .where(and(eq(characterReferences.userId, userId), isNull(characterReferences.deletedAt), isNull(consentRecords.withdrawnAt)))
    .orderBy(desc(characterReferences.createdAt));
  return Promise.all(
    rows.map(async (r) => ({
      id: r.ref.id,
      name: r.ref.name,
      createdAt: r.ref.createdAt.toISOString(),
      consentGrantedAt: r.grantedAt.toISOString(),
      imageUrl: await assetUrl(r.asset, userId),
      width: r.asset.width,
      height: r.asset.height,
    })),
  );
}

export async function createCharacter(userId: string, file: { bytes: Buffer; declaredMime: string }, name: string, subjectLabel: string | null) {
  if (!file.declaredMime.startsWith("image/")) throw new HttpError(415, "unsupported_type", "A character reference must be a photo (JPG, PNG or WebP).");
  const [existing] = await getDb()
    .select({ id: characterReferences.id })
    .from(characterReferences)
    .where(and(eq(characterReferences.userId, userId), isNull(characterReferences.deletedAt)))
    .offset(19)
    .limit(1);
  if (existing) throw new HttpError(422, "limit_reached", "You can keep up to 20 characters. Remove one first.");
  const up = await acceptUpload(userId, file, { statement: LIKENESS_STATEMENT, subjectLabel: subjectLabel ?? name }, "reference");
  const [u] = await getDb().select({ consentRecordId: uploads.consentRecordId }).from(uploads).where(eq(uploads.assetId, up.assetId));
  const [ref] = await getDb()
    .insert(characterReferences)
    .values({ userId, name, assetId: up.assetId, consentRecordId: u!.consentRecordId! })
    .returning();
  return { id: ref!.id, warnings: up.warnings };
}

/** Removing a character withdraws its likeness consent, which deletes the reference and every creation that used it. */
export async function removeCharacter(userId: string, characterId: string) {
  const [ref] = await getDb()
    .select({ consentRecordId: characterReferences.consentRecordId })
    .from(characterReferences)
    .where(and(eq(characterReferences.id, characterId), eq(characterReferences.userId, userId), isNull(characterReferences.deletedAt)));
  if (!ref) throw notFound();
  await withdrawConsent(userId, ref.consentRecordId);
}
