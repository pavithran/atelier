// t589: in fast mode a runner takes a dispatched build without a fork. The
// evidence: 2026-10-13 10:35 EDT, in fast mode (decision d14), every runner
// build still began with a claim that forks main, and forks of
// cloudflare-git failed (Artifacts INTERNAL_ERROR), so builds were run by
// hand in local clones. A build the queue marks fast is taken with atelier
// fast take (no fork, no write token, a clean clone of main), built and
// committed there, and reported with atelier fast ready; nothing is pushed.
// In full mode the runner claims with a fork, pushes and submits, as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runTask, runOutcome, fastBuildSection } from "../cli/runner.mjs";
import { fastLand, readySources } from "../cli/fast.mjs";
import { ROUTE_LEVEL, SERVER_CAPABILITIES } from "../src/route-level.ts";

const entry = { agent: "claude-code", models: ["opus-5.5"], command: ["claude", "{brief_file}"] };
const config = { agents: [entry] };
const ACTOR = "claude-code/opus-5.5", MAIN = "a".repeat(40), BUILT = "b".repeat(40);
const item = { id: "t13", title: "Fast build", scope: ["cli/**"], state: "open", dispatch: { at: "2026-10-13T14:00:00.000Z", agent: "claude-code", model: "opus-5.5" } };
const assignment = (over = {}) => ({ project: "atelier", item, agent: entry.agent, model: entry.models[0], actor: ACTOR, ...over });
const FAST_DIR = "/cache/fast/atelier/t13";

// A runner's io with fake Git: `take` is what fast take answers (or an
// Error it fails with), `head` what the clone's HEAD reads after the harness.
function fixture({ take = { dir: FAST_DIR, base: MAIN, head: MAIN, resumed: false }, head = BUILT, code = 0, fail = null } = {}) {
  const calls = [], logs = [];
  const io = {
    prepareSubmission: undefined,
    log: (s) => logs.push(s), stopped: () => false, env: {}, ownerTokens: () => [],
    workspacePath: (project, id) => `/cache/work/${project}/${id}`,
    async cli(argv, cwd) {
      calls.push({ argv, cwd });
      const verb = argv[0] === "fast" ? `fast ${argv[1]}` : argv[0];
      if (verb === fail?.verb) throw fail.error;
      if (verb === "fast take") { if (take instanceof Error) throw take; return `Warning: something said first\n${JSON.stringify(take)}\n`; }
      return "";
    },
    async reset(cwd) { calls.push({ reset: cwd }); },
    // A claim's first read (cleanup) is the workspace as claimed, main; the
    // read after the harness is what it committed.
    async head(cwd, opts = {}) { calls.push({ head: cwd }); return opts.cleanup ? MAIN : head; },
    async isAncestor() { return true; },
    async jobBrief() { return { text: "The server's brief." }; },
    async brief(workspace, text) { calls.push({ brief: text, workspace }); return { file: `${workspace}/.scratch/brief.txt` }; },
    async harness(argv, cwd) { calls.push({ harness: argv, cwd }); return { code }; },
    async removeBrief(brief) { calls.push({ removed: brief.file }); },
    async identityRefusals() { return []; },
  };
  return { io, calls, logs, verbs: () => calls.filter((c) => c.argv).map((c) => (c.argv[0] === "fast" ? `fast ${c.argv[1]}` : c.argv[0])) };
}

test("in fast mode the runner takes the build without a fork, builds in the clean clone of main, and reports its commit; it never claims, pushes or submits", async () => {
  const { io, calls, logs, verbs } = fixture();
  const state = await runTask(assignment({ fast: true }), config, "home:studio", io);
  assert.equal(state.phase, "submitted");
  assert.equal(state.fast, true);
  assert.equal(state.head, BUILT);
  assert.deepEqual(verbs(), ["fast take", "fast ready"]);
  assert.deepEqual(calls.find((c) => c.argv?.[1] === "take").argv, ["fast", "take", "t13", "--project", "atelier", "--as", ACTOR, "--runner", "home:studio", "--json"]);
  const ready = calls.find((c) => c.argv?.[1] === "ready");
  assert.deepEqual(ready.argv, ["fast", "ready", "t13", "--project", "atelier", "--as", ACTOR]);
  assert.equal(ready.cwd, FAST_DIR, "the report is made from the clone");
  assert.equal(calls.find((c) => c.harness).cwd, FAST_DIR);
  const brief = calls.find((c) => c.brief).brief;
  assert.ok(brief.includes(fastBuildSection(MAIN)));
  assert.match(brief, /no fork and no remote.*Do not push/s);
  assert.ok(brief.includes(`Agent: ${ACTOR}`));
  assert.ok(logs.some((l) => l.startsWith("fast mode: no fork and no write token")));
  assert.ok(logs.includes(`ready for fast land: t13=${BUILT}; the developer lands it with atelier fast land`));
  assert.ok(calls.some((c) => c.removed), "the brief is removed");
});

