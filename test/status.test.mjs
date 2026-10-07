import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { formatRunners, formatStatus, isLive, runnerLine, statusJson } from "../cli/status.mjs";
import { OFFER_LIVE_MS } from "../src/dispatch/rules.ts";

const item = (id, state, over = {}) => ({ id, title: `Task ${id}`, state, owner: null, dispatch: null, ...over });
const entry = (itemId, kind, over = {}) => ({ project: "demo", itemId, title: `Task ${itemId}`, kind, reason: `because ${kind}`, weight: 1, ...over });

test("lists decisions with the next command, work in progress and tasks waiting for a runner", () => {
  const out = formatStatus([{
    name: "demo",
    title: "Demo project",
    items: [
      item("t1", "submitted", { owner: "claude-code/opus-5.5" }),
      item("t2", "claimed", { owner: "codex/gpt-6" }),
      item("t3", "open", { dispatch: { to: "home", agent: "codex", model: "gpt-6" } }),
      item("t4", "merged"),
    ],
    inbox: [entry("t1", "accept"), entry("t5", "merge"), entry("t2", "overlap")],
  }]).split("\n");
  assert.equal(out[0], "Demo project (demo)");
  assert.ok(out.includes("      next: atelier accept t1 --project demo"));
  assert.ok(out.includes("      next: atelier merge t5 --project demo"));
  assert.ok(out.includes("    t1  submitted  held by claude-code/opus-5.5  Task t1"));
  assert.ok(out.includes("    t2  claimed  held by codex/gpt-6  Task t2"));
  assert.ok(out.includes("    t3  for home codex/gpt-6  Task t3"));
  assert.equal(out.filter((l) => l.includes("next:")).length, 2, "overlap has no command");
  assert.ok(!out.some((l) => l.includes("t4")), "merged work is not listed");
});

test("a project with nothing to do says so, and other projects' decisions are ignored", () => {
  const out = formatStatus([{ name: "quiet", items: [item("t1", "merged")], inbox: [entry("t9", "accept", { project: "other" })] }]);
  assert.equal(out, "quiet\n  Nothing waiting.");
});

test("no projects", () => {
  assert.equal(formatStatus([]), "No projects.");
});

test("a plan's entries point to what the plan shows", () => {
  const out = formatStatus([{ name: "demo", items: [item("t1", "open", { kind: "plan" })], inbox: [entry("t1", "approve-plan"), entry("t2", "plan-blocked")] }]).split("\n");
  assert.equal(out.filter((l) => l === "      next: atelier plan show t1 --project demo").length, 1);
  assert.equal(out.filter((l) => l === "      next: atelier plan show t2 --project demo").length, 1);
});

test("an undelivered merge's entry names the dry run, and the merged task itself stays out of In progress", () => {
  const out = formatStatus([{ name: "demo", items: [item("t1", "merged")], inbox: [entry("t1", "ship")] }]).split("\n");
  assert.ok(out.includes("    t1  ship  Task t1"));
  assert.ok(out.includes("      next: atelier ship --dry-run --project demo"));
  assert.ok(!out.includes("In progress"));
});

test("three live tasks where t1 overlaps t2 and t3 print two pair lines, each pair once, after the owner's waits and under the heading", () => {
  const out = formatStatus([{
    name: "demo",
    items: [
      item("t1", "claimed", { owner: "claude-code/opus-5.5" }),
      item("t2", "claimed", { owner: "codex/gpt-6" }),
      item("t3", "claimed", { owner: "opencode/glm-5.3" }),
    ],
    inbox: [
      entry("t4", "accept"),
      entry("t1", "overlap", { reason: "scope overlaps t2 (codex/gpt-6)" }),
      entry("t1", "overlap", { reason: "scope overlaps t3 (opencode/glm-5.3)" }),
    ],
  }]).split("\n");
  assert.ok(out.includes("    t4  accept  Task t4"), "the owner's waits stay where they are");
  assert.ok(out.includes("      next: atelier accept t4 --project demo"));
  assert.equal(out.filter((l) => l.includes("name overlapping paths")).length, 2, "one line per pair");
  assert.ok(out.includes("    t1 and t2 name overlapping paths"));
  assert.ok(out.includes("    t1 and t3 name overlapping paths"));
  const heading = out.indexOf("  Overlapping scopes");
  const lastWait = out.indexOf("      next: atelier accept t4 --project demo");
  assert.ok(heading > lastWait, "the pairs print after every wait that needs the owner");
  assert.ok(out.includes("    Expect a merge conflict when the second lands; nothing waits on you."));
});

