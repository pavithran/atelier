import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { completeBinding, preparationBinding, receiptBinding, reusableResult } from "../src/checks.ts";

// atelier check reuses a passing Observed result recorded under the same
// bindings (t232). The unit tests read the pure rules; the CLI tests run the
// real command against a fake ledger on 127.0.0.1 with dummy credentials.

const sha = (c) => c.repeat(40);
const binding = (over = {}) => ({ project: "proj", task: "t1", head: sha("a"), base: sha("b"), mainHead: null, mode: "ordinary", where: "runner", command: "npm test", preparation: "none", ...over });
const row = (id, passed, reuse = binding(), over = {}) => ({ id, grade: "observed", passed, reuse, ...over });

test("a passing result under the same bindings is reused, and each changed binding is not", () => {
  assert.equal(reusableResult([row(1, true)], binding())?.id, 1);
  const changed = { project: "other", task: "t2", head: sha("c"), base: sha("d"), command: "npm run x", preparation: "{}" };
  for (const [key, value] of Object.entries(changed)) assert.equal(reusableResult([row(1, true)], binding({ [key]: value })), null, key);
  assert.equal(reusableResult([row(1, true)], binding({ mode: "merged", mainHead: sha("e") })), null);
  assert.equal(reusableResult([row(1, true, binding({ mode: "merged", mainHead: sha("e") }))], binding({ mode: "merged", mainHead: sha("f") })), null);
  assert.equal(reusableResult([row(1, true, binding({ mode: "merged", mainHead: sha("e") }))], binding()), null);
});

test("a receipt missing any binding is never reused", () => {
  for (const key of Object.keys(binding())) {
    const { [key]: _gone, ...rest } = binding();
    assert.equal(completeBinding(rest), false, key);
    assert.equal(reusableResult([row(1, true, rest)], binding()), null, key);
  }
  assert.equal(reusableResult([row(1, true, binding({ base: "" }))], binding()), null);
  assert.equal(reusableResult([row(1, true, undefined, { reuse: undefined })], binding()), null);
  assert.equal(reusableResult([row(1, true, binding({ mode: "merged", mainHead: null }))], binding({ mode: "merged", mainHead: null })), null);
});

test("reported and legacy evidence is not reused", () => {
  assert.equal(reusableResult([row(1, true, binding(), { grade: "reported" })], binding()), null);
  assert.equal(reusableResult([{ id: 1, grade: "observed", passed: true }], binding()), null);
  assert.equal(reusableResult([row(1, true, binding(), { notApplicable: true })], binding()), null);
});

test("only the latest matching result by evidence ID counts: a later failure forces a run, a later pass answers one", () => {
  assert.equal(reusableResult([row(1, true), row(2, false)], binding()), null);
  assert.equal(reusableResult([row(2, false), row(1, true)], binding()), null);
  assert.equal(reusableResult([row(1, false), row(2, true)], binding())?.id, 2);
  // A failure under other bindings does not count against this one.
  assert.equal(reusableResult([row(1, true), row(2, false, binding({ head: sha("c") }))], binding())?.id, 1);
});

test("the Worker joins its own readings to the base and preparation sent", () => {
  const known = { project: "proj", task: "t1", head: sha("a"), mainHead: sha("e"), merged: false, command: "npm test" };
  const sent = { base: sha("b"), preparation: "none" };
  assert.deepEqual(receiptBinding(sent, known), binding());
  assert.deepEqual(receiptBinding(sent, { ...known, merged: true }), binding({ mode: "merged", mainHead: sha("e") }));
  assert.equal(receiptBinding({ base: sha("b") }, known), null);
  assert.equal(receiptBinding({ base: "main", preparation: "none" }, known), null);
  assert.equal(receiptBinding(undefined, known), null);
  assert.equal(preparationBinding(undefined), "none");
  assert.match(preparationBinding({ command: "npm ci", inputs: ["package.json"], outputs: ["node_modules"] }), /npm ci/);
});

const cli = resolve("cli/atelier.mjs");
const actor = "codex/test";
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).trim();

