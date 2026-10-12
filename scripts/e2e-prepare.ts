/**
 * Resets the e2e database and Redis db, migrates, and seeds, so every e2e run starts identical.
 * Refuses to touch a database whose name does not end in _e2e.
 */
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import postgres from "postgres";
import Redis from "ioredis";

const url = process.env.DATABASE_URL ?? "";
const name = new URL(url).pathname.slice(1);
if (!name.endsWith("_e2e")) throw new Error(`refusing to reset ${name}: e2e databases must end in _e2e`);

const admin = postgres(url.replace(/\/[^/]+$/, "/postgres"), { max: 1, onnotice: () => undefined });
const [exists] = await admin`select 1 from pg_database where datname = ${name}`;
if (!exists) await admin.unsafe(`create database "${name}"`);
await admin.end();

const db = postgres(url, { max: 1, onnotice: () => undefined });
await db.unsafe("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
await db.end();

const redis = new Redis(process.env.REDIS_URL ?? "");
await redis.flushdb();
redis.disconnect();

if (process.env.STORAGE_LOCAL_DIR) rmSync(process.env.STORAGE_LOCAL_DIR, { recursive: true, force: true });

execSync("npx tsx scripts/migrate.ts", { stdio: "inherit", env: process.env });
execSync("npx tsx scripts/seed.ts", { stdio: "inherit", env: process.env });
