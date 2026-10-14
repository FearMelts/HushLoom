import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  // Private generations must never be indexed.
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

// Installable web app (addendum §4). The worker script must never be served stale, and may control
// the whole origin; the manifest needs its registered media type.
const appShellHeaders = [
  {
    source: "/sw.js",
    headers: [
      { key: "Content-Type", value: "application/javascript; charset=utf-8" },
      { key: "Cache-Control", value: "no-cache" },
      { key: "Service-Worker-Allowed", value: "/" },
      { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
    ],
  },
  { source: "/manifest.webmanifest", headers: [{ key: "Content-Type", value: "application/manifest+json; charset=utf-8" }] },
];

const config: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: ["sharp", "bullmq", "ioredis", "postgres", "bcryptjs", "web-push"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }, ...appShellHeaders];
  },
};

export default config;
