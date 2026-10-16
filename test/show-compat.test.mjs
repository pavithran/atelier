import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const cli = resolve("cli/atelier.mjs");
const brief = {
  title: "Ship the feature", decided: "Approve plan t1's split of: Ship the feature",
  summary: null, evidence: ["Phase: proposed."],
  recommendation: { verdict: "decide", reason: "Read the split with atelier plan show t1." },
};

// Exercise the CLI against the older server contract without opening sockets.
function fixture(t, status = 404, error = "not_found", detail = "no such route", queue = null, body = null) {
  const root = mkdtempSync(join(tmpdir(), "atelier-show-compat-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const preload = join(root, "server.mjs");
  writeFileSync(preload, `
    globalThis.fetch = async (url, options) => {
      if (options.method !== "GET") throw new Error("show must be read-only");
      const path = new URL(url).pathname;
      if (path === "/api/queue" && ${queue !== null}) return Response.json(${JSON.stringify(queue)});
      if (path === "/api/projects/proj/items/t1/brief") return Response.json(${JSON.stringify(brief)});
      if (path === "/api/projects/proj/items/t1") return Response.json(${JSON.stringify(body ?? { error, detail })}, { status: ${body ? 200 : status} });
      throw new Error("unexpected route: " + path);
    };
  `);
  return (flags = []) => spawnSync(process.execPath, ["--import", preload, cli, "show", "t1", "--project", "proj", "--as", "owner", ...flags], {
    cwd: root, encoding: "utf8",
    env: { ...process.env, ATELIER_ACTOR: "owner", ATELIER_CONFIG_DIR: root, ATELIER_CACHE: root, ATELIER_TOKEN: "fake", ATELIER_SERVER: "https://fake.invalid" },
  });
}

test("show preserves the plan brief, JSON and review output without a detail route", (t) => {
  const run = fixture(t);
  for (const flags of [[], ["--json"], ["--reviews"]]) {
    const r = run(flags);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    if (flags.includes("--json")) assert.deepEqual(JSON.parse(r.stdout), { ...brief, reviews: [], unparsable: [], failedChecks: [] });
    else {
      assert.ok(r.stdout.startsWith(`proj/t1  ${brief.title}\n${brief.decided}\nPhase: proposed.\nRecommendation: decide. ${brief.recommendation.reason}\n`), r.stdout);
      if (flags.includes("--reviews")) assert.match(r.stdout, /No reviews are recorded/);
    }
  }
});

// t420: show prints each reason the queue holds the task, with the command
// that releases it, and --json carries them; another project's t1 does not count.
test("show lists why the queue holds a dispatched task", (t) => {
  const why = [
    { kind: "held", line: "Held: waits on t9 (claimed by codex/gpt-6): both scopes reach core file src/ledger.ts; offered once t9 merges or is abandoned, or at once with atelier dispatch t1 --overlap-ok." },
    { kind: "skipped", line: "Skipped by home:studio after 2 failed runs (the last stalled); that runner passes it by until it restarts: fix the cause, then restart it with atelier runner --name home:studio." },
  ];
  const run = fixture(t, 404, "not_found", "no such route", [
    { project: "other", item: { id: "t1", why: [{ kind: "overlap", line: "Overlap refused elsewhere." }] } },
    { project: "proj", item: { id: "t1", why } },
  ]);
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  for (const { line } of why) assert.ok(r.stdout.includes(`\n${line}`), r.stdout);
  assert.ok(!r.stdout.includes("elsewhere"), r.stdout);
  assert.deepEqual(JSON.parse(run(["--json"]).stdout).why, why);
});

for (const [status, error, detail, exitCode] of [
  [403, "forbidden", "not allowed", 1],
  [404, "not_found", "no such item", 1],
  [503, "unavailable", "try later", 4],
  [503, "not_found", "no such route", 4],
]) test(`show does not hide detail failure ${status}: ${detail}`, (t) => {
  const run = fixture(t, status, error, detail);
  for (const flags of [[], ["--json"], ["--reviews"]]) {
    const r = run(flags);
    assert.equal(r.status, exitCode);
    assert.ok(r.stderr.includes(`${error}: ${detail}`), r.stderr);
    assert.equal(r.stdout, "");
  }
});

// t420: against a server from before t420, whose queue carries `held` and no
// `why`, show still says the core-file hold.
test("show says the hold from an older server's queue", (t) => {
  const held = { id: "t9", owner: "codex/gpt-6", state: "claimed", title: "Live", core: "src/ledger.ts" };
  const run = fixture(t, 404, "not_found", "no such route", [
    { project: "proj", item: { id: "t1", dispatch: { to: "home", agent: null, model: null }, held } },
  ]);
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("\nHeld: waits on t9 (claimed by codex/gpt-6): both scopes reach core file src/ledger.ts; offered once t9 submits or is released, or at once with atelier dispatch t1 --overlap-ok."), r.stdout);
});

// Pre-review findings of t524's own review. show took the queue's pre-review
// entry for the task for its build and printed a build's "not taken"
// reasons for it; and criterion 9's pre-review state, binding, reviewer,
// findings and recovery action reached show's JSON alone, never its text.
test("show says the task's pre-review in words, and takes no build reasons from its pre-review entry", (t) => {
  const prereview = {
    request: 1000000007, item: "t1", state: "blocked", reviewer: "codex/gpt-6-astra", runner: "home:studio",
    binding: { head: "a".repeat(40), criteria: "c".repeat(64), contributors: ["claude-code/opus-5.5"], generation: 3, main: "b".repeat(40), tree: "d".repeat(40) },
    at: "2026-10-11T12:00:00.000Z", claimedAt: "2026-10-11T12:01:00.000Z", settledAt: "2026-10-11T12:09:00.000Z", attempts: 1, outcome: null, detail: null, files: [],
    verdict: "reject", note: "It breaks.", findings: [{ file: "src/a.ts", line: 3, severity: "blocking", text: "the queue loses a waiter" }],
    detached: false, ownerAction: null, recovery: "rework: the builder addresses the blocking findings; then atelier unblock t1 and atelier land t1 again",
  };
  const fence = { request: 1000000007, head: "a".repeat(40), reviewer: "codex/gpt-6-astra", at: "2026-10-11T12:09:00.000Z", blocking: 1, builder: "claude-code/opus-5.5", ownerAction: null };
  const run = fixture(t, 404, "not_found", "no such route", [
    { project: "proj", item: { id: "t1", dispatch: { job: "prereview" }, why: [{ kind: "unoffered", line: "Not offered: no live runner offers a build of it." }] } },
  ], { item: { id: "t1", head: null }, prereviews: [prereview], prereviewFence: fence, reviews: [], unparsable: [] });
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes("Not offered"), r.stdout);
  for (const line of [
    "Pre-review 1000000007: blocked; reviewer codex/gpt-6-astra on home:studio; attempt 1 of 3",
    "Binding: head aaaaaaaa merged with main bbbbbbbb, tree dddddddd, criteria cccccccccccc, contributors claude-code/opus-5.5",
    "Verdict: reject: It breaks.",
    "  src/a.ts:3 · blocking · the queue loses a waiter",
    `Recovery: ${prereview.recovery}`,
  ]) assert.ok(r.stdout.includes(`\n${line}\n`), `${line}\n${r.stdout}`);
  assert.match(r.stdout, /Fenced: t1's pre-review 1000000007 by codex\/gpt-6-astra found a blocking finding at aaaaaaaa/);
  const json = JSON.parse(run(["--json"]).stdout);
  assert.equal(json.why, undefined);
  assert.deepEqual(json.prereview, prereview);
  assert.deepEqual(json.prereviewFence, fence);
});

// t710: twenty filed tasks could be read only from their filing commands:
// show printed the title and criteria, never the brief the developer wrote,
// and start, which prints it, also claims the task.
test("show prints the filed brief and --json carries it, without claiming", (t) => {
  const filed = "2026-10-16: the runner stalls.\nRecommendation: accept. Nothing blocks this.";
  const run = fixture(t, 200, "", "", null, { item: { id: "t1", head: null, brief: filed }, reviews: [], unparsable: [] });
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("\nBrief: 2026-10-16: the runner stalls. Recommendation: accept. Nothing blocks this.\n"), r.stdout);
  assert.ok(!/\nRecommendation: accept\./.test(r.stdout), "a newline in the brief cannot pose as a line of Atelier's");
  assert.equal(JSON.parse(run(["--json"]).stdout).brief, filed);
  // A task filed with no brief says nothing of one.
  const bare = fixture(t, 200, "", "", null, { item: { id: "t1", head: null, brief: null }, reviews: [], unparsable: [] });
  assert.ok(!bare().stdout.includes("Brief:"));
  assert.equal("brief" in JSON.parse(bare(["--json"]).stdout), false);
});
