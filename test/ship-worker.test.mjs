import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { deployWorker, sourceHead, verifyWorker, VERSION_URL } from "../scripts/ship-worker.mjs";

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "atelier-worker-source-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test" } }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(cwd, "source.txt"), "source\n");
  git("add", "."); git("commit", "-qm", "fixture");
  const head = git("rev-parse", "HEAD");
  return { cwd, env: { ATELIER_SHIP_HEAD: head }, head, git };
}

test("t182 canonical deployment binds the captured source and preserves vars", (t) => {
  const f = fixture(t); let calls = 0;
  assert.equal(deployWorker({ ...f, run(command, args, options) {
    calls++;
    assert.equal(command, process.platform === "win32" ? "npx.cmd" : "npx");
    assert.deepEqual(args, ["wrangler", "deploy", "--env", "", "--keep-vars", "--var", `DEPLOYED_MAIN:${f.head}`]);
    assert.equal(options.cwd, f.cwd); assert.equal(options.env.ATELIER_SHIP_HEAD, f.head);
    return { status: 0 };
  } }), f.head);
  assert.equal(calls, 1);
});

test("a named environment deploys with that --env, and a bad name never invokes deployment (t344)", (t) => {
  const f = fixture(t); const seen = [];
  assert.equal(deployWorker({ ...f, environment: "staging", run(command, args) { seen.push(args); return { status: 0 }; } }), f.head);
  assert.deepEqual(seen, [["wrangler", "deploy", "--env", "staging", "--keep-vars", "--var", `DEPLOYED_MAIN:${f.head}`]]);
  for (const environment of ["Staging", "-x", "a b", "--env", null]) assert.throws(() => deployWorker({ ...f, environment, run() { seen.push(environment); return { status: 0 }; } }), /environment name/);
  assert.equal(seen.length, 1);
});

