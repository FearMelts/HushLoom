import { execSync } from "node:child_process";

export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://playbox@localhost:5432/playbox_test";
  execSync("npx tsx scripts/migrate.ts", { env: { ...process.env, DATABASE_URL: url }, stdio: "inherit" });
}