test("a pair seen from both sides is printed once", () => {
  const out = formatStatus([{
    name: "demo",
    items: [item("t1", "claimed", { owner: "claude-code/opus-5.5" }), item("t2", "claimed", { owner: "codex/gpt-6" })],
    inbox: [
      entry("t1", "overlap", { reason: "scope overlaps t2 (codex/gpt-6)" }),
      entry("t2", "overlap", { reason: "scope overlaps t1 (claude-code/opus-5.5)" }),
    ],
  }]).split("\n");
  assert.equal(out.filter((l) => l.includes("name overlapping paths")).length, 1);
  assert.ok(out.includes("    t1 and t2 name overlapping paths"));
});

test("an overlap whose reason names no pair stays a plain decision, so nothing the server says is lost", () => {
  const out = formatStatus([{
    name: "demo",
    items: [item("t1", "claimed", { owner: "claude-code/opus-5.5" }), item("t2", "claimed", { owner: "codex/gpt-6" })],
    inbox: [
      entry("t1", "overlap", { reason: "scope overlaps t2 (codex/gpt-6)" }),
      entry("t7", "overlap", { reason: "its paths are shared with other live work" }),
    ],
  }]).split("\n");
  assert.ok(out.includes("    t1 and t2 name overlapping paths"), "the pair still stands under its heading");
  const wait = out.indexOf("  Waiting for you");
  const said = out.indexOf("    t7  overlap  Task t7");
  assert.ok(said > wait, "the entry stands with the owner's decisions");
  assert.ok(out.includes("      its paths are shared with other live work"), "its reason is shown");
  assert.ok(!out.some((l) => l.includes("next:")), "an overlap still offers no command");
});

test("a project whose only entries are overlaps says nothing waits on the owner, then lists the scopes", () => {
  const out = formatStatus([{
    name: "demo",
    items: [item("t1", "open"), item("t2", "open")],
    inbox: [entry("t1", "overlap", { reason: "scope overlaps t2 (unowned)" })],
  }]).split("\n");
  assert.ok(!out.includes("  Nothing waiting."), "the bare idle line is gone");
  const idle = out.indexOf("  Nothing waiting on you.");
  const heading = out.indexOf("  Overlapping scopes");
  const pair = out.indexOf("    t1 and t2 name overlapping paths");
  assert.ok(idle > -1 && idle < heading && heading < pair, "the idle line, the heading, then the scopes");
});

test("--json carries the sorted pairs, each once, beside an unchanged inbox", () => {
  const read = statusJson([{
    name: "demo",
    items: [item("t1", "claimed"), item("t2", "claimed"), item("t3", "claimed")],
    inbox: [
      entry("t2", "overlap", { reason: "scope overlaps t1 (unowned)" }),
      entry("t1", "overlap", { reason: "scope overlaps t3 (unowned)" }),
      entry("t3", "overlap", { reason: "scope overlaps t1 (unowned)" }),
      entry("t9", "accept", { project: "other" }),
    ],
  }]);
  assert.deepEqual(read[0].overlaps, [["t1", "t2"], ["t1", "t3"]]);
  assert.equal(read[0].inbox.length, 3, "the inbox itself is unchanged");
});

test("a status with no overlaps prints no heading", () => {
  const out = formatStatus([{ name: "demo", items: [item("t1", "submitted", { owner: "claude-code/opus-5.5" })], inbox: [entry("t1", "accept")] }]);
  assert.ok(!out.includes("Overlapping scopes"));
});