async function fixture(t, check) {
  const root = mkdtempSync(join(tmpdir(), "atelier-reuse-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source"), remote = join(root, "remote.git");
  execFileSync("git", ["init", "-q", "-b", "main", source]);
  git(source, "-c", "user.name=T", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "Initial");
  execFileSync("git", ["clone", "-q", "--bare", source, remote]);
  const head = git(source, "rev-parse", "HEAD");
  const item = { id: "t1", title: "Edit", scope: [], owner: actor, state: "claimed", head };
  const evidence = [], posts = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    let data = { item, gate: { ready: false, blockers: [] }, policy: { checks: Array.isArray(check) ? check : [check], protected: [] }, evidence, reviews: [], events: [] };
    if (req.url.endsWith("/read-token")) data = { remote, token: "read", head, defaultBranch: "main" };
    if (req.url.endsWith("/base-token")) data = { remote, token: "base", head, defaultBranch: "main" };
    if (req.method === "POST" && req.url.endsWith("/evidence")) {
      const body = JSON.parse(raw);
      posts.push(body);
      // What the Worker stores: its own readings and the base sent.
      evidence.push({ id: evidence.length + 1, grade: "observed", passed: body.passed, claim: body.claim, head: body.head, reuse: receiptBinding(body.reuse, { project: "proj", task: "t1", head: body.head, mainHead: body.mainHead ?? null, merged: body.merged === true, command: body.claim }) ?? undefined });
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  });
  t.after(() => server.close());
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  writeFileSync(join(root, "config.json"), JSON.stringify({ projects: { proj: { path: source } } }));
  async function run(...extra) {
    const child = spawn(process.execPath, [cli, "check", "t1", "--project", "proj", ...extra], { cwd: source, env: { ...process.env, ATELIER_ACTOR: actor, ATELIER_CONFIG_DIR: root, ATELIER_CACHE: join(root, "cache"), ATELIER_TOKEN: "fake", ATELIER_SERVER: `http://127.0.0.1:${server.address().port}`, GIT_CONFIG_NOSYSTEM: "1" } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (s) => stdout += s);
    child.stderr.on("data", (s) => stderr += s);
    const status = await new Promise((done) => child.on("close", done));
    return { status, stdout, stderr };
  }
  return { run, evidence, posts, head };
}

test("check runs a command once, then names the passing result instead of running it again", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await fixture(t, "exit 0");
  const first = await f.run();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(f.posts.length, 1);
  assert.ok(f.evidence[0].reuse, "the first receipt is complete");
  const second = await f.run();
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /^PASS  exit 0  @ \w+  \(reused evidence #1;/m);
  assert.equal(f.posts.length, 1, "no replacement pass is appended");
  const fresh = await f.run("--fresh");
  assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
  assert.doesNotMatch(fresh.stdout, /reused/);
  assert.equal(f.posts.length, 2);
});

test("a merged run does not reuse an ordinary result, and a later matching failure forces a run", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await fixture(t, "exit 0");
  await f.run();
  const merged = await f.run("--merged");
  assert.equal(merged.status, 0, merged.stdout + merged.stderr);
  assert.doesNotMatch(merged.stdout, /reused/);
  assert.equal(f.posts.length, 2);
  // A later failure under the ordinary bindings: the next run is not answered by the earlier pass.
  f.evidence.push({ ...f.evidence[0], id: 3, passed: false });
  const again = await f.run();
  assert.doesNotMatch(again.stdout, /reused/);
  assert.equal(f.posts.length, 3);
});

test("with several commands, only the one with a passing result is reused", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await fixture(t, ["exit 0", "true"]);
  await f.run("--", "exit 0");
  const r = await f.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^PASS  exit 0  @ \w+  \(reused evidence #1;/m);
  assert.match(r.stdout, /^PASS  true  @ \w+$/m);
  assert.deepEqual(f.posts.map((p) => p.claim), ["exit 0", "true"]);
});

test("legacy evidence without bindings does not answer a check", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await fixture(t, "exit 0");
  f.evidence.push({ id: 1, grade: "observed", passed: true, claim: "exit 0", head: f.head });
  const r = await f.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /reused/);
  assert.equal(f.posts.length, 1);
});
