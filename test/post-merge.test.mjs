import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parsePostMerge, reservePostMerge, preparePostMerge, startAttempt, finishAttempt, recoverPostMerge, expireAttempt, redactedOutput } from "../src/post-merge.ts";
import { changeClass } from "../src/rules.ts";
import { postMergeArgs } from "../cli/post-merge-policy.mjs";
import { runLand } from "../cli/land.mjs";
import { ROUTE_LEVEL, SERVER_CAPABILITIES } from "../src/route-level.ts";
import { publishPinned, executePostMerge } from "../cli/post-merge.mjs";
const at = "2026-10-10T12:00:00Z", a = "a".repeat(40), b = "b".repeat(40);
const step = (name, more = {}) => ({ name, command: "npm test", class: "check", when: "always", protect: ["package.json", "scripts/**"], timeoutMs: 1000, ...more });
const policy = steps => parsePostMerge({ version: 1, steps, approval: { reason: "owner authorizes these commands" } }, "owner", at);
const run = steps => { const r = reservePostMerge(policy(steps), ["t1"], a, "run-1", at); r.after = b; return r; };

test("init preserves omission, clears explicitly/reset, quotes NAME=CMD and rejects ambiguous policy", () => {
  assert.equal(postMergeArgs({}), undefined);
  assert.equal(postMergeArgs({ reset: true }), null);
  assert.equal(postMergeArgs({ multi: { "post-merge": [""] } }), null);
  const p = postMergeArgs({ multi: { "post-merge": ["verify=X=1 npm test"], "post-merge-options": ['verify={"class":"check","when":{"paths":["src/**"]},"protect":["package.json"]}'] }, "post-merge-approval": "approved" });
  assert.equal(p.steps[0].command, "X=1 npm test");
  assert.equal(p.approval.by, "owner");
  for (const steps of [[step("x"), step("x")], [step("x", { when: undefined })], [step("x", { class: undefined })], [step("x", { protect: [] })], [step("x", { command: "npm run deploy" })], [step("x", { class: "deploy", command: "echo deploy" })]]) assert.throws(() => policy(steps));
  assert.throws(() => postMergeArgs({ multi: { "post-merge": ["x=npm test"] } }));
  assert.equal(changeClass(["scripts/transitive-import.mjs"], { checks: [], protected: [], postMerge: p }), "protected");
});

test("net paths match deleted and renamed names with existing folded glob semantics; unknown diff blocks", () => {
  const r = run([step("deleted", { when: { paths: ["old/**"] } }), step("renamed", { when: { paths: ["NEW/**"] } }), step("absent", { when: { paths: ["other/**"] } })]);
  assert.throws(() => startAttempt(r, "early", at));
  preparePostMerge(r, ["old/x", "new/x"]);
  assert.deepEqual(r.steps.map(s => s.outcome), ["pending", "pending", "not_applicable"]);
});

test("ordered persisted attempts, failure, owner waiver and replay fencing", () => {
  const r = run([step("first"), step("second"), step("third")]);
  preparePostMerge(r, []);
  startAttempt(r, "1", at);
  assert.throws(() => startAttempt(r, "racer", at));
  finishAttempt(r, "1", true, "TOKEN=secret", at);
  assert.equal(r.steps[0].attempts[0].output.includes("secret"), false);
  startAttempt(r, "2", at);
  finishAttempt(r, "2", false, "password", at);
  assert.throws(() => startAttempt(r, "3", at));
  recoverPostMerge(r, "retry", "fixed environment", "owner", at);
  startAttempt(r, "3", at);
  assert.equal(r.steps[0].attempts.length, 1);
  assert.throws(() => finishAttempt(r, "2", true, "", at));
  finishAttempt(r, "3", false, "", at);
  assert.throws(() => recoverPostMerge(r, "skip", "", "owner", at));
  recoverPostMerge(r, "skip", "waived", "owner", at);
  startAttempt(r, "4", at); finishAttempt(r, "4", true, "", at);
  assert.equal(r.state, "complete");
  assert.equal(r.steps[1].attempts.at(-1).outcome, "waived");
});