// The queue and the runner offers (t240): each open review request waits with
// the runner work, naming its reviewer, and a queued job no live runner
// offers says it can never be claimed — a mismatch, not a wait.
test("with the queue and the runners' offers, open reviews wait with the runner work and unoffered jobs say so", () => {
  const now = new Date("2026-10-07T12:00:00.000Z");
  const offers = [
    { runner: "home:studio", kind: "home", jobs: ["build", "plan", "review"], agents: [{ agent: "opencode", models: ["glm-5.3"] }], at: now.toISOString() },
  ];
  const review = (agent, model) => ({ to: "home", agent, model, by: "atelier/orchestrator", at: now.toISOString(), note: "", job: "review" });
  const queue = [
    { project: "demo", item: { id: "t7", title: "Task t7", dispatch: review("claude-code", "fable-5.1") } },
    { project: "other", item: { id: "t9", title: "Elsewhere", dispatch: review("antigravity", "gemini-3.1-pro") } },
  ];
  const out = formatStatus([{
    name: "demo",
    items: [item("t3", "open", { dispatch: { to: "home", agent: "codex", model: "gpt-6-astra", by: "owner", at: now.toISOString(), note: "" } }), item("t4", "open", { dispatch: { to: "home", agent: "opencode", model: "glm-5.3", by: "owner", at: now.toISOString(), note: "" } })],
    inbox: [],
  }], { queue, offers, now }).split("\n");
  assert.ok(out.includes("    t3  for home codex/gpt-6-astra  Task t3"));
  assert.ok(out.includes("      No live runner can take it: home:studio offers build as opencode/glm-5.3."));
  assert.ok(out.includes("    t4  for home opencode/glm-5.3  Task t4"), "a job a live runner offers says no more");
  assert.ok(out.includes("    t7  review by claude-code/fable-5.1  Task t7"));
  assert.ok(out.includes("      No live runner can take it: home:studio offers review as opencode/glm-5.3."));
  assert.ok(!out.some((l) => l.includes("t9")), "another project's review waits in its own section");
  // Without the offers, the reviews still wait and nothing is judged.
  const unread = formatStatus([{ name: "demo", items: [], inbox: [] }], { queue, now }).split("\n");
  assert.ok(unread.includes("    t7  review by claude-code/fable-5.1  Task t7"));
  assert.ok(!unread.some((l) => l.includes("No live runner")));
  // A project with nothing but a queued review no longer says nothing waits.
  assert.ok(!formatStatus([{ name: "demo", items: [], inbox: [] }], { queue, offers, now }).includes("Nothing waiting."));
});

// `atelier status --project demo` against a stand-in server, with the CLI's
// cache pointed at a temp folder, so the On this Mac section reads real git
// in real workspaces. No checkout is registered, so the run reads the
// standing, the project's tasks and the landing lease and nothing else.
const cli = resolve("cli/atelier.mjs");
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@x.test", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@x.test" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
const gitAny = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });

// A workspace of one file per commit, as claim's clone would sit: on main,
// clean, with its commits in the order given.
function workspace(path, commits) {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q", "-b", "main");
  for (const [name, text] of commits) {
    writeFileSync(join(path, name), text);
    git(path, "add", ".");
    git(path, "commit", "-q", "-m", name);
  }
  return path;
}

const STANDING = {
  project: { name: "demo", title: "Demo project", repo: "demo" },
  generatedAt: "2026-10-06T10:46:12.000Z",
  live: [], waiting: [], queued: [], merged: [], handoffs: [], controlPlane: null, checks: [], partial: [],
};

async function runLocal(t, setup, argv) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-on-this-mac-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cache = join(dir, "cache");
  mkdirSync(cache);
  const state = setup({ dir, cache, work: join(cache, "work", "demo") }) ?? {};
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    let status = 200, body;
    if (req.url === "/api/projects/demo/standing") body = STANDING;
    else if (req.url === "/api/projects/demo") body = { project: STANDING.project, items: state.items ?? [], events: [] };
    else if (req.url === "/api/projects/demo/landing-lease") {
      if (state.noLeaseRoute) { status = 404; body = { error: "not_found", detail: "no such route" }; }
      else body = { lease: state.lease ?? null };
    } else { status = 404; body = { error: "unexpected", detail: `${req.method} ${req.url}` }; }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  writeFileSync(join(dir, "config.json"), JSON.stringify({ server: "x", owner: "owner", projects: {} }));
  const child = spawn(process.execPath, [cli, ...(argv ?? ["status", "--project", "demo"])], {
    cwd: dir, env: { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_CACHE: cache, ATELIER_TOKEN: "test-token", ATELIER_ACTOR: "owner", ATELIER_SERVER: `http://127.0.0.1:${server.address().port}` },
  });
  let output = ""; child.stdout.on("data", (s) => output += s); child.stderr.on("data", (s) => output += s);
  const code = await new Promise((done) => child.on("close", done));
  return { code, output, seen, cache };
}

