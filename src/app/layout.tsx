import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import { AgeGate } from "@/components/age-gate";
import { ServiceWorkerRegistrar } from "@/components/service-worker";
import { Shell, type ShellUser } from "@/components/shell";
import { getCurrentUser } from "@/server/auth/session";
import { getBalance } from "@/server/credits/ledger";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Hushloom", template: "%s · Hushloom" },
  description: "An adults-only playground for making images and short videos from templates.",
  robots: { index: false, follow: false },
  // Installable web app (addendum §4): the manifest, icons and home-screen behavior on iOS.
  applicationName: "Hushloom",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icons/mark.svg", type: "image/svg+xml" },
      { url: "/icons/icon-32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: { capable: true, title: "Hushloom", statusBarStyle: "black" },
  formatDetection: { telephone: false },
  // Next emits mobile-web-app-capable; iOS before 16.4 only reads the apple- prefixed name.
  other: { "apple-mobile-web-app-capable": "yes" },
};

export const viewport: Viewport = {
  themeColor: "#0f0a0d",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  // Lets the tab bar's env(safe-area-inset-bottom) padding clear the home indicator.
  viewportFit: "cover",
};

const AGE_COOKIE = "hl_age_ok";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const path = (await headers()).get("x-pathname") ?? "/";
  // The offline page is the same for everyone (the service worker caches it): no shell, no account, no gate.
  if (path === "/offline") {
    return (
      <html lang="en">
        <body>{children}</body>
      </html>
    );
  }

  const user = await getCurrentUser();
  const shellUser: ShellUser = user
    ? { id: user.id, handle: user.handle, displayName: user.displayName, role: user.role, credits: (await getBalance(user.id)).available }
    : null;
  const ageOk = Boolean(user) || (await cookies()).get(AGE_COOKIE)?.value === "1";
  const gated = !ageOk && !path.startsWith("/policies");

  return (
    <html lang="en">
      <body>
        {gated ? (
          <AgeGate />
        ) : (
          <Shell user={shellUser}>
            <ServiceWorkerRegistrar userId={user?.id ?? null} />
            {children}
          </Shell>
        )}
      </body>
    </html>
  );
}
