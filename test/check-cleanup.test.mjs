import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// t212: `atelier check` removes its clean clone once the checks are recorded.
// A clone that cannot be removed is a warning naming the folder, and the
// command still ends with the checks' own result; a check that leaves a
// process behind has it ended before the clone is removed. These run the
// CLI against a stand-in server.

const cli = resolve("cli/atelier.mjs");
const actor = "codex/test";
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function fixture(t, check) {
  const root = mkdtempSync(join(tmpdir(), "atelier-check-cleanup-"));
  // A folder the check made unwritable is made writable again first.
  t.after(() => { try { execFileSync("chmod", ["-R", "u+w", root]); } catch { /* Nothing to restore. */ } rmSync(root, { recursive: true, force: true }); });
  const source = join(root, "source"), remote = join(root, "remote.git"), cache = join(root, "cache");
  const command = check(root);
  execFileSync("git", ["init", "-q", "-b", "main", source]);
  git(source, "-c", "user.name=T", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "Initial");
  execFileSync("git", ["clone", "-q", "--bare", source, remote]);
  const head = git(source, "rev-parse", "HEAD");
  const item = { id: "t1", title: "Edit", scope: [], owner: actor, state: "claimed", head };
  const evidence = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const path = req.url;
    let data = { item, gate: { ready: false, blockers: [] }, policy: { checks: [command], sandboxOnly: false } };
    if (path.endsWith("/read-token")) data = { remote, token: "read", head, defaultBranch: "main" };
    if (path.endsWith("/base-token")) data = { remote, token: "base", head, defaultBranch: "main" };
    if (path.endsWith("/evidence")) evidence.push(JSON.parse(raw));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  });
  t.after(() => server.close());
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  writeFileSync(join(root, "config.json"), JSON.stringify({ projects: { proj: { path: source } } }));
  async function run() {
    const env = { ...process.env, ATELIER_ACTOR: actor, ATELIER_CONFIG_DIR: root, ATELIER_CACHE: cache, ATELIER_TOKEN: "api",
      ATELIER_SERVER: `http://127.0.0.1:${server.address().port}` };
    const child = spawn(process.execPath, [cli, "check", "t1", "--project", "proj"], { cwd: root, env });
    let stdout = "", stderr = ""; child.stdout.on("data", (s) => stdout += s); child.stderr.on("data", (s) => stderr += s);
    const status = await new Promise((done) => child.on("close", done));
    return { status, stdout, stderr };
  }
  const clones = () => existsSync(join(cache, "checks")) ? readdirSync(join(cache, "checks")).filter((n) => /^run-[a-zA-Z0-9]+$/.test(n)) : [];
  return { root, cache, evidence, run, clones };
}

for (const exit of [0, 1]) test(`a clone that cannot be removed is a warning, and a ${exit ? "failing" : "passing"} check keeps its own result`, async (t) => {
  // The check leaves a file in a folder it may not write, so removing the
  // clone fails (ENOTEMPTY on macOS) however often it is tried.
  const f = await fixture(t, () => `mkdir locked && touch locked/f && chmod 500 locked; exit ${exit}`);
  const r = await f.run();
  assert.equal(r.status, exit ? 2 : 0, r.stdout + r.stderr);
  assert.match(r.stdout, exit ? /^FAIL {2}/m : /^PASS {2}/m);
  assert.equal(f.evidence.length, 1);
  assert.equal(f.evidence[0].passed, !exit);
  const [left] = f.clones();
  assert.ok(left, "the clone is still there");
  assert.ok(r.stderr.includes(`atelier: warning: the check's clone ${join(f.cache, "checks", left)} could not be removed`), r.stderr);
  assert.doesNotMatch(r.stderr, /\n\s+at |Node\.js v/, "no stack is printed");
});

test("a process the check leaves behind is ended, and the clone is removed", { timeout: 60_000 }, async (t) => {
  // A loop in the background, still writing into the clone after the check
  // has exited, as a test runner's worker or a watcher can. Its output goes
  // elsewhere, so the check's own output closes when the check exits.
  const f = await fixture(t, (root) => `(for i in $(seq 1 600); do date > "$PWD/bg-$i.txt"; sleep 0.05; done) >/dev/null 2>&1 & echo $! > '${join(root, "bg.pid")}'; exit 0`);
  t.after(() => { try { process.kill(Number(readFileSync(join(f.root, "bg.pid"), "utf8")), "SIGKILL"); } catch { /* It has ended. */ } });
  const r = await f.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^PASS {2}/m);
  const pid = Number(readFileSync(join(f.root, "bg.pid"), "utf8"));
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "the background process has ended");
  assert.deepEqual(f.clones(), [], "the clone is removed");
  assert.doesNotMatch(r.stderr, /warning|\n\s+at /, r.stderr);
});
