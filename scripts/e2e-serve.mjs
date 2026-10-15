// Starts the production standalone server for the e2e stack (playwright.config.ts), as the Dockerfile runs it.
//
// Next writes server.js at the root of .next/standalone, except when it infers a workspace root above
// the project (for example a git worktree nested inside another checkout that has its own lockfile).
// Then the app sits at its path relative to that root inside .next/standalone, with node_modules at
// the top. Both layouts are handled here. Standalone output copies neither .next/static nor public/
// (sw.js, the manifest, icons), so both are copied next to server.js before it starts.
import { spawn } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

const project = process.cwd();
const standalone = path.join(project, ".next", "standalone");

function serverDir() {
  if (existsSync(path.join(standalone, "server.js"))) return standalone;
  for (let up = path.dirname(project); up !== path.dirname(up); up = path.dirname(up)) {
    const nested = path.join(standalone, path.relative(up, project));
    if (existsSync(path.join(nested, "server.js"))) return nested;
  }
  throw new Error("No server.js under .next/standalone. Run `next build` with output: \"standalone\" first.");
}

const dir = serverDir();
for (const [from, to] of [
  [path.join(project, ".next", "static"), path.join(dir, ".next", "static")],
  [path.join(project, "public"), path.join(dir, "public")],
]) {
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
}

const server = spawn(process.execPath, [path.join(dir, "server.js")], { stdio: "inherit", env: process.env });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));
server.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
