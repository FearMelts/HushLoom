import { DrizzleQueryError } from "drizzle-orm/errors";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/server/env";
import { scrubWhenInspected } from "@/server/log";
import * as schema from "./schema";

// A failed query's error carries the bound parameters (prompts, emails, search text). Next.js prints a
// page's or route handler's error before instrumentation's onRequestError can scrub it, so each one
// scrubs itself when printed. Done here, where the client that throws them is made: drizzle-orm is
// bundled into each server bundle, and this patches the copy that bundle's client uses.
scrubWhenInspected(DrizzleQueryError);

type Db = ReturnType<typeof drizzle<typeof schema>>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const globalForDb = globalThis as unknown as { hlDb?: Db; hlSql?: postgres.Sql };

export function getSql(): postgres.Sql {
  globalForDb.hlSql ??= postgres(env().DATABASE_URL, { max: 10, onnotice: () => {} });
  return globalForDb.hlSql;
}

export function getDb(): Db {
  globalForDb.hlDb ??= drizzle(getSql(), { schema });
  return globalForDb.hlDb;
}

export async function closeDb(): Promise<void> {
  await globalForDb.hlSql?.end({ timeout: 5 });
  globalForDb.hlSql = undefined;
  globalForDb.hlDb = undefined;
}

export { schema };
