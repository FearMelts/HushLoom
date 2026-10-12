import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL ?? "postgres://playbox@localhost:5432/playbox";
const sql = postgres(url, { max: 1, onnotice: () => {} });
await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
await sql.end();
console.log("migrations applied");
