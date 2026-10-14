import { randomBytes } from "node:crypto";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);
export const BASE_URL = `http://localhost:${PORT}`;

// Requests the service worker makes (network-first public pages, precaching) get the context's
// offline state and extra headers too, as a real device and a real edge would apply them. Without it
// Chromium's service worker stays online under context.setOffline(true) and the offline page never shows.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS ??= "1";

// Everything the e2e stack needs, isolated from the dev database, Redis db and storage.
const env = {
  NODE_ENV: "production",
  // A production build, but not a live site: the payment sandbox, the sandbox age check and the
  // development scanner may run (see isLiveDeployment in src/server/env.ts).
  APP_ENV: "test",
  APP_URL: BASE_URL,
  DATABASE_URL: process.env.E2E_DATABASE_URL ?? "postgres://playbox@localhost:5432/playbox_e2e",
  REDIS_URL: process.env.E2E_REDIS_URL ?? "redis://localhost:6379/2",
  STORAGE_LOCAL_DIR: path.resolve(".storage-e2e"),
  MEDIA_SIGNING_SECRET: process.env.E2E_MEDIA_SIGNING_SECRET ?? randomBytes(32).toString("hex"),
  SEED_PASSWORD: "e2e-password-123",
  ENABLE_DEMO_PROVIDER: "true",
  WORKER_HEALTH_PORT: "3901",
};

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: { baseURL: BASE_URL, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // Fresh database, production build, then the standalone server exactly as the Dockerfile runs it.
      // Standalone output copies neither .next/static nor public/ (sw.js, manifest, icons); e2e-serve copies
      // both in, and also finds server.js when Next nests the app (a worktree inside another checkout).
      command: `npx tsx scripts/e2e-prepare.ts && npx next build && PORT=${PORT} node scripts/e2e-serve.mjs`,
      url: `${BASE_URL}/api/health`,
      env,
      timeout: 600_000,
      reuseExistingServer: false,
      stdout: "pipe",
    },
    {
      // The worker waits for the app (and so for the migrated database) before it starts.
      command: `node scripts/wait-for.mjs ${BASE_URL}/api/health && npx tsx src/worker/index.ts`,
      url: "http://localhost:3901/health",
      env,
      timeout: 660_000,
      reuseExistingServer: false,
    },
  ],
});
