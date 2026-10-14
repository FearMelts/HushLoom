import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// .env.example must keep up with src/server/env.ts: a variable added there without a line here fails this test.
const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

/** Keys of the zod schema in env.ts, with their default literal when they have one. */
function schemaKeys(): Map<string, string | null> {
  const keys = new Map<string, string | null>();
  for (const m of read("src/server/env.ts").matchAll(/^ {2}([A-Z][A-Z0-9_]*): z\.(.*)$/gm)) {
    const def = m[2]!.match(/\.default\(("?)([^")]*)\1\)/);
    keys.set(m[1]!, def ? def[2]! : null);
  }
  return keys;
}

/** Every KEY=value line of the template, commented or not. */
function templateEntries(): { key: string; value: string; commented: boolean }[] {
  return [...read(".env.example").matchAll(/^(#\s?)?([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((m) => ({ key: m[2]!, value: m[3]!, commented: Boolean(m[1]) }));
}

/** process.env.X reads outside env.ts (scripts, test configs, middleware). */
function directReads(): Set<string> {
  const files = [
    ...["src", "scripts"].flatMap((dir) =>
      (readdirSync(path.join(root, dir), { recursive: true }) as string[]).filter((f) => /\.(ts|tsx|mjs)$/.test(f)).map((f) => path.join(dir, f)),
    ),
    "playwright.config.ts",
    "vitest.config.ts",
  ];
  const names = new Set<string>();
  for (const f of files) for (const m of read(f).matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1]!);
  return names;
}

describe(".env.example", () => {
  const keys = schemaKeys();
  const entries = templateEntries();
  const documented = new Set(entries.map((e) => e.key));

  it("lists every variable in src/server/env.ts", () => {
    expect(keys.size).toBeGreaterThan(40); // the parse found the schema
    expect([...keys.keys()].filter((k) => !documented.has(k))).toEqual([]);
  });

  it("lists every variable read directly, plus the seed, compose and test overrides", () => {
    const set = new Set(["SEED_PASSWORD", "POSTGRES_PASSWORD", "TEST_DATABASE_URL", "TEST_REDIS_URL", "E2E_DATABASE_URL", "E2E_REDIS_URL", ...directReads()]);
    set.delete("NEXT_RUNTIME"); // set by Next.js itself
    expect([...set].filter((k) => !documented.has(k))).toEqual([]);
  });

  it("sets nothing when copied as is: every assignment is commented out", () => {
    expect(entries.filter((e) => !e.commented).map((e) => e.key)).toEqual([]);
  });

  it("holds no secret values, and every value shown is the default from env.ts", () => {
    const secretish = /SECRET|KEY|TOKEN|PASSWORD|SALT|WEBHOOK_URL/;
    expect(entries.filter((e) => secretish.test(e.key) && e.value !== "").map((e) => e.key)).toEqual([]);
    for (const e of entries) {
      if (e.value === "" || !keys.has(e.key)) continue;
      expect({ key: e.key, value: e.value }).toEqual({ key: e.key, value: keys.get(e.key) });
    }
  });

  it("says APP_ENV stays unset on a live site", () => {
    const text = read(".env.example");
    expect(text).toMatch(/Unset on a live site/);
    expect(text).toMatch(/"staging" is for a private preview only/);
  });
});