// One workspace per way a session can leave it, plus a task with no
// workspace here, which the section must leave out.
function leaveWorkspaces(work) {
  const uncommitted = workspace(join(work, "t1"), [["a.txt", "one\n"]]);
  writeFileSync(join(uncommitted, "a.txt"), "one and a bit\n");
  mkdirSync(join(uncommitted, ".scratch"), { recursive: true });
  writeFileSync(join(uncommitted, ".scratch", "probe.txt"), "");
  // A tracked file under .scratch/ whose name Git quotes, for its space, is
  // still left out when it changes.
  const quoted = join(uncommitted, ".scratch", "a probe with spaces.txt");
  writeFileSync(quoted, "first\n");
  git(uncommitted, "add", "-f", quoted); git(uncommitted, "commit", "-q", "-m", "scratch");
  writeFileSync(quoted, "changed\n");
  const unpushed = workspace(join(work, "t2"), [["a.txt", "one\n"], ["b.txt", "two\n"]]);
  const merging = workspace(join(work, "t3"), [["a.txt", "one\n"]]);
  git(merging, "checkout", "-q", "-b", "other");
  writeFileSync(join(merging, "a.txt"), "the other side\n");
  git(merging, "add", "."); git(merging, "commit", "-q", "-m", "other side");
  git(merging, "checkout", "-q", "main");
  writeFileSync(join(merging, "a.txt"), "this side\n");
  git(merging, "add", "."); git(merging, "commit", "-q", "-m", "this side");
  gitAny(merging, "merge", "--no-ff", "-m", "merge", "other");
  const message = workspace(join(work, "t4"), [["a.txt", "one\n"]]);
  writeFileSync(join(message, "COMMIT_MSG.txt"), "t4: the change\n");
  workspace(join(work, "t5"), [["a.txt", "one\n"]]);
  workspace(join(work, "t6"), [["a.txt", "one\n"]]);
  workspace(join(work, "t8"), [["a.txt", "one\n"]]);
  return {
    t1: git(uncommitted, "rev-parse", "HEAD"),
    t2: [git(unpushed, "rev-parse", "HEAD~1"), null],
    t3: git(merging, "rev-parse", "HEAD"),
    t4: git(message, "rev-parse", "HEAD"),
    t5: git(join(work, "t5"), "rev-parse", "HEAD"),
  };
}

const itemsOf = (heads) => [
  { id: "t1", head: heads.t1, base: null },
  // t2 has no head the server observed, so its unpushed commits are counted
  // from the fork point.
  { id: "t2", head: heads.t2[1], base: heads.t2[0] },
  { id: "t3", head: heads.t3, base: null },
  { id: "t4", head: heads.t4, base: null },
  { id: "t5", head: heads.t5, base: null },
  { id: "t9", head: null, base: null },
  // Closed tasks' workspaces are leftovers: counted, never listed.
  { id: "t6", head: null, base: null, state: "merged" },
  { id: "t8", head: null, base: null, state: "abandoned" },
];

test("On this Mac gives each workspace one line, and a task with no workspace here is left out", async (t) => {
  const r = await runLocal(t, ({ work }) => ({ items: itemsOf(leaveWorkspaces(work)) }));
  assert.equal(r.code, 0, r.output);
  assert.ok(r.output.includes("\nOn this Mac:\n"), r.output);
  assert.ok(r.output.includes("  t1  1 path with uncommitted changes\n"), r.output);
  assert.ok(r.output.includes("  t2  1 commit not pushed to its fork\n"), r.output);
  assert.ok(r.output.includes("  t3  1 path with uncommitted changes; a merge is in progress, in conflict: a.txt\n"), r.output);
  assert.ok(r.output.includes("  t4  1 path with uncommitted changes; COMMIT_MSG.txt waiting to be committed\n"), r.output);
  assert.ok(r.output.includes("  t5  clean, pushed\n"), r.output);
  assert.ok(!r.output.includes("t9"), "a task with no workspace here is left out");
  assert.ok(!/  t[68]  /.test(r.output), "a merged or abandoned task's workspace is not listed");
  assert.ok(r.output.includes("  2 workspaces of merged or abandoned tasks left here; atelier gc --project demo previews removing them\n"), r.output);
  assert.ok(r.output.includes("  Landing: no landing is running on this Mac; the server's landing lease is held by no one.\n"), r.output);
});

