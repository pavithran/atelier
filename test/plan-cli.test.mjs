import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// `atelier plan` against a stand-in server on 127.0.0.1, as the other CLI
// tests run: the server answers each plan route with a canned reply and logs
// every request, so these tests check what the command sends, what it
// refuses before sending anything, and what it prints.

const cli = resolve("cli/atelier.mjs");
const HASH = "4".repeat(64);
const PLANNER = "claude-code/opus-5.5";
const AT = "2026-10-06T12:00:00.000Z";

const item = { id: "t1", title: "Ship the feature", scope: ["src/**"], state: "open", owner: null, fork: null, base: null, head: null, acceptedHead: null, createdAt: AT, updatedAt: AT, lastPushAt: null, kind: "plan" };
const proposedView = {
  item, phase: "proposed", goal: "Ship the feature", scope: ["src/**"], planner: PLANNER, plannerReasons: [], blocked: null, completedAt: null,
  proposal: { hash: HASH, by: PLANNER, at: AT, count: 1, answered: true },
  plan: { schema: "atelier.plan.v1", goal: "Ship the feature", parts: [{ key: "a", title: "Part a", kind: "build", taskKind: "feature", scope: ["src/a/**"], dependsOn: [], provides: [], uses: [], brief: "Build it", acceptance: ["It works"], tests: [], size: "S" }] },
  approval: null, parts: [], preview: null, integration: null,
};
const dispatch = { to: "home", agent: "zcode", model: "glm-5.3", by: "atelier/orchestrator", at: AT, note: "" };
const partView = { id: "t2", key: "a", title: "Part a", state: "open", owner: null, head: null, acceptedHead: null, scope: ["src/a/**"], dependsOn: [], dispatch, route: null, attempts: [], gate: null };
const approvedView = { ...proposedView, phase: "building", approval: { hash: HASH, at: AT, by: "owner", allowPaid: false, limits: { maxParallel: 2, attempts: 3, reviewRounds: 2, maxJobs: 4, hours: 24, allowPaid: false }, deadline: AT, jobsUsed: 1 }, parts: [partView] };
const brief = { title: "Ship the feature", decided: "Approve plan t1's split of: Ship the feature", summary: null, evidence: ["Phase: proposed."], recommendation: { verdict: "decide", reason: "Read the split with atelier plan show t1." } };

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "atelier-plan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method, path: req.url, actor: req.headers["x-atelier-actor"], body });
    let status = 200, data = { error: "not_found", detail: "no such route" };
    const p = req.url;
    if (req.method === "POST" && p === "/api/projects/proj/items") { status = 201; data = { item: { ...item, dispatch: { ...dispatch, agent: "claude-code", model: "opus-5.5", by: "owner", job: "plan" } }, planner: PLANNER, reasons: ["Named by the project owner"] }; }
    else if (req.method === "GET" && p === "/api/projects/proj/items/t1/plan") data = proposedView;
    else if (req.method === "GET" && p === "/api/projects/proj/items/t1/brief") data = brief;
    else if (req.method === "POST" && p === "/api/projects/proj/items/t1/plan") {
      if (body.extra !== undefined) { status = 422; data = { error: "invalid_plan", detail: "the plan was refused (attempt 1 of 2): plan.extra: unknown field", valid: false, errors: ["plan.extra: unknown field"], attempt: 1, attempts: 2 }; }
      else data = { valid: true, hash: HASH, parts: 1 };
    }
    else if (req.method === "POST" && p === "/api/projects/proj/items/t1/plan/approve") data = approvedView;
    else if (req.method === "POST" && p === "/api/projects/proj/items/t1/plan/revise") data = { ...proposedView, proposal: { ...proposedView.proposal, answered: false } };
    else if (req.method === "POST" && /^\/api\/projects\/proj\/items\/t2\/plan\/(reroute|retry)$/.test(p)) data = approvedView;
    else if (req.method === "POST" && p === "/api/projects/proj/items/t1/plan/stop") data = { ...approvedView, item: { ...item, state: "abandoned" }, parts: [{ ...partView, state: "abandoned" }] };
    else status = 404;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  });
  t.after(() => server.close());
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  writeFileSync(join(root, "config.json"), JSON.stringify({ projects: {} }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function run(argv, env = {}) {
    const { ATELIER_ACTOR: _, ...inherited } = process.env;
    const child = spawn(process.execPath, [cli, ...argv, "--project", "proj"], {
      cwd: root, env: { ...inherited, ATELIER_CONFIG_DIR: root, ATELIER_CACHE: join(root, "cache"), ATELIER_TOKEN: "owner-token", ATELIER_SERVER: origin, ...env },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (s) => stdout += s); child.stderr.on("data", (s) => stderr += s);
    const status = await new Promise((done) => child.on("close", done));
    return { status, stdout, stderr };
  }
  return { root, run, requests };
}

test("plan \"goal\" starts a plan as the owner with its scope and planner, and says how a plan is posted until a runner takes plan jobs", async (t) => {
  const f = await fixture(t);
  const r = await f.run(["plan", "Ship", "the", "feature", "--scope", "src/**", "--scope", "docs/**", "--planner", PLANNER]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.requests, [{ method: "POST", path: "/api/projects/proj/items", actor: "owner", body: { kind: "plan", goal: "Ship the feature", scope: ["src/**", "docs/**"], planner: PLANNER } }]);
  assert.equal(r.stdout.split("\n")[0], "t1 is a plan for: Ship the feature");
  assert.match(r.stdout, /Planner: claude-code\/opus-5\.5\. Named by the project owner/);
  assert.match(r.stdout, /No runner takes a plan job yet: to plan by hand, claim t1 as claude-code\/opus-5\.5 with --runner home:NAME, then atelier plan post t1 FILE\./);
  // Refused before any request: no goal, a planner that is not harness/model, a bare scope.
  for (const argv of [["plan"], ["plan", "Ship", "--planner", "opus"], ["plan", "Ship", "--scope", "--planner", PLANNER]]) {
    const refused = await f.run(argv);
    assert.equal(refused.status, 1, argv.join(" "));
  }
  assert.equal(f.requests.length, 1);
});

test("plan show prints the plan, or its JSON, and each subcommand refuses flags it does not take", async (t) => {
  const f = await fixture(t);
  const r = await f.run(["plan", "show", "t1"]);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split("\n");
  for (const line of ["t1  plan  Ship the feature", "Phase: proposed.", `Approve this split: atelier plan approve t1 --hash ${HASH} --project proj`]) assert.ok(lines.includes(line), line);
  assert.equal(f.requests[0].actor, "owner");
  const json = await f.run(["plan", "show", "t1", "--json"]);
  assert.deepEqual(JSON.parse(json.stdout), proposedView);
  for (const [argv, message] of [
    [["plan", "show", "t1", "--hash", HASH], "plan show does not take --hash; see atelier plan --help"],
    [["plan", "retry", "t2", "--note", "x"], "plan retry does not take --note; see atelier plan --help"],
    [["plan", "Ship", "--json"], "plan does not take --json; see atelier plan --help"],
    [["plan", "show"], "usage: atelier plan"],
    [["plan", "show", "t1", "t2"], "usage: atelier plan"],
  ]) {
    const refused = await f.run(argv);
    assert.equal(refused.status, 1, argv.join(" "));
    assert.ok(refused.stderr.includes(message), `${argv.join(" ")}: ${refused.stderr}`);
  }
  assert.equal(f.requests.length, 2);
});

test("plan approve sends the full hash and allowPaid; revise, reroute, retry and stop send what each needs", async (t) => {
  const f = await fixture(t);
  for (const argv of [["plan", "approve", "t1"], ["plan", "approve", "t1", "--hash", "4444"], ["plan", "revise", "t1"], ["plan", "reroute", "t2"]]) {
    const refused = await f.run(argv);
    assert.equal(refused.status, 1, argv.join(" "));
  }
  assert.equal(f.requests.length, 0);
  const approved = await f.run(["plan", "approve", "t1", "--hash", HASH, "--allow-paid"]);
  assert.equal(approved.status, 0, approved.stderr);
  assert.match(approved.stdout, /^t1 is approved at 444444444444: t2 a\.\nQueued now: t2 for zcode\/glm-5\.3\./);
  assert.equal((await f.run(["plan", "approve", "t1", "--hash", HASH])).status, 0);
  assert.equal((await f.run(["plan", "revise", "t1", "--note", "Split a"])).status, 0);
  const rerouted = await f.run(["plan", "reroute", "t2", "--to", "zcode/glm-5.3"]);
  assert.equal(rerouted.stdout.trim(), "t2 is built by zcode/glm-5.3 from now on; it is queued for it.");
  const retried = await f.run(["plan", "retry", "t2"]);
  assert.equal(retried.stdout.trim(), "t2's attempts count afresh; it is queued for zcode/glm-5.3.");
  const stopped = await f.run(["plan", "stop", "t1", "--note", "changed course"]);
  assert.match(stopped.stdout, /^t1 is stopped: t1, t2 are abandoned, and their write tokens revoked\./);
  assert.deepEqual(f.requests.map((r) => [r.path.replace("/api/projects/proj/items/", ""), r.actor, r.body]), [
    ["t1/plan/approve", "owner", { hash: HASH, allowPaid: true }],
    ["t1/plan/approve", "owner", { hash: HASH, allowPaid: false }],
    ["t1/plan/revise", "owner", { note: "Split a" }],
    ["t2/plan/reroute", "owner", { to: "zcode/glm-5.3" }],
    ["t2/plan/retry", "owner", {}],
    ["t1/plan/stop", "owner", { note: "changed course" }],
  ]);
});

test("plan post sends the file's document as the planner, and prints every error of a refused one", async (t) => {
  const f = await fixture(t);
  const file = join(f.root, "plan.json");
  writeFileSync(file, JSON.stringify(proposedView.plan));
  const r = await f.run(["plan", "post", "t1", file, "--as", PLANNER]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.requests[0], { method: "POST", path: "/api/projects/proj/items/t1/plan", actor: PLANNER, body: proposedView.plan });
  assert.equal(r.stdout, `Proposed 1 part for t1 as ${HASH}.\nThe owner reads it with atelier plan show t1 and approves that hash. Release your claim: atelier release t1 --project proj\n`);
  writeFileSync(file, JSON.stringify({ ...proposedView.plan, extra: true }));
  const refused = await f.run(["plan", "post", "t1", file, "--as", PLANNER]);
  assert.equal(refused.status, 1);
  assert.equal(refused.stderr, "atelier: invalid_plan: the plan was refused (attempt 1 of 2): plan.extra: unknown field\n");
  // Not JSON, or no file named: refused before any request.
  writeFileSync(file, "{ not json");
  assert.match((await f.run(["plan", "post", "t1", file, "--as", PLANNER])).stderr, /is not a JSON plan document/);
  assert.match((await f.run(["plan", "post", "t1", "--as", PLANNER])).stderr, /name the file that holds the plan document/);
  assert.equal(f.requests.length, 2);
});

test("atelier show prints a plan item's brief, as it prints any item's", async (t) => {
  const f = await fixture(t);
  const r = await f.run(["show", "t1"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.startsWith("proj/t1  Ship the feature\nApprove plan t1's split of: Ship the feature\nPhase: proposed.\nRecommendation: decide. Read the split with atelier plan show t1.\n"));
});
