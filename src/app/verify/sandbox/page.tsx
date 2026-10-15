import { and, eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { SandboxAgeCheck } from "@/components/sandbox-age-check";
import { ageVerificationProvider } from "@/server/age";
import { SANDBOX_SIGNATURE_HEADER, sandboxCallback } from "@/server/age/providers/sandbox";
import { VERIFY_PATH } from "@/server/age/service";
import { getCurrentUser } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { ageVerifications } from "@/server/db/schema";
import { isLiveDeployment } from "@/server/env";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sandbox age check" };

/**
 * The sandbox provider's hosted page. Only the signed-in owner of a pending sandbox check can
 * open it, and it never exists in production or when another provider is active.
 */
export default async function SandboxVerifyPage({ searchParams }: { searchParams: Promise<{ ref?: string }> }) {
  if (isLiveDeployment() || ageVerificationProvider().key !== "sandbox") notFound();
  const user = await getCurrentUser();
  const { ref } = await searchParams;
  if (!user) redirect(`/auth?next=${encodeURIComponent(`/verify/sandbox?ref=${ref ?? ""}`)}`);
  if (!ref) notFound();
  const [row] = await getDb()
    .select({ id: ageVerifications.id, status: ageVerifications.status })
    .from(ageVerifications)
    .where(and(eq(ageVerifications.userId, user.id), eq(ageVerifications.provider, "sandbox"), eq(ageVerifications.providerRef, ref)));
  if (!row) notFound();
  if (row.status !== "pending") redirect(VERIFY_PATH);
  return <SandboxAgeCheck verified={sandboxCallback(ref, "verified")} failed={sandboxCallback(ref, "failed")} header={SANDBOX_SIGNATURE_HEADER} returnTo={VERIFY_PATH} />;
}