test("the same facts are in --json, and no local section at all when no task has a workspace here", async (t) => {
  const r = await runLocal(t, ({ work }) => ({ items: itemsOf(leaveWorkspaces(work)) }), ["status", "--project", "demo", "--json"]);
  assert.equal(r.code, 0, r.output);
  const read = JSON.parse(r.output);
  const byId = Object.fromEntries(read.local.tasks.map((x) => [x.id, x]));
  assert.deepEqual(byId.t1, { id: "t1", uncommitted: 1, unpushed: 0, merging: false, conflicts: [], commitMessage: false });
  assert.deepEqual(byId.t2, { id: "t2", uncommitted: 0, unpushed: 1, merging: false, conflicts: [], commitMessage: false });
  assert.deepEqual(byId.t3, { id: "t3", uncommitted: 1, unpushed: 0, merging: true, conflicts: ["a.txt"], commitMessage: false });
  assert.deepEqual(byId.t4, { id: "t4", uncommitted: 1, unpushed: 0, merging: false, conflicts: [], commitMessage: true });
  assert.deepEqual(byId.t5, { id: "t5", uncommitted: 0, unpushed: 0, merging: false, conflicts: [], commitMessage: false });
  assert.equal(byId.t9, undefined, "a task with no workspace here is left out of local");
  assert.deepEqual(read.local.landing, { lock: false, lease: null });
  const empty = await runLocal(t, () => ({}), ["status", "--project", "demo", "--json"]);
  assert.equal(empty.code, 0, empty.output);
  assert.equal("local" in JSON.parse(empty.output), false, "no local field when no task has a workspace here");
  assert.deepEqual(empty.seen, ["GET /api/projects/demo/standing"], "nothing else is read when there is nothing local");
});

// The kernel lock queue.sh holds while it lands: flock on Linux, lockf on macOS.
const LOCK = () => process.platform === "darwin"
  ? { holder: (file, rest) => ["lockf", [file, ...rest]], probe: (file) => ["lockf", ["-t", "0", file, "true"]] }
  : { holder: (file, rest) => ["flock", [file, ...rest]], probe: (file) => ["flock", ["-n", file, "true"]] };

test("a held landing lock is reported as a landing running, with the server's lease; a missing one as none", async (t) => {
  const lease = { item: "t2", holder: "pavi", at: "2026-10-06T09:00:00.000Z" };
  const r = await runLocal(t, ({ cache, work }) => {
    const heads = leaveWorkspaces(work);
    const lock = join(cache, "landing-demo.lock");
    writeFileSync(lock, "");
    const [tool, argv] = LOCK().holder(lock, ["sleep", "30"]);
    const child = spawn(tool, argv, { stdio: "ignore" });
    t.after(() => { child.kill(); });
    // Wait until the kernel lock is visibly held before the CLI looks.
    const [pt, pa] = LOCK().probe(lock);
    for (let i = 0; i < 100 && spawnSync(pt, pa).status === 0; i++) spawnSync(pt, pa);
    return { items: itemsOf(heads), lease };
  });
  assert.equal(r.code, 0, r.output);
  assert.ok(r.output.includes("  Landing: a landing is running on this Mac; the server's landing lease is held by pavi for t2 since 2026-10-06 09:00 UTC.\n"), r.output);
});

test("a lock file no landing holds, as queue.sh leaves it, means no landing is running", async (t) => {
  const r = await runLocal(t, ({ cache, work }) => {
    const heads = leaveWorkspaces(work);
    writeFileSync(join(cache, "landing-demo.lock"), "");
    return { items: itemsOf(heads) };
  });
  assert.equal(r.code, 0, r.output);
  assert.ok(r.output.includes("  Landing: no landing is running on this Mac; the server's landing lease is held by no one.\n"), r.output);
});

