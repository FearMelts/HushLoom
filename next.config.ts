import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  // Private generations must never be indexed.
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

const config: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: ["sharp", "bullmq", "ioredis", "postgres", "bcryptjs"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default config;
