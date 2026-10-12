import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    env: {
      NODE_ENV: "test",
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://playbox@localhost:5432/playbox_test",
      REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://localhost:6379/1",
      STORAGE_LOCAL_DIR: ".storage-test",
      ENABLE_DEMO_PROVIDER: "true",
      // Fake values: webhook tests sign and verify locally, nothing reaches Stripe.
      STRIPE_SECRET_KEY: "sk_test_local_placeholder",
      STRIPE_WEBHOOK_SECRET: "whsec_local_test_secret",
    },
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