test("in full mode the same build claims with a fork, then finishes (push, checks, submit), as before; fast is never called", async () => {
  const { io, calls, verbs } = fixture();
  const state = await runTask(assignment(), config, "home:studio", io);
  assert.equal(state.phase, "submitted");
  assert.equal(state.fast, undefined);
  assert.deepEqual(verbs(), ["claim", "finish"]);
  assert.deepEqual(calls[0].argv, ["claim", "t13", "--project", "atelier", "--as", ACTOR, "--runner", "home:studio"]);
  assert.equal(calls.find((c) => c.harness).cwd, "/cache/work/atelier/t13");
  assert.ok(!calls.some((c) => c.brief?.includes("## Fast mode")));
});

test("a fast mark on a job that keeps its claim (a part, a merge-main job) is ignored, and the job claims with a fork", async () => {
  for (const other of [{ ...item, kind: "part", plan: "t1" }, { ...item, dispatch: { ...item.dispatch, job: "merge-main", head: MAIN } }]) {
    const { io, verbs } = fixture();
    await runTask(assignment({ fast: true, item: other }), config, "home:studio", io);
    assert.ok(!verbs().some((v) => v.startsWith("fast")), JSON.stringify(other));
    assert.equal(verbs()[0], "claim");
  }
});

test("a fast take the server refuses because the project went back to full mode claims with a fork instead", async () => {
  const refused = Object.assign(new Error("atelier: not_fast_mode: the project is in full mode; t13 is claimed with a fork (atelier claim)\n"), { code: 3, claimRefused: true });
  const { io, logs, verbs } = fixture({ take: refused });
  const state = await runTask(assignment({ fast: true }), config, "home:studio", io);
  assert.deepEqual(verbs(), ["fast take", "claim", "finish"]);
  assert.equal(state.phase, "submitted");
  assert.ok(logs.some((l) => /^fast take refused, so the build claims with a fork: atelier: not_fast_mode/.test(l)));
});

test("any other refused fast take is a refused claim, as a refused claim is", async () => {
  const refused = Object.assign(new Error("atelier: model_held: paused\n"), { code: 3, claimRefused: true });
  const { io, verbs } = fixture({ take: refused });
  const state = await runTask(assignment({ fast: true }), config, "home:studio", io);
  assert.equal(state.claimRefused, true);
  assert.deepEqual(verbs(), ["fast take"]);
});

test("a fast build that commits nothing is released; one whose report fails keeps its claim and its commit", async () => {
  const stalled = fixture({ head: MAIN });
  const s = await runTask(assignment({ fast: true }), config, "home:studio", stalled.io);
  assert.equal(s.phase, "failed");
  assert.equal(s.reason, "harness made no new commit");
  assert.deepEqual(stalled.verbs(), ["fast take", "release"]);

  const unreported = fixture({ fail: { verb: "fast ready", error: new Error("server request failed") } });
  const u = await runTask(assignment({ fast: true }), config, "home:studio", unreported.io);
  assert.equal(u.phase, "failed");
  assert.deepEqual(unreported.verbs(), ["fast take", "fast ready"]);
  assert.ok(unreported.logs.some((l) => l.startsWith(`claim preserved: ${BUILT.slice(0, 8)} is committed in ${FAST_DIR}`)));
});

