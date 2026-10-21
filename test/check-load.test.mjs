import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Retired load controls must not prevent applicable local commands from running.

const cli = resolve("cli/atelier.mjs");
const actor = "codex/test";

async function fixture(t, checks = ["exit 0"], isolated = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "atelier-check-load-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let executable = cli;
  if (isolated) {
    cpSync(resolve("package.json"), join(root, "package.json"));
    cpSync(resolve("cli"), join(root, "cli"), { recursive: true });
    cpSync(resolve("src"), join(root, "src"), { recursive: true });
    symlinkSync(resolve("node_modules"), join(root, "node_modules"));
    const load = join(root, "cli/load.mjs");
    writeFileSync(load, readFileSync(load, "utf8").replace('"/tmp/atelier-test-slots-v1.sqlite"', JSON.stringify(join(root, "pool.sqlite"))));
    executable = join(root, "cli/atelier.mjs");
  }
  const source = join(root, "source"), remote = join(root, "remote.git"), cache = join(root, "cache");
  execFileSync("git", ["init", "-q", "-b", "main", source]);
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git(source, "-c", "user.name=T", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "Initial");
  execFileSync("git", ["clone", "-q", "--bare", source, remote]);
  const head = git(source, "rev-parse", "HEAD");
  const item = { id: "t1", title: "Edit", scope: [], owner: actor, state: "claimed", head };
  const evidence = [];
  let onEvidence;
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    let data = { item, gate: { ready: false, blockers: [] }, policy: { checks } };
    if (req.url.endsWith("/read-token")) data = { remote, token: "read", head, defaultBranch: "main" };
    if (req.url.endsWith("/base-token")) data = { remote, token: "base", head, defaultBranch: "main" };
    if (req.url.endsWith("/evidence")) { evidence.push(JSON.parse(raw)); await onEvidence?.(evidence.length); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  });
  t.after(() => server.close());
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  writeFileSync(join(root, "config.json"), JSON.stringify({ projects: { proj: { path: source } } }));
  async function run(envExtra = {}) {
    const env = { ...process.env, ATELIER_ACTOR: actor, ATELIER_CONFIG_DIR: root, ATELIER_CACHE: cache, ATELIER_TOKEN: "api",
      ATELIER_SERVER: `http://127.0.0.1:${server.address().port}`, ...envExtra };
    if (isolated) delete env.ATELIER_TEST_LEASE;
    const child = spawn(process.execPath, [executable, "check", "t1", "--project", "proj"], { cwd: root, env });
    let stdout = "", stderr = ""; child.stdout.on("data", (s) => stdout += s); child.stderr.on("data", (s) => stderr += s);
    const status = await new Promise((done) => child.on("close", done));
    return { status, stdout, stderr };
  }
  return { run, evidence, root, onEvidence: (fn) => { onEvidence = fn; } };
}

test("retired load settings do not hold local checks", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await fixture(t, ["exit 0", "exit 0"]);
  const r = await f.run({ ATELIER_LOAD_LIMIT: "1", ATELIER_LOAD: "999999" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(f.evidence.length, 2);
  assert.ok(f.evidence.every((e) => e.passed));
  assert.doesNotMatch(r.stderr, /waiting for it to fall/);
});


test("release check keeps its slot across evidence posting and clears the final reservation", { timeout: 30000 }, async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await fixture(t, ["echo first", "echo second"], true);
  let ordinary, ordinaryDone, output = "", enteredDuringGap = false;
  f.onEvidence(async (count) => {
    if (count !== 1) return;
    const env = { ...process.env, ATELIER_TEST_SLOTS: "1" }; delete env.ATELIER_TEST_LEASE;
    ordinary = spawn(process.execPath, [join(f.root, "cli/load.mjs"), "--", process.execPath, "-e", "console.log('ordinary admitted')"], { env });
    ordinary.stdout.on("data", (s) => output += s);
    ordinary.stderr.resume();
    ordinaryDone = new Promise((resolve) => ordinary.on("close", resolve));
    await new Promise((resolve) => setTimeout(resolve, 600));
    enteredDuringGap = output.length > 0;
  });
  t.after(() => ordinary?.kill("SIGTERM"));
  const result = await f.run({ ATELIER_TEST_PRIORITY: "release", ATELIER_TEST_SLOTS: "1" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.evidence.length, 2);
  assert.equal(enteredDuringGap, false, "ordinary must not enter during the evidence-posting gap");
  assert.equal(await ordinaryDone, 0);
  assert.match(output, /ordinary admitted/);
});