test("executor death and expiry become uncertain and require explicit reconciliation", () => {
  const r = run([step("external", { class: "deploy", command: "npm run deploy", versionUrl: "https://example.test/api/version" })]);
  preparePostMerge(r, []); startAttempt(r, "lost", at);
  expireAttempt(r, Date.parse(at) + 3600000);
  assert.equal(r.state, "uncertain");
  for (const action of ["retry", "skip"]) assert.throws(() => recoverPostMerge(r, action, "try again", "owner", at));
  recoverPostMerge(r, "reconcile", "executor stopped, no deployment observed", "owner", at, "no-effect");
  assert.throws(() => finishAttempt(r, "lost", true, "", at));
  recoverPostMerge(r, "retry", "try again", "owner", at); startAttempt(r, "next", at);
  assert.throws(() => finishAttempt(r, "next", true, "", at));
  finishAttempt(r, "next", true, "", at, { commit: b, routeLevel: 21 }, "passed");
  assert.equal(r.state, "complete");
});

test("reserved waivers require a recorded merge, preserve unknown paths and survive preparation", () => {
  const r = reservePostMerge(policy([step("first", { when: { paths: ["src/**"] } }), step("second")]), ["t1"], a, "reserved", at);
  assert.throws(() => recoverPostMerge(r, "skip", "waive", "owner", at));
  r.after = b;
  for (const action of ["retry", "reconcile"]) assert.throws(() => recoverPostMerge(r, action, "waive", "owner", at));
  assert.throws(() => recoverPostMerge(r, "skip", "", "owner", at));
  recoverPostMerge(r, "skip", "history unavailable", "owner", at);
  assert.equal(r.state, "reserved");
  assert.equal(r.paths, null);
  assert.throws(() => startAttempt(r, "early", at));
  preparePostMerge(r, []);
  assert.equal(r.steps[0].outcome, "waived");
  assert.equal(r.state, "pending");
  startAttempt(r, "second", at);
  finishAttempt(r, "second", true, "secret".repeat(10000), at);
  assert.ok(r.steps[1].attempts[0].output.length <= 8192);
  assert.equal(r.state, "complete");
});

test("CLI can waive an unprepared step without attempting the unavailable diff again", async () => {
  const r = run([step("first"), step("second")]);
  const calls = [];
  await runLand({ args: { "post-merge": "skip", reason: "history unavailable" }, name: "p", id: "t1", print() {}, request: async (method, path, body) => {
    // The recovery asks for land.post-merge.v1 before its first post-merge request (t458).
    if (path === "/version") return { routeLevel: ROUTE_LEVEL, capabilities: SERVER_CAPABILITIES };
    calls.push(body?.action ?? method);
    if (body) recoverPostMerge(r, body.action, body.reason, "owner", at);
    return { run: structuredClone(r) };
  } });
  assert.deepEqual(calls, ["GET", "skip"]);
  assert.equal(r.state, "reserved");
  assert.equal(r.steps[0].outcome, "waived");
});

function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), "post-merge-privacy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const g = (args, input) => execFileSync("git", args, { cwd: dir, encoding: "utf8", input, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Owner", GIT_AUTHOR_EMAIL: "owner@example.test", GIT_COMMITTER_NAME: "Owner", GIT_COMMITTER_EMAIL: "owner@example.test" }, stdio: ["pipe", "pipe", "pipe"] });
  g(["init", "-q", "-b", "main"]);
  const commit = (text, message = "change") => { writeFileSync(join(dir, "file"), text); g(["add", "."]); g(["commit", "-qm", message]); return g(["rev-parse", "HEAD"]).trim(); };
  const base = commit("safe");
  const identity = [{ name: "Owner", email: "owner@example.test" }];
  const s = { ...step("publish"), class: "publish", command: "git push", destination: "https://example.test/repo.git", ref: "refs/heads/main", privacy: { authors: identity, committers: identity, patterns: ["super-secret"], forbiddenPaths: ["private/**"] } };
  let pushes = 0, calls = [];
  const git = argv => {
    const args = argv.slice(4); calls.push(args);
    if (args[0] === "ls-remote") return `${base}\trefs/heads/main\n`;
    if (args[0] === "fetch") return "";
    if (args[0] === "push") { pushes++; return ""; }
    return g(args);
  };
  return { dir, g, commit, base, s, git, pushes: () => pushes, calls };
}

test("privacy scans add-then-remove secrets rather than just the outgoing tip", async t => {
  const r = repo(t); const secret = r.commit("super-secret"); const head = r.commit("safe again");
  await assert.rejects(publishPinned({ git: r.git, run: { after: head }, step: r.s, cwd: r.dir }), error => error.message.includes(secret) && !error.message.includes("super-secret"));
  assert.equal(r.pushes(), 0);
});