test("a clone an earlier run left with an unreported commit is reported without the harness", async () => {
  const { io, calls, verbs } = fixture({ take: { dir: FAST_DIR, base: MAIN, head: BUILT, resumed: true } });
  const state = await runTask(assignment({ fast: true, item: { ...item, state: "claimed", owner: ACTOR } }), config, "home:studio", io);
  assert.equal(state.phase, "submitted");
  assert.equal(state.head, BUILT);
  assert.deepEqual(verbs(), ["fast take", "fast ready"]);
  assert.ok(!calls.some((c) => c.harness || c.brief));
});

// ── the CLI end to end, against a stand-in server and a real baseline ────────

const gitIn = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd, encoding: "utf8" }).trim();

async function stub(t, answers) {
  const posted = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const path = new URL(req.url, "http://x").pathname;
    if (req.method === "POST") posted.push({ path, body: raw ? JSON.parse(raw) : {}, runner: req.headers["x-atelier-runner"] ?? null });
    const answer = path === "/api/version" ? { commit: "0".repeat(40), routeLevel: ROUTE_LEVEL, capabilities: SERVER_CAPABILITIES }
      : path === "/api/config" ? { ownerActor: "owner", ownerName: "Owner" }
      : answers[`${req.method} ${path}`];
    res.writeHead(answer === undefined ? 404 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(typeof answer === "function" ? answer(raw ? JSON.parse(raw) : {}) : answer ?? { error: "not_found", detail: path }));
  });
  t.after(() => server.close());
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { origin: `http://127.0.0.1:${server.address().port}`, posted };
}

const cli = resolve("cli/atelier.mjs");
function run(argv, { cwd, env }) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [cli, ...argv], { cwd, env: { ...process.env, ...env } });
    let out = "", err = "";
    child.stdout.on("data", (s) => (out += s));
    child.stderr.on("data", (s) => (err += s));
    child.on("close", (status) => done({ status, out, err }));
  });
}