for (const [args, usage] of [[["deploy", "--env"], true], [["deploy", "--env", ""], true], [["deploy", "staging"], true], [["verify", "--env", "staging"], true], [["deploy", "--env", "staging"], false]]) test(`ship-worker.mjs ${args.join(" ") || "''"} ${usage ? "is refused with its usage" : "reaches the source check"} (t344)`, (t) => {
  const f = fixture(t);
  const r = spawnSync(process.execPath, [resolve("scripts/ship-worker.mjs"), ...args], { cwd: f.cwd, env: { PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, usage ? /^Usage: / : /ATELIER_SHIP_HEAD/);
});

test("missing, invalid, stale and dirty source bindings never invoke deployment", (t) => {
  const f = fixture(t); let calls = 0; const run = () => { calls++; return { status: 0 }; };
  for (const head of [undefined, "", "bad", "a".repeat(40)]) assert.throws(() => deployWorker({ ...f, env: { ATELIER_SHIP_HEAD: head }, run }));
  writeFileSync(join(f.cwd, "untracked.txt"), "untracked");
  assert.throws(() => deployWorker({ ...f, run }), /uncommitted/);
  rmSync(join(f.cwd, "untracked.txt"));
  writeFileSync(join(f.cwd, "source.txt"), "changed");
  assert.throws(() => deployWorker({ ...f, run }), /uncommitted/);
  f.git("add", "."); f.git("commit", "-qm", "moved");
  assert.throws(() => deployWorker({ ...f, run }), /moved/);
  assert.equal(calls, 0);
});

test("deployment failure and a source change during deployment cannot report success", (t) => {
  const f = fixture(t);
  assert.throws(() => deployWorker({ ...f, run: () => ({ status: 1 }) }), /failed/);
  assert.throws(() => deployWorker({ ...f, run: () => ({ status: null, signal: "SIGTERM" }) }), /SIGTERM/);
  assert.throws(() => deployWorker({ ...f, run: () => ({ error: new Error("spawn failed") }) }), /spawn failed/);
  assert.throws(() => deployWorker({ ...f, run: () => { writeFileSync(join(f.cwd, "source.txt"), "changed"); return { status: 0 }; } }), /uncommitted/);
});

// A clock that sleeping advances, so retries cost no real time.
function fakeClock() {
  let time = 0; const sleeps = [];
  return { now: () => time, sleep: async (ms) => { sleeps.push(ms); time += ms; }, sleeps };
}

test("verification retries an old commit and passes once the new one is served", async (t) => {
  const f = fixture(t); const clock = fakeClock(); let calls = 0;
  const old = "a".repeat(40);
  assert.equal(await verifyWorker({ ...f, ...clock, fetchImpl: async () => Response.json({ commit: ++calls <= 2 ? old : f.head }) }), f.head);
  assert.equal(calls, 3);
  assert.deepEqual(clock.sleeps, [1000, 2000]);
});

test("verification fails after the window when the commit never changes, naming both commits", async (t) => {
  const f = fixture(t); const clock = fakeClock(); const old = "a".repeat(40);
  await assert.rejects(verifyWorker({ ...f, ...clock, fetchImpl: async () => Response.json({ commit: old }) }),
    (error) => error.message.includes(old) && error.message.includes(f.head) && /60 s/.test(error.message));
  assert.equal(clock.now(), 60_000);
});

test("verification does not retry an HTTP error", async (t) => {
  const f = fixture(t); const clock = fakeClock(); let calls = 0;
  await assert.rejects(verifyWorker({ ...f, ...clock, fetchImpl: async () => { calls++; return Response.json({}, { status: 503 }); } }), /503/);
  assert.equal(calls, 1);
});

test("verification matches deployed commit, independently of ledger main, without credentials or redirects", async (t) => {
  const f = fixture(t);
  assert.equal(await verifyWorker({ ...f, fetchImpl: async (url, options) => {
    assert.equal(url, VERSION_URL); assert.equal(url, "https://atelier.zone/api/version");
    assert.equal(options.redirect, "error"); assert.equal(options.cache, "no-store"); assert.ok(options.signal);
    assert.equal(options.headers, undefined);
    return Response.json({ commit: f.head, main: "a".repeat(40) });
  } }), f.head);
});

for (const [name, response] of [
  ["non-200", () => Response.json({}, { status: 503 })],
  ["redirect", () => Response.redirect("https://elsewhere.example/")],
  ["missing commit", () => Response.json({})],
  ["null commit", () => Response.json({ commit: null })],
  ["mismatched commit with matching ledger main", f => Response.json({ commit: "a".repeat(40), main: f.head })],
  ["malformed JSON", () => new Response("not JSON")],
  ["array", () => Response.json([])],
]) test(`verification refuses ${name}`, async (t) => {
  const f = fixture(t);
  await assert.rejects(verifyWorker({ ...f, ...fakeClock(), fetchImpl: async () => response(f) }));
});

test("verification refuses unavailable service and source movement during its request", async (t) => {
  const f = fixture(t);
  await assert.rejects(verifyWorker({ ...f, fetchImpl: async () => { throw new Error("unreachable"); } }), /unreachable/);
  await assert.rejects(verifyWorker({ ...f, fetchImpl: async () => {
    writeFileSync(join(f.cwd, "source.txt"), "changed"); f.git("add", "."); f.git("commit", "-qm", "moved");
    return Response.json({ commit: f.head });
  } }), /moved/);
});

test("verification refuses an absent source binding before making a request", async (t) => {
  const f = fixture(t); let calls = 0;
  await assert.rejects(verifyWorker({ ...f, env: {}, fetchImpl: async () => { calls++; return Response.json({ commit: f.head }); } }), /ATELIER_SHIP_HEAD/);
  assert.equal(calls, 0); assert.equal(sourceHead(f), f.head);
});


test("t182 real Node fetch accepts verification options and refuses HTTP redirects", async (t) => {
  const f = fixture(t); let redirect = false; let targetRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/redirect-target") targetRequests++;
    if (redirect && request.url === "/api/version") {
      response.writeHead(302, { location: "/redirect-target" }); response.end();
    } else {
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ commit: f.head }));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const fetchImpl = (url, options) => {
    assert.equal(url, VERSION_URL);
    return fetch(`http://127.0.0.1:${server.address().port}/api/version`, options);
  };
  assert.equal(await verifyWorker({ ...f, fetchImpl }), f.head);
  redirect = true;
  await assert.rejects(verifyWorker({ ...f, fetchImpl }), /fetch failed/);
  assert.equal(targetRequests, 0);
});
