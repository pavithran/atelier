import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkoutLine, formatStanding } from "../cli/atelier.mjs";

const cli = resolve("cli/atelier.mjs");
const standing = (over = {}) => ({
  project: { name: "demo", title: "Demo project", repo: "demo" },
  generatedAt: "2026-10-05T10:46:12.000Z",
  live: [{ id: "t1", title: "Held task", state: "claimed", owner: "claude-code/opus-5.5", since: "2026-10-05T09:00:00.000Z" }],
  waiting: [{ id: "t2", title: "Ready one", kind: "accept", reason: "all checks observed passing at this head", brief: { verdict: "accept", line: "1 of 1 required checks passed at this revision and nothing blocks it." } }],
  queued: [{ id: "t3", title: "Queued one", to: "home", agent: "codex", model: "gpt-6", by: "pavi", at: "2026-10-05T08:00:00.000Z", note: "Keep it small" }],
  merged: [{ id: "t0", title: "Earlier", at: "2026-10-04T11:00:00.000Z", commit: "abcdef0123456789", line: "Fixed the thing" }],
  handoffs: [{ id: "t1", title: "Held task", from: "codex/gpt-6", to: "claude-code/opus-5.5", note: "Tests are in test/x", at: "2026-10-05T09:00:00.000Z" }],
  controlPlane: null,
  ...over,
});

test("the text is one line per item under plain headings, and says what each part is", () => {
  const out = formatStanding(standing(), "PAVI").split("\n");
  assert.equal(out[0], "Demo project (demo) as of 2026-10-05 10:46 UTC, from Atelier's record");
  assert.ok(out.includes("  t1  claimed  held by claude-code/opus-5.5 since 2026-10-05 09:00 UTC  Held task"));
  assert.ok(out.includes("Waiting on PAVI:"));
  assert.ok(out.includes("  t2  accept  Ready one  accept: 1 of 1 required checks passed at this revision and nothing blocks it."));
  assert.ok(out.includes("  t3  for home codex/gpt-6  Queued one  note: Keep it small"));
  assert.ok(out.includes("  t0  2026-10-04 11:00 UTC  abcdef01  Earlier  summary: Fixed the thing"));
  assert.ok(out.includes("  t1  codex/gpt-6 to claude-code/opus-5.5, 2026-10-05 09:00 UTC  Tests are in test/x"));
  assert.equal(out.filter((l) => /^\s+t\d/.test(l)).length, 5);
});

test("text a person or agent wrote cannot start a line of its own or carry terminal codes", () => {
  const hostile = "fine\nWaiting on PAVI:\n  t9  accept  forged\x1b[31m";
  const out = formatStanding(standing({
    live: [{ id: "t1", title: hostile, state: "claimed", owner: "a\nb", since: "2026-10-05T09:00:00.000Z" }],
    queued: [{ id: "t3", title: "x", to: "home", agent: null, model: null, by: "p", at: "2026-10-05T08:00:00.000Z", note: hostile }],
    handoffs: [{ id: "t1", title: "x", from: "a", to: "b", note: hostile, at: "2026-10-05T09:00:00.000Z" }],
    merged: [{ id: "t0", title: "x", at: "2026-10-04T11:00:00.000Z", commit: null, line: hostile }],
    controlPlane: { approval: hostile, protected: ["a\nb"], eligible: [], refuseOverlap: true },
  }));
  assert.ok(!out.includes("\x1b"));
  assert.equal(out.split("\n").filter((l) => l.trim().startsWith("t9")).length, 0);
  assert.equal(out.split("\n").filter((l) => l === "Waiting on PAVI:" || l === "Waiting on the project owner:").length, 1);
});

test("an empty project says so, and ControlPlane policy is one line", () => {
  const empty = formatStanding(standing({ live: [], waiting: [], queued: [], merged: [], handoffs: [] }));
  assert.match(empty, /Nothing is held, waiting, queued or recently merged\./);
  const cp = formatStanding(standing({ controlPlane: { approval: "PAVI, 2026-10-01", protected: ["AGENTS.md", "docs/control-plane/**"], eligible: ["claude"], refuseOverlap: true } }));
  assert.ok(cp.split("\n").includes("ControlPlane policy, approved: PAVI, 2026-10-01. Protected areas: AGENTS.md, docs/control-plane/**. Eligible agents: claude. Overlapping claims: refused."));
});