test("privacy traverses every parent, commit messages, exact identities and forbidden paths", async t => {
  const r = repo(t);
  r.g(["checkout", "-qb", "side"]); const secret = r.commit("safe side", "super-secret"); r.commit("safe second");
  r.g(["checkout", "-q", "main"]); r.g(["merge", "--no-ff", "-qm", "merge", "side"]);
  await assert.rejects(publishPinned({ git: r.git, run: { after: r.g(["rev-parse", "HEAD"]).trim() }, step: r.s, cwd: r.dir }), new RegExp(secret));
  r.g(["reset", "--hard", r.base]); const head = r.commit("safe2");
  await assert.rejects(publishPinned({ git: r.git, run: { after: head }, step: { ...r.s, privacy: { ...r.s.privacy, committers: [{ name: "Other", email: "owner@example.test" }] } }, cwd: r.dir }), /identity/);
  await assert.rejects(publishPinned({ git: r.git, run: { after: head }, step: { ...r.s, privacy: { ...r.s.privacy, forbiddenPaths: ["file"] } }, cwd: r.dir }), /path/);
});

test("publication pins source and destination, rescans changed tips and fails closed on missing history", async t => {
  const r = repo(t), head = r.commit("safe2");
  await publishPinned({ git: r.git, run: { after: head }, step: r.s, cwd: r.dir });
  const push = r.calls.find(a => a[0] === "push");
  assert.ok(push.includes(`--force-with-lease=refs/heads/main:${r.base}`));
  assert.ok(push.includes(`${head}:refs/heads/main`));
  let tips = 0, scans = 0;
  const moving = args => {
    if (args.includes("ls-remote")) return `${tips++ ? head : r.base}\trefs/heads/main\n`;
    if (args.includes("rev-list")) scans++;
    return r.git(args);
  };
  await publishPinned({ git: moving, run: { after: head }, step: r.s, cwd: r.dir });
  assert.equal(scans, 2);
  await assert.rejects(publishPinned({ git: r.git, run: { after: a }, step: r.s, cwd: r.dir }));
});

test("executor persists the attempt before clone, uses pinned checkout, installs dependencies and never replays success", async () => {
  let r = run([step("verify")]); preparePostMerge(r, []);
  const calls = [], commands = [];
  const request = async (method, path, body) => {
    calls.push(body?.action ?? method);
    if (path.endsWith("baseline-token")) return { remote: "https://baseline.test/git", token: "secret" };
    if (body?.action === "start") startAttempt(r, "1", at);
    if (body?.action === "finish") finishAttempt(r, body.attempt, body.passed, body.output, at);
    return { run: structuredClone(r) };
  };
  const group = async (argv, opts) => {
    assert.equal(r.state, "running"); commands.push(argv);
    if (argv.includes("checkout")) {
      assert.equal(argv.at(-1), b);
      writeFileSync(join(opts.cwd, "package.json"), "{}"); writeFileSync(join(opts.cwd, "package-lock.json"), "{}");
    }
    return { status: 0, stdout: argv.includes("rev-parse") ? b : "", stderr: "" };
  };
  await executePostMerge({ request, name: "p", id: "t1", group, print() {} });
  assert.equal(calls[1], "start");
  assert.ok(commands.some(a => a[0] === "npm" && a[1] === "ci"));
  assert.equal(r.state, "complete");
  const count = commands.length;
  await executePostMerge({ request, name: "p", id: "t1", group, print() {} });
  assert.equal(commands.length, count);
});


test("CLI landing recovery and dry-run consult the same durable run without repeating a merge", async () => {
  const r = run([step("verify")]); preparePostMerge(r, []);
  const calls = [], lines = [];
  const io = { args: { "dry-run": true }, name: "p", id: "t1", p: {}, workspacePath: () => "/not-used", print: line => lines.push(line), die: message => { throw new Error(message); }, request: async (method, path, body) => {
    calls.push([method, path, body]);
    if (path === "/version") return { routeLevel: ROUTE_LEVEL, capabilities: SERVER_CAPABILITIES };
    if (path.endsWith("/items/t1")) return { item: { state: "merged" }, postMerge: r };
    if (path.includes("post-merge")) return { run: r };
    throw new Error("unexpected route");
  } };
  await runLand(io);
  assert.ok(lines.some(line => line.includes("pending")));
  assert.equal(calls.some(c => c[0] === "POST"), false);
  io.args = { "post-merge": "status" }; calls.length = 0;
  await runLand(io);
  // The version, for land.post-merge.v1 (t458), then the run itself.
  assert.equal(calls.length, 2); assert.equal(calls[0][1], "/version"); assert.match(calls[1][1], /post-merge/);
  io.args = { "post-merge": "retry", "dry-run": true };
  await assert.rejects(runLand(io), /separate action/);
});


