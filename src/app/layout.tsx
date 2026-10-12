import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import { AgeGate } from "@/components/age-gate";
import { Shell, type ShellUser } from "@/components/shell";
import { getCurrentUser } from "@/server/auth/session";
import { getBalance } from "@/server/credits/ledger";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Hushloom", template: "%s · Hushloom" },
  description: "An adults-only playground for making images and short videos from templates.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#0f0a0d",
  width: "device-width",
  initialScale: 1,
};

const AGE_COOKIE = "hl_age_ok";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  const shellUser: ShellUser = user
    ? { id: user.id, handle: user.handle, displayName: user.displayName, role: user.role, credits: (await getBalance(user.id)).available }
    : null;
  const ageOk = Boolean(user) || (await cookies()).get(AGE_COOKIE)?.value === "1";
  const path = (await headers()).get("x-pathname") ?? "/";
  const gated = !ageOk && !path.startsWith("/policies");

  return (
    <html lang="en">
      <body>{gated ? <AgeGate /> : <Shell user={shellUser}>{children}</Shell>}</body>
    </html>
  );
}
