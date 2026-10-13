// t568: test/git-credentials.test.mjs failed in landing checks with
// "server request failed: fetch failed" (read ECONNRESET), exit 4. Traced:
// `atelier start` ran git clone, config and ls-remote with spawnSync for over
// 6 s under the full suite's load; the fixture's Node server closed the
// claim's idle keep-alive connection at 6 s (keepAliveTimeout 5 s plus its
// 1 s buffer); the CLI's next request, GET /api/projects/proj, went out in
// the same turn the last spawnSync returned, on that pooled connection,
// before Node had run fetch's idle-expiry timer or read the FIN, and the
// server's kernel answered it with a reset. serverFetch (cli/server-fetch.mjs)
// lets the event loop catch up first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const module = pathToFileURL(resolve("cli/server-fetch.mjs")).href;

test("serverFetch after a stall longer than the server's keep-alive takes a fresh connection, not the closed one", async (t) => {
  // Keep-Alive: timeout=3, which fetch honours, and a close 4 s after the
  // last response; a 3 s hint is the shortest for which fetch keeps the
  // connection pooled at all.
  const closed = [];
  let requests = 0, closedBeforeLast = null;
  const server = createServer((req, res) => {
    if (++requests === 4) closedBeforeLast = closed.length;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  server.keepAliveTimeout = 3000;
  server.keepAliveTimeoutBuffer = 1000;
  server.on("connection", (socket) => socket.on("close", () => closed.push(socket.remotePort)));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/api/version`;
  // The client blocks its event loop as spawnSync does, 1.5 s past the
  // server's close, so the close lands while it is blocked however loaded
  // the host is. Three requests first leave connections in fetch's pool.
  const code = `import { serverFetch } from ${JSON.stringify(module)};
const sab = new Int32Array(new SharedArrayBuffer(4));
for (let i = 0; i < 3; i++) await (await serverFetch(${JSON.stringify(url)})).text();
Atomics.wait(sab, 0, 0, 5500);
try { const res = await serverFetch(${JSON.stringify(url)}); console.log(res.status); }
catch (error) { console.log(\`\${error.message}: \${error.cause?.code ?? error.cause?.message}\`); }`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  let output = "";
  child.stdout.on("data", (s) => output += s);
  child.stderr.on("data", (s) => output += s);
  await new Promise((done) => child.on("close", done));
  assert.ok(closedBeforeLast >= 1, `the server closed a pooled connection during the stall (closed before the last request: ${closedBeforeLast})`);
  assert.equal(output.trim(), "200", "the request after the stall is answered");
});