test("atelier fast take makes a clean clone of main with no remote, fast ready reports its commit, fast status lists it as tN=SHA, and fast land fetches it from the clone", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atelier-fast-build-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The baseline: main with one commit.
  const baseline = join(root, "baseline");
  execFileSync("git", ["init", "-q", "-b", "main", baseline]);
  writeFileSync(join(baseline, "a.txt"), "a\n");
  gitIn(baseline, "add", "-A"); gitIn(baseline, "commit", "-q", "-m", "start");
  const main = gitIn(baseline, "rev-parse", "HEAD");
  let ready = [];
  const server = await stub(t, {
    "POST /api/projects/proj/items/t1/fast-take": { item: { id: "t1", state: "claimed", owner: ACTOR }, fast: true, baseline: { remote: baseline, token: "read-token-x", defaultBranch: "main" }, commitIdentity: { name: "Atelier Bot", email: "bot@example.com" } },
    "GET /api/projects/proj": { project: { name: "proj", policy: {} } },
    "POST /api/projects/proj/items/t1/fast-ready": (body) => { ready = [{ item: "t1", title: "One", ...body, runner: "home:studio", at: "2026-10-13T14:40:00.000Z", by: ACTOR }]; return { item: { id: "t1" }, ready: { ...body, runner: "home:studio" } }; },
    "GET /api/projects/proj/mode": () => ({ mode: "fast", since: "2026-10-13T14:00:00.000Z", reason: "forks fail", by: "owner", line: "Mode: fast since 2026-10-13 14:00 UTC (forks fail)", landed: [], ready }),
  });
  const env = { ATELIER_SERVER: server.origin, ATELIER_TOKEN: "fake", ATELIER_CONFIG_DIR: root, ATELIER_CACHE: join(root, "cache"), ATELIER_ACTOR: ACTOR };

  const take = await run(["fast", "take", "t1", "--project", "proj", "--as", ACTOR, "--runner", "home:studio", "--json"], { cwd: root, env });
  assert.equal(take.status, 0, take.err);
  const taken = JSON.parse(take.out.trim().split("\n").at(-1));
  const dir = join(root, "cache", "fast", "proj", "t1");
  assert.deepEqual(taken, { item: { id: "t1", state: "claimed", owner: ACTOR }, dir, base: main, head: main, resumed: false });
  assert.equal(server.posted.find((p) => p.path.endsWith("/fast-take")).runner, "home:studio");
  assert.ok(!server.posted.some((p) => p.path.endsWith("/claim")), "no claim, so no fork");
  assert.equal(gitIn(dir, "rev-parse", "HEAD"), main);
  assert.equal(gitIn(dir, "remote"), "", "the clone keeps no remote, so nothing is pushed from it");
  assert.equal(gitIn(dir, "config", "--local", "atelier.base"), main);
  assert.equal(gitIn(dir, "config", "--local", "user.email"), "bot@example.com");
  assert.doesNotMatch(readFileSync(join(dir, ".git", "config"), "utf8"), /read-token-x/);

  // The builder commits; the report names the commit, its main and the builder.
  writeFileSync(join(dir, "b.txt"), "b\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", `Add b\n\nAgent: ${ACTOR}`], { cwd: dir });
  const built = gitIn(dir, "rev-parse", "HEAD");
  const report = await run(["fast", "ready", "t1", "--project", "proj", "--as", ACTOR], { cwd: dir, env });
  assert.equal(report.status, 0, report.err);
  assert.deepEqual(server.posted.find((p) => p.path.endsWith("/fast-ready")).body, { commit: built, base: main, builder: ACTOR, workspace: gitIn(dir, "rev-parse", "--show-toplevel") });
  assert.match(report.out, new RegExp(`atelier fast land t1=${built}`));

  // A second take keeps the clone and its unreported commit.
  const again = await run(["fast", "take", "t1", "--project", "proj", "--as", ACTOR, "--runner", "home:studio", "--json"], { cwd: root, env });
  assert.equal(again.status, 0, again.err);
  assert.deepEqual(JSON.parse(again.out.trim().split("\n").at(-1)), { item: { id: "t1", state: "claimed", owner: ACTOR }, dir, base: main, head: built, resumed: true });

  // fast status lists it as a tN=SHA line atelier fast land takes.
  const status = await run(["fast", "status", "--project", "proj"], { cwd: root, env });
  assert.equal(status.status, 0, status.err);
  assert.match(status.out, new RegExp(`^t1=${built}  built by ${ACTOR} on home:studio at 2026-10-13 14:40 UTC$`, "m"));
  assert.match(status.out, new RegExp(`^Land them: atelier fast land t1=${built}$`, "m"));

  // The owner's checkout lacks the commit; fast land fetches it from the clone.
  const owner = join(root, "owner");
  execFileSync("git", ["clone", "-q", baseline, owner]);
  const pairs = [{ id: "t1", sha: built.slice(0, 12) }];
  // The report names the clone as Git resolves it (macOS's /var is /private/var).
  const reported = ready[0].workspace;
  assert.equal(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: reported, encoding: "utf8" }).trim(), gitIn(dir, "rev-parse", "--show-toplevel"));
  assert.deepEqual(readySources(ready, pairs), { t1: reported });
  assert.deepEqual(readySources(ready, [{ id: "t1", sha: "c".repeat(12) }]), {}, "only the commit the report names is fetched");
  const logs = [];
  const landed = await fastLand({ cwd: owner, pairs, titles: { t1: "One" }, reason: "forks fail", typecheck: "true", test: "true", regen: null, sources: readySources(ready, pairs), log: (l) => logs.push(l), record: async () => ({ ok: true }) });
  assert.equal(landed.ok, true, JSON.stringify(landed.failure));
  assert.equal(gitIn(owner, "rev-parse", "HEAD^2"), built);
  assert.ok(logs.includes(`fetched t1's build from ${reported}`));
  assert.ok(existsSync(join(owner, "b.txt")));
});

test("a fast build whose harness exits non-zero or times out is reported as a refusal or a timeout (t363, round 8)", async () => {
  for (const [result, outcome] of [[{ code: 1 }, "refused"], [{ code: null }, "refused"], [{ code: null, timedOut: true }, "timed-out"]]) {
    const { io, calls } = fixture();
    io.harness = async (argv, cwd) => { calls.push({ harness: argv, cwd }); return result; };
    const state = await runTask(assignment({ fast: true }), config, "home:studio", io);
    assert.equal(state.phase, "failed");
    assert.equal(runOutcome(state), outcome, JSON.stringify(result));
  }
});
