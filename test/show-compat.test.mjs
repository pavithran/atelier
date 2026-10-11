import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const cli = resolve("cli/atelier.mjs");
const brief = {
  title: "Ship the feature", decided: "Approve plan t1's split of: Ship the feature",
  summary: null, evidence: ["Phase: proposed."],
  recommendation: { verdict: "decide", reason: "Read the split with atelier plan show t1." },
};

// Exercise the CLI against the older server contract without opening sockets.
function fixture(t, status = 404, error = "not_found", detail = "no such route", queue = null) {
  const root = mkdtempSync(join(process.cwd(), ".show-compat-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const preload = join(root, "server.mjs");
  writeFileSync(preload, `
    globalThis.fetch = async (url, options) => {
      if (options.method !== "GET") throw new Error("show must be read-only");
      const path = new URL(url).pathname;
      if (path === "/api/queue" && ${queue !== null}) return Response.json(${JSON.stringify(queue)});
      if (path === "/api/projects/proj/items/t1/brief") return Response.json(${JSON.stringify(brief)});
      if (path === "/api/projects/proj/items/t1") return Response.json(${JSON.stringify({ error, detail })}, { status: ${status} });
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
    if (flags.includes("--json")) assert.deepEqual(JSON.parse(r.stdout), { ...brief, reviews: [], unparsable: [] });
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