test("a workspace that is not a Git folder is reported as unreadable, and a lease the server will not serve says so", async (t) => {
  const r = await runLocal(t, ({ work }) => {
    mkdirSync(join(work, "t7"), { recursive: true });
    writeFileSync(join(work, "t7", "not-a-repo.txt"), "no .git here\n");
    const heads = leaveWorkspaces(work);
    return { items: [...itemsOf(heads), { id: "t7", head: null, base: null }], noLeaseRoute: true };
  });
  assert.equal(r.code, 0, r.output);
  assert.ok(r.output.includes("  t7  its workspace cannot be read: not a Git repository\n"), r.output);
  assert.ok(r.output.includes("the server's landing lease could not be read"), r.output);
});

// The runners section (t246): what plan routing could pick from, as the
// server recorded each runner's last ask.
const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const ask = (runner, agents, secondsAgo, jobs) =>
  ({ runner, kind: runner.startsWith("cloud") ? "cloud" : "home", agents, jobs, at: new Date(NOW - secondsAgo * 1000).toISOString() });

test("a runner is live while it asked within the offer window; a line says who offered what and when", () => {
  const studio = ask("home:studio", [{ agent: "claude-code", models: ["opus-5.5", "sonnet-5.5"] }], 30, ["build", "plan", "review"]);
  assert.ok(isLive(studio, NOW));
  assert.equal(runnerLine(studio, NOW), "home:studio  live, asked 30s ago  offers claude-code/opus-5.5, claude-code/sonnet-5.5  jobs: build, plan, review");
  const gone = ask("home:laptop", [{ agent: "zcode", models: ["glm-5.3"] }], OFFER_LIVE_MS / 1000 + 60 * 60);
  assert.equal(isLive(gone, NOW), false);
  assert.equal(runnerLine(gone, NOW), "home:laptop  not live, last asked 3h ago  offers zcode/glm-5.3");
  // A runner that offers no model says so, and an unreadable time is not live.
  assert.equal(runnerLine({ ...studio, agents: [] }, NOW), "home:studio  live, asked 30s ago  offers no model  jobs: build, plan, review");
  assert.equal(isLive({ ...studio, at: "not a time" }, NOW), false);
  // A runner busy on a task asks again only when it ends, so an hour and a half
  // since its last ask is still live (OFFER_LIVE_MS).
  assert.ok(isLive(ask("home:busy", [], 90 * 60), NOW));
});

test("the runners section lists live runners first, and formatStatus appends it once, after the projects", () => {
  const lines = formatRunners([
    ask("cloud:atelier", [{ agent: "codex", models: ["gpt-6-astra"] }], 2 * 60),
    ask("home:studio", [{ agent: "claude-code", models: ["opus-5.5"] }], 30),
  ], NOW);
  assert.deepEqual(lines, [
    "Runners:",
    "  cloud:atelier  live, asked 2m ago  offers codex/gpt-6-astra",
    "  home:studio  live, asked 30s ago  offers claude-code/opus-5.5",
  ]);
  // Stale runners stand after the live ones, whatever their names.
  const ordered = formatRunners([
    ask("home:zulu", [{ agent: "zcode", models: ["glm-5.3"] }], OFFER_LIVE_MS / 1000 + 9 * 60),
    ask("home:alpha", [{ agent: "opencode", models: ["qwen3-coder"] }], 60),
  ], NOW);
  assert.deepEqual(ordered, [
    "Runners:",
    "  home:alpha  live, asked 1m ago  offers opencode/qwen3-coder",
    "  home:zulu  not live, last asked 2h ago  offers zcode/glm-5.3",
  ]);
  const out = formatStatus(
    [{ name: "demo", items: [item("t3", "open", { dispatch: { to: "home", agent: "codex", model: "gpt-6" } })], inbox: [] }],
    { offers: [{ runner: "home:studio", kind: "home", agents: [{ agent: "claude-code", models: ["opus-5.5"] }], at: new Date().toISOString() }] },
  ).split("\n");
  assert.ok(out.includes("demo"));
  assert.equal(out.slice(-2)[0], "Runners:");
  assert.match(out.slice(-2)[1], /^  home:studio  live, asked \d+s ago  offers claude-code\/opus-5\.5$/);
  // Without offers there is no section, as a server too old to have them.
  assert.ok(!formatStatus([{ name: "demo", items: [], inbox: [] }]).includes("Runners:"));
  assert.ok(!formatStatus([{ name: "demo", items: [], inbox: [] }], { offers: [] }).includes("Runners:"), "no runner recorded yet says nothing");
});
