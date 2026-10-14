import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Checks on the repository and deployment files themselves (.gitignore, docker-compose.yml).
const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

/** Each service's published ports as written in docker-compose.yml, with `${VAR:-default}` filled in. */
function publishedPorts(): Map<string, string[]> {
  const text = read("docker-compose.yml");
  const services = text.slice(text.indexOf("\nservices:\n"), text.indexOf("\nvolumes:\n"));
  const ports = new Map<string, string[]>();
  let service = "";
  let inPorts = false;
  for (const line of services.split("\n")) {
    const name = line.match(/^ {2}([a-z0-9-]+):$/);
    if (name) {
      service = name[1]!;
      ports.set(service, []);
      inPorts = false;
    } else if (/^ {4}ports:$/.test(line)) {
      inPorts = true;
    } else if (inPorts && /^ {6}- /.test(line)) {
      const spec = line.replace(/^ {6}- /, "").replace(/^"(.*)"$/, "$1");
      ports.get(service)!.push(spec.replace(/\$\{[A-Z0-9_]+:-([^}]*)\}/g, "$1"));
    } else {
      inPorts = false;
    }
  }
  return ports;
}

describe(".gitignore", () => {
  /** Whether git would ignore this path (by the ignore rules alone, tracked or not). */
  const ignored = (file: string) => spawnSync("git", ["check-ignore", "-q", "--no-index", file], { cwd: root }).status === 0;

  // Next.js reads .env.production, .env.*.local and friends on its own, so they hold real keys too.
  it("keeps every local environment file out of git, but not the template (I06)", () => {
    const files = [".env", ".env.local", ".env.production", ".env.production.local", ".env.development.local", ".env.staging", ".env.test.local"];
    expect(files.filter((file) => !ignored(file))).toEqual([]);
    expect(ignored(".env.example")).toBe(false);
  });
});

describe("docker-compose.yml", () => {
  const ports = publishedPorts();

  it("defines the services this check reads", () => {
    expect([...ports.keys()]).toEqual(expect.arrayContaining(["postgres", "redis", "web", "worker", "minio"]));
  });

  it("never publishes Postgres or Redis to the host", () => {
    expect(ports.get("postgres")).toEqual([]);
    expect(ports.get("redis")).toEqual([]);
  });

  // The app trusts the geo headers (age verification) as received: only the edge, which strips the
  // client's copies, may reach it. A port published on every interface also bypasses host firewalls
  // such as ufw, because Docker writes its own iptables rules ahead of them.
  it("publishes no port beyond this machine by default (I03)", () => {
    const all = [...ports.entries()].flatMap(([service, specs]) => specs.map((spec) => ({ service, spec })));
    expect(all.length).toBeGreaterThan(0);
    expect(all.filter(({ spec }) => !/^127\.0\.0\.1:\d+:\d+$/.test(spec))).toEqual([]);
  });

  it("documents the web app's bind address in .env.example", () => {
    expect(read(".env.example")).toMatch(/^# WEB_BIND=127\.0\.0\.1$/m);
  });
});