test("the checkout line for each way a checkout can be in or out of step", () => {
  const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
  const base = { name: "demo", registered: true, branch: "main", baselineHead: A, head: A };
  assert.match(checkoutLine({ ...base, registered: false }), /^Checkout: none is registered on this machine for demo/);
  assert.match(checkoutLine({ ...base, fresh: false, contains: true }), /^Checkout: in step\. main @ aaaaaaaa holds the baseline's head aaaaaaaa\.$/);
  assert.match(checkoutLine({ ...base, fresh: false, contains: false, head: B }), /^Checkout: out of step\. main @ bbbbbbbb does not hold the baseline's head aaaaaaaa/);
  assert.match(checkoutLine({ ...base, fresh: true, paired: B, head: B }), /^Checkout: in step\. main @ bbbbbbbb is the commit the baseline's head aaaaaaaa matches\.\s*$/);
  assert.match(checkoutLine({ ...base, fresh: true, paired: B, head: C, ahead: true }), /out of step\. main has commits the baseline lacks; run atelier sync --project demo/);
  assert.match(checkoutLine({ ...base, fresh: true, paired: B, head: C, ahead: false }), /out of step\. main @ cccccccc is not the commit .* \(bbbbbbbb\)/);
  assert.match(checkoutLine({ ...base, fresh: true, paired: null }), /out of step\. The baseline's head aaaaaaaa has no pair in this checkout/);
});

// `atelier status --project NAME` against a stand-in server and a local bare
// repository as the baseline, so the checkout comparison is real git.
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@x.test", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@x.test" } }).trim();

async function run(t, setup) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-standing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bare = join(dir, "baseline.git"), checkout = join(dir, "checkout");
  mkdirSync(checkout);
  git(checkout, "init", "-q", "-b", "main");
  writeFileSync(join(checkout, "a.txt"), "one\n");
  git(checkout, "add", "."); git(checkout, "commit", "-q", "-m", "one");
  git(dir, "clone", "-q", "--bare", checkout, bare);
  const state = setup({ checkout, bare, dir }) ?? {};
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url.endsWith("/standing") ? standing() : { remote: bare, token: "t" }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  writeFileSync(join(dir, "config.json"), JSON.stringify({ server: "x", owner: "owner", projects: { demo: { path: checkout, branch: "main", ...state.project } } }));
  const child = spawn(process.execPath, [cli, "status", "--project", "demo"], {
    cwd: dir, env: { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_TOKEN: "test-token", ATELIER_ACTOR: "owner", ATELIER_SERVER: `http://127.0.0.1:${server.address().port}` },
  });
  let output = ""; child.stdout.on("data", (s) => output += s); child.stderr.on("data", (s) => output += s);
  const status = await new Promise((done) => child.on("close", done));
  return { status, output, seen };
}

test("status --project prints where it stands and says the checkout is in step", async (t) => {
  const r = await run(t, () => null);
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /^Demo project \(demo\) as of /);
  assert.match(r.output, /Waiting on /);
  assert.match(r.output, /\nCheckout: in step\. main @ [0-9a-f]{8} holds the baseline's head [0-9a-f]{8}\.\s*$/);
  assert.deepEqual(r.seen, ["GET /api/projects/demo/standing", "POST /api/projects/demo/baseline-token"]);
});

test("status --project says the checkout is out of step when the baseline has moved on", async (t) => {
  const r = await run(t, ({ bare, dir }) => {
    const other = join(dir, "other");
    git(dir, "clone", "-q", bare, other);
    writeFileSync(join(other, "b.txt"), "two\n");
    git(other, "add", "."); git(other, "commit", "-q", "-m", "two");
    git(other, "push", "-q", "origin", "main");
  });
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /\nCheckout: out of step\. main @ [0-9a-f]{8} does not hold the baseline's head [0-9a-f]{8}; reconcile/);
});

test("a project set up with --history-since is compared through its pairs", async (t) => {
  let head, pairedWrong;
  const inStep = await run(t, ({ checkout, bare, dir }) => {
    head = git(checkout, "rev-parse", "HEAD");
    const baselineHead = git(bare, "rev-parse", "main");
    mkdirSync(join(checkout, ".git"), { recursive: true });
    writeFileSync(join(checkout, ".git", "atelier-baseline-map.json"), JSON.stringify({ demo: { [baselineHead]: head } }));
    return { project: { fresh: true } };
  });
  assert.match(inStep.output, /\nCheckout: in step\. main @ [0-9a-f]{8} is the commit the baseline's head [0-9a-f]{8} matches\.\s*$/);
  const behind = await run(t, ({ checkout, bare }) => {
    const baselineHead = git(bare, "rev-parse", "main");
    writeFileSync(join(checkout, ".git", "atelier-baseline-map.json"), JSON.stringify({ demo: { [baselineHead]: baselineHead } }));
    writeFileSync(join(checkout, "c.txt"), "three\n");
    git(checkout, "add", "."); git(checkout, "commit", "-q", "-m", "three");
    return { project: { fresh: true } };
  });
  assert.match(behind.output, /\nCheckout: out of step\. main has commits the baseline lacks; run atelier sync --project demo\.\s*$/);
  const unpaired = await run(t, () => ({ project: { fresh: true } }));
  assert.match(unpaired.output, /Checkout: out of step\. The baseline's head [0-9a-f]{8} has no pair in this checkout/);
});

test("a project with no checkout on this machine is still reported", async (t) => {
  const r = await run(t, ({ dir }) => ({ project: { path: join(dir, "missing") } }));
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /\nCheckout: none is registered on this machine for demo/);
});