test("privacy scans the full raw message even beyond a NUL byte", async t => {
  const r = repo(t);
  const tree = r.g(["rev-parse", "HEAD^{tree}"]).trim();
  const raw = `tree ${tree}\nparent ${r.base}\nauthor Owner <owner@example.test> 1700000000 +0000\ncommitter Owner <owner@example.test> 1700000000 +0000\n\nsafe\0super-secret\n`;
  const head = r.g(["hash-object", "--literally", "-t", "commit", "-w", "--stdin"], raw).trim();
  r.g(["update-ref", "refs/heads/main", head]);
  await assert.rejects(publishPinned({ git: r.git, run: { after: head }, step: r.s, cwd: r.dir }), /privacy message/);
  assert.equal(r.pushes(), 0);
});


test("durable output preserves diagnostics, redacts credentials and bounds long output", () => {
  // Assembled at runtime so the source holds no credential-shaped literal for
  // the secret scan; the redactor sees the same text.
  const pem = (edge) => `-----${edge} ${["PRIVATE", "KEY"].join(" ")}-----`;
  const input = [
    "Build failed at src/index.ts:42",
    'TOKEN=very-private password="two words"',
    ["Authorization:", "Bearer", "abc123"].join(" "),
    `https://${["user", "pass"].join(":")}@example.test/log?${["api", "key"].join("_")}=hidden`,
    "opaque-owner-value",
    pem("BEGIN"),
    "key bytes",
    pem("END"),
  ].join("\n");
  const output = redactedOutput(input, ["opaque-owner-value"]);
  assert.match(output, /Build failed at src\/index.ts:42/);
  for (const secret of ["very-private", "two words", "abc123", "user:pass", "hidden", "opaque-owner-value", "key bytes"]) assert.ok(!output.includes(secret), secret);
  assert.equal(redactedOutput(output), output);
  const bounded = redactedOutput("x".repeat(8180) + " TOKEN=" + "s".repeat(20000));
  assert.ok(bounded.length <= 8192);
  assert.ok(!bounded.includes("ssss"));
  assert.match(bounded, /output truncated/);
  const r = run([step("check")]); preparePostMerge(r, []); startAttempt(r, "out", at);
  finishAttempt(r, "out", false, input, at);
  assert.match(r.steps[0].attempts[0].output, /Build failed/);
  assert.ok(!r.steps[0].attempts[0].output.includes("very-private"));
});

test("first publication scans each distinct blob once across long history and remote rescans", async t => {
  const r = repo(t);
  for (let i = 0; i < 30; i++) writeFileSync(join(r.dir, `stable-${i}`), `stable content ${i}`);
  for (let i = 0; i < 10; i++) r.commit(`revision ${i}`);
  const head = r.g(["rev-parse", "HEAD"]).trim();
  let tips = 0;
  const git = args => {
    if (args.includes("ls-remote")) return tips++ === 0 ? `${r.base}\trefs/heads/main\n` : "";
    return r.git(args);
  };
  await publishPinned({ git, run: { after: head }, step: r.s, cwd: r.dir });
  const reads = r.calls.filter(args => args[0] === "cat-file" && args[1] === "blob");
  assert.equal(reads.length, 41);
  assert.equal(new Set(reads.map(args => args[2])).size, reads.length);
  assert.equal(r.calls.filter(args => args[0] === "rev-list").length, 2);
  assert.equal(r.pushes(), 1);
  // The cache must not allow an already scanned blob under a forbidden name.
  r.g(["mv", "file", "private-file"]); r.g(["commit", "-qm", "rename"]);
  r.g(["mv", "private-file", "file"]); r.g(["commit", "-qm", "restore"]);
  await assert.rejects(publishPinned({ git: r.git, run: { after: r.g(["rev-parse", "HEAD"]).trim() }, step: { ...r.s, privacy: { ...r.s.privacy, forbiddenPaths: ["private-file"] } }, cwd: r.dir }), /privacy path/);
});

test("CLI post-merge recovery refuses a server without land.post-merge.v1 before touching the run (t458)", async () => {
  const calls = [];
  const io = { args: { "post-merge": "status" }, name: "p", id: "t1", print() {}, die: message => { throw new Error(message); }, request: async (method, path) => {
    calls.push(path);
    if (path === "/version") return { routeLevel: 26, commit: "0123456789abcdef" };
    throw new Error("unexpected route");
  } };
  await assert.rejects(runLand(io), /lacks capabilities land\.post-merge\.v1.*then run atelier land t1 --post-merge status again/);
  assert.deepEqual(calls, ["/version"]);
});
