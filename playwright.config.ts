import { randomBytes } from "node:crypto";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);
export const BASE_URL = `http://localhost:${PORT}`;

// Everything the e2e stack needs, isolated from the dev database, Redis db and storage.
const env = {
  NODE_ENV: "production",
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
      command: `npx tsx scripts/e2e-prepare.ts && npx next build && cp -r .next/static .next/standalone/.next/static && PORT=${PORT} node .next/standalone/server.js`,
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
