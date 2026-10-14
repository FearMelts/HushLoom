import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, vi } from "vitest";
import type { SessionUser } from "@/server/auth/session";
import { applyMovement } from "@/server/credits/ledger";
import { getDb } from "@/server/db";
import { userProfiles, users } from "@/server/db/schema";
import * as serverEnv from "@/server/env";
import { redis } from "@/server/redis";

export async function resetDb() {
  const tables = await getDb().execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public' and tablename <> '__drizzle_migrations'`,
  );
  const names = tables.map((t) => `"${t.tablename}"`).join(", ");
  await getDb().execute(sql.raw(`truncate ${names} restart identity cascade`));
  await redis().flushdb();
}

export async function makeUser(opts: { credits?: number; role?: SessionUser["role"]; handle?: string } = {}): Promise<SessionUser> {
  const handle = opts.handle ?? `u${randomUUID().slice(0, 8)}`;
  const [u] = await getDb()
    .insert(users)
    .values({
      email: `${handle}@example.test`,
      passwordHash: "x",
      role: opts.role ?? "member",
      dateOfBirth: "1990-01-01",
      ageAssuranceMethod: "self_declaration",
      ageAssuredAt: new Date(),
    })
    .returning();
  await getDb().insert(userProfiles).values({ userId: u!.id, handle, displayName: handle });
  if (opts.credits) {
    await getDb().transaction((tx) =>
      applyMovement(tx, { userId: u!.id, kind: "admin_adjust", availableDelta: opts.credits!, reservedDelta: 0, idempotencyKey: `test-grant:${u!.id}` }),
    );
  }
  return { id: u!.id, email: u!.email, role: u!.role, handle, displayName: handle, ageAssuranceMethod: "self_declaration" };
}

export const key = () => `test-${randomUUID()}`;

/**
 * Runs the enclosing describe's tests as if TRUSTED_PROXY_HOPS were `hops`. The default is 0 (no proxy),
 * where every request shares one rate-limit key; tests of per-address limits run behind a proxy.
 */
export function withTrustedProxyHops(hops: number) {
  beforeEach(() => {
    const actual = serverEnv.env();
    vi.spyOn(serverEnv, "env").mockReturnValue({ ...actual, TRUSTED_PROXY_HOPS: hops });
  });
  afterEach(() => {
    vi.mocked(serverEnv.env).mockRestore();
  });
}
