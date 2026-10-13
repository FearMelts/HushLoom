import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const serverUrl = new URL("../server.mjs", import.meta.url);
const assets = [
  ["/", "index.html", "text/html; charset=utf-8"],
  ["/index.html", "index.html", "text/html; charset=utf-8"],
  ["/styles.css", "styles.css", "text/css; charset=utf-8"],
  ["/src/app.js", "src/app.js", "text/javascript; charset=utf-8"],
  ["/src/catalog.js", "src/catalog.js", "text/javascript; charset=utf-8"],
];

async function startServer(t, url) {
  const previousPort = process.env.PORT;
  let server;
  try {
    process.env.PORT = "0";
    ({ server } = await import(url.href));
  } finally {
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
  }
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  if (!server.listening) await once(server, "listening");
  return server;
}

function sendRequest(server, path, method = "GET") {
  return new Promise((resolve, reject) => {
    // Preserve raw request targets: fetch would normalize traversal paths first.
    const req = request({
      hostname: "127.0.0.1",
      port: server.address().port,
      path,
      method,
      agent: false,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on("error", reject);
    req.setTimeout(2000, () => req.destroy(new Error("HTTP request timed out")));
    req.end();
  });
}

test("preview HTTP boundaries", { timeout: 15000 }, async (t) => {
  const server = await startServer(t, serverUrl);

  await t.test("every public asset has exact content, MIME type, and security headers", async () => {
    for (const [path, file, contentType] of assets) {
      const response = await sendRequest(server, path);
      assert.equal(response.status, 200, path);
      assert.deepEqual(response.body, await readFile(new URL(`../${file}`, import.meta.url)), path);
      assert.equal(response.headers["content-type"], contentType, path);
      assert.equal(response.headers["x-content-type-options"], "nosniff", path);
      assert.equal(response.headers["referrer-policy"], "strict-origin-when-cross-origin", path);
      const policy = response.headers["content-security-policy"];
      assert.ok(policy, path);
      for (const directive of ["default-src 'self'", "script-src 'self'", "connect-src 'self'", "base-uri 'none'", "frame-ancestors 'none'"]) {
        assert.ok(policy.split("; ").includes(directive), `${path}: ${directive}`);
      }
    }
  });

  await t.test("HEAD preserves GET headers but never sends a body, including errors", async () => {
    for (const path of [...assets.map(([path]) => path), "/package.json", "/%FF"]) {
      const get = await sendRequest(server, path);
      const head = await sendRequest(server, path, "HEAD");
      assert.equal(head.status, get.status, path);
      for (const header of ["content-type", "x-content-type-options", "content-security-policy", "referrer-policy"]) {
        assert.equal(head.headers[header], get.headers[header], `${path}: ${header}`);
      }
      assert.equal(head.body.length, 0, path);
    }
  });

  await t.test("query strings and encoded public names still resolve to the correct asset", async () => {
    for (const path of ["/?q=%FF", "/index.html?cache=1", "/%69ndex.html", "/src/%63atalog.js?cache=1"]) {
      const response = await sendRequest(server, path);
      const file = path.startsWith("/src/") ? "src/catalog.js" : "index.html";
      assert.equal(response.status, 200, path);
      assert.deepEqual(response.body, await readFile(new URL(`../${file}`, import.meta.url)), path);
    }
  });

  await t.test("private files and encoded traversal cannot bypass the public allowlist", async () => {
    for (const path of [
      "/package.json", "/server.mjs", "/.git/config", "/test/catalog.test.js",
      "/docs/engineering.md", "/src/missing.js", "/src/app.js/extra",
      "/%2e%2e%2fpackage.json", "/src%2f..%2fpackage.json",
      "/%252e%252e%252fpackage.json", "/..%5cpackage.json", "/index.html%00",
    ]) {
      const response = await sendRequest(server, path);
      assert.equal(response.status, 404, path);
      assert.equal(response.headers["content-type"], "text/plain; charset=utf-8", path);
      assert.equal(response.body.toString(), "Not found", path);
    }
  });

  await t.test("malformed escapes return 400 without disrupting simultaneous valid requests", async () => {
    const paths = ["/%", "/%GG", "/%C3%28", "/%FF", "/src/catalog.js"];
    const responses = await Promise.all(paths.map((path) => sendRequest(server, path)));
    for (const [index, path] of paths.slice(0, -1).entries()) {
      assert.equal(responses[index].status, 400, path);
      assert.equal(responses[index].body.toString(), "Bad request", path);
    }
    assert.equal(responses.at(-1).status, 200);
    assert.deepEqual(responses.at(-1).body, await readFile(new URL("../src/catalog.js", import.meta.url)));
    assert.equal((await sendRequest(server, "/")).status, 200);
  });

  await t.test("unsupported methods return 405 before attempting URL or file handling", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      for (const path of ["/", "/package.json", "/%FF"]) {
        const response = await sendRequest(server, path, method);
        assert.equal(response.status, 405, `${method} ${path}`);
        assert.equal(response.headers.allow, "GET, HEAD", `${method} ${path}`);
        assert.equal(response.body.length, 0, `${method} ${path}`);
      }
    }
  });
});

test("missing public files return 404 and recover when the file becomes available", { timeout: 10000 }, async (t) => {
  // Isolate the filesystem failure without deleting or modifying repository assets.
  const directory = await mkdtemp(join(tmpdir(), "hushloom-server-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixtureUrl = pathToFileURL(join(directory, "server.mjs"));
  await copyFile(serverUrl, fixtureUrl);
  const server = await startServer(t, fixtureUrl);

  for (const method of ["GET", "HEAD"]) {
    const response = await sendRequest(server, "/", method);
    assert.equal(response.status, 404, method);
    assert.equal(response.headers["content-type"], "text/plain; charset=utf-8", method);
    assert.equal(response.body.toString(), method === "HEAD" ? "" : "Not found", method);
  }

  await writeFile(join(directory, "index.html"), "<h1>Recovered preview</h1>");
  const response = await sendRequest(server, "/");
  assert.equal(response.status, 200);
  assert.equal(response.body.toString(), "<h1>Recovered preview</h1>");
  assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
});
