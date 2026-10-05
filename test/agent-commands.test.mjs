import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { formatBrief, formatDone, formatTask } from "../cli/atelier.mjs";

const cli = resolve("cli/atelier.mjs");
const actor = "codex/test";
const brief = {
  title: "Small edit", decided: "Review t1 at abcdef01: Small edit.", summary: "Edited docs",
  evidence: ["Required checks at this revision: 1 passed on the agent's machine.", "Reviews at this revision: opus approved."],
  recommendation: { verdict: "review", reason: "A protected path needs approval." },
};
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("pure output keeps the brief and gate wording", () => {
  assert.equal(formatDone({ ready: true }), "Ready for the owner");
  assert.equal(formatDone({ ready: false, blockers: ["needs review", "check pending"] }), "needs review; check pending");
  assert.equal(formatTask({ title: "Edit", scope: ["docs/**"], dispatch: { note: "Keep examples" } }), "Edit\nScope: docs/**\nNote: Keep examples");
  const text = formatBrief("proj", "t1", brief, "https://atelier.test");
  for (const line of [brief.decided, ...brief.evidence, brief.recommendation.reason, "https://atelier.test/p/proj/t1"]) assert.ok(text.includes(line));
  assert.ok(!text.includes("\x1b"));
});

async function fixture(t, { failed = false, blockers = [], failStep, sandbox = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "atelier-agent-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source"), remote = join(root, "remote.git");
  execFileSync("git", ["init", "-q", "-b", "main", source]);
  git(source, "config", "user.name", "Test Owner");
  git(source, "config", "user.email", "owner@example.test");
  git(source, "commit", "-q", "--allow-empty", "-m", "Initial");
  execFileSync("git", ["clone", "-q", "--bare", source, remote]);
  const head = git(source, "rev-parse", "HEAD");
  const item = { id: "t1", title: brief.title, scope: ["docs/**"], owner: actor, state: "claimed", head, dispatch: { note: "Keep examples" } };
  const gate = { ready: !blockers.length, blockers };
  const posts = [], requests = [];
  const command = failed ? "exit 1" : "exit 0";
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const path = req.url;
    requests.push(path);
    if (req.method === "POST") posts.push({ path, body: JSON.parse(raw) });
    let data = { item, gate, policy: { checks: [command], sandboxOnly: sandbox } };
    if (path.endsWith("/claim")) data = { item, workspace: { token: "fake", remote, defaultBranch: "main", expiresAt: "tomorrow" } };
    if (path.endsWith("/push")) data = item;
    if (path.endsWith("/read-token") || path.endsWith("/baseline-token")) data = { remote, token: "fake", head, defaultBranch: "main" };
    if (path.endsWith("/brief")) data = brief;
    if (path.endsWith("/inbox")) data = [{ project: "proj", itemId: "t1", title: item.title }];
    if (path.endsWith("/sandbox")) data = { runId: "run" };
    if (path.endsWith("/sandbox/run")) data = { status: "done", recorded: true, request: { head }, results: [{ claim: command, passed: !failed, seconds: 1, outputTail: "check output" }] };
    const broken = failStep && path.endsWith(`/${failStep}`);
    res.writeHead(broken ? 503 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(broken ? { error: "unavailable", detail: "try later" } : data));
  });
  t.after(() => server.close());
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  writeFileSync(join(root, "config.json"), JSON.stringify({ projects: { proj: { path: source } } }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const workspace = join(root, "cache", "work", "proj", "t1");
  async function run(argv, cwd = source) {
    const child = spawn(process.execPath, [cli, ...argv], { cwd, env: { ...process.env, ATELIER_ACTOR: actor, ATELIER_CONFIG_DIR: root, ATELIER_CACHE: join(root, "cache"), ATELIER_TOKEN: "fake", ATELIER_SERVER: origin } });
    let output = ""; child.stdout.on("data", (s) => output += s); child.stderr.on("data", (s) => output += s);
    const status = await new Promise((done) => child.on("close", done));
    return { status, output };
  }
  return { run, workspace, posts, requests, origin };
}

test("start claims and prepares a clone with task instructions", async (t) => {
  const f = await fixture(t);
  const r = await f.run(["start", "t1", "--as", actor]);
  assert.equal(r.status, 0, r.output);
  for (const text of [f.workspace, "Small edit", "Scope: docs/**", "Note: Keep examples"]) assert.ok(r.output.includes(text));
  for (const [key, value] of [["project", "proj"], ["item", "t1"], ["actor", actor], ["branch", "main"]]) assert.equal(git(f.workspace, "config", `atelier.${key}`), value);
  assert.equal(git(f.workspace, "config", "user.email"), "owner@example.test");
  assert.equal(f.posts.filter((p) => p.path.endsWith("/claim")).length, 1);
});

for (const sandbox of [false, true]) test(`done stops at a failed ${sandbox ? "sandbox" : "local"} check`, async (t) => {
  const f = await fixture(t, { failed: true, sandbox });
  assert.equal((await f.run(["start", "t1"])).status, 0);
  const r = await f.run(["done", "Edited docs"], f.workspace);
  assert.equal(r.status, 2, r.output);
  assert.match(r.output, /check failed: required checks failed/);
  assert.ok(f.posts.some((p) => p.path.endsWith("/push")));
  assert.ok(!f.posts.some((p) => p.path.endsWith("/submit")));
});

for (const blockers of [[], ["protected paths need an independent approval"]]) test(`done ends with the gate result: ${blockers.length ? "blocked" : "ready"}`, async (t) => {
  const f = await fixture(t, { blockers });
  await f.run(["start", "t1"]);
  const r = await f.run(["done", "Edited docs"], f.workspace);
  assert.equal(r.status, 0, r.output);
  assert.equal(r.output.trim().split("\n").at(-1), blockers[0] ?? "Ready for the owner");
  assert.deepEqual(f.posts.find((p) => p.path.endsWith("/submit")).body, { summary: "Edited docs" });
});

for (const failStep of ["push", "submit"]) test(`done names a failed ${failStep} and keeps the infrastructure exit code`, async (t) => {
  const f = await fixture(t, { failStep });
  await f.run(["start", "t1"]);
  const r = await f.run(["done", "Edited docs"], f.workspace);
  assert.equal(r.status, 4, r.output);
  assert.ok(r.output.includes(`${failStep} failed: unavailable: try later`));
  if (failStep === "push") assert.ok(!f.posts.some((p) => /\/(evidence|submit)$/.test(p.path)));
});

test("inbox and show print the owner brief and preserve JSON output", async (t) => {
  const f = await fixture(t);
  for (const argv of [["inbox"], ["show", "t1"]]) {
    const r = await f.run(argv);
    assert.equal(r.status, 0, r.output);
    assert.equal(r.output.trim(), formatBrief("proj", "t1", brief, f.origin));
    const json = await f.run([...argv, "--json"]);
    assert.equal(json.status, 0, json.output);
    assert.deepEqual(JSON.parse(json.output), argv[0] === "show" ? brief : [{ project: "proj", itemId: "t1", title: brief.title }]);
  }
});

test("finish keeps its existing output and exit codes", async (t) => {
  for (const failed of [false, true]) {
    const f = await fixture(t, { failed });
    await f.run(["start", "t1"]);
    const r = await f.run(["finish"], f.workspace);
    assert.equal(r.status, failed ? 2 : 0, r.output);
    assert.ok(!r.output.includes("check failed:"));
    assert.ok(!r.output.includes("Ready for the owner"));
    if (!failed) assert.match(r.output, /t1 submitted and ready for/);
  }
});

test("done refuses uncommitted work before pushing", async (t) => {
  const f = await fixture(t);
  await f.run(["start", "t1"]);
  writeFileSync(join(f.workspace, "unfinished.txt"), "still editing");
  const r = await f.run(["done", "Edited docs"], f.workspace);
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /prepare failed: commit your changes/);
  assert.ok(!f.posts.some((p) => /\/(push|submit)$/.test(p.path)));
});
