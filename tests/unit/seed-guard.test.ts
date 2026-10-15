import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// scripts/seed.ts creates an admin and sample accounts that share one password. Compose wraps it in a
// shell check, but `npm run db:seed` (or `docker compose run worker npm run db:seed`) skips that
// wrapper, so the script must refuse a live site itself. The database here is unreachable on purpose:
// a refusal never connects, and a permitted run fails on the connection instead.
const root = path.resolve(__dirname, "../..");

function runSeed(extra: Record<string, string>) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/seed.ts"], {
    cwd: root,
    encoding: "utf8",
    timeout: 25_000,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? os.homedir(),
      // A production build that passes the configuration check without any provider account.
      NODE_ENV: "production",
      MEDIA_SIGNING_SECRET: "x".repeat(32),
      STORAGE_LOCAL_DIR: path.join(os.tmpdir(), "hushloom-seed-guard"),
      SCAN_FAIL_CLOSED: "false",
      AGE_VERIFICATION_ENFORCE: "false",
      DATABASE_URL: "postgres://playbox@127.0.0.1:1/unreachable",
      REDIS_URL: "redis://127.0.0.1:1",
      SEED_PASSWORD: "shared-sample-password",
      ...extra,
    },
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

describe("scripts/seed.ts", () => {
  it("refuses a live site before touching the database (I04)", () => {
    for (const extra of [{}, { APP_ENV: "production" }] as Record<string, string>[]) {
      const { status, output } = runSeed(extra);
      expect(status).toBe(1);
      expect(output).toContain("never on a live site");
      expect(output).not.toContain("ECONNREFUSED");
    }
  });

  it("still runs on a private preview (it then fails here only because the database is unreachable)", () => {
    const { status, output } = runSeed({ APP_ENV: "staging" });
    expect(status).not.toBe(0);
    expect(output).not.toContain("never on a live site");
    expect(output).toContain("ECONNREFUSED");
  });
});
