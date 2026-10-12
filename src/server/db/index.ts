import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/server/env";
import * as schema from "./schema";

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
