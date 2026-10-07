import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

import { ROUTE_LEVEL } from "../src/route-level.ts";

// atelier land (t187) against a stand-in server and local bare repositories,
// as the other CLI tests run merge: the landing lease refuses a second
// landing naming who holds it and since when, a conflict stops with the
// files named and the merge left in the workspace, a clean landing merges
// main, regenerates the project's fixtures, pushes, checks, waits for the
// review verdict, accepts and merges, --dry-run changes nothing, and a
// server whose route level is lower than the CLI's, or none at all, refuses
// naming both levels and saying to deploy, while a different commit at the
// CLI's level passes.

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function root(t) { const p = mkdtempSync(join(tmpdir(), "atelier-landcmd-")); t.after(() => rmSync(p, { recursive: true, force: true })); return p; }

// The owner's checkout, the baseline, and each task's fork and workspace,
// served by a stand-in ledger that answers from `box`: the items' states, the
// landing lease, the server's version (route level and commit), whether the
// gate needs a review (the reviewer approves, or rejects when `approve` is
// false, on the first poll after the request; a request naming a reviewer
// with `wanted` is made even where the gate needs none, as the server does),
// and every request made, so a test can say what a landing
// changed.
async function landFixture(t, { mainChange = null, taskChange = "task\n", conflict = false } = {}) {
  const p = root(t), seed = join(p, "seed"), baseline = join(p, "baseline.git"), checkout = join(p, "checkout"), config = join(p, "config"), cache = join(p, "cache");
  mkdirSync(seed); mkdirSync(config);
  git(seed, "init", "-b", "main"); git(seed, "config", "user.name", "Fixture"); git(seed, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(seed, "work.txt"), "base\n"); git(seed, "add", "."); git(seed, "commit", "-m", "Initial");
  git(p, "clone", "--bare", seed, baseline); git(p, "clone", baseline, checkout);
  for (const dir of [checkout]) { git(dir, "config", "user.name", "Fixture"); git(dir, "config", "user.email", "fixture@example.invalid"); }
  const forkHead = (id) => { try { return git(p, "--git-dir", join(p, `fork-${id}.git`), "rev-parse", "main"); } catch { return null; } };
  const box = {
    states: {}, reviews: { t1: [], t2: [] }, lease: null, version: null, routeLevel: ROUTE_LEVEL,
    review: { needed: true, reviewer: "codex/gpt-6-astra", approve: true, pending: false, at: null },
    requests: [], regen: "echo generated > gen-fixtures.txt",
  };
  // The tasks fork from the baseline before main moves, so a landing has
  // main's commits to merge; each has a workspace in the cache's layout.
  for (const id of ["t1", "t2"]) {
    const fork = join(p, `fork-${id}.git`), workspace = join(cache, "work", "proj", id);
    git(p, "clone", "--bare", baseline, fork); mkdirSync(dirname(workspace), { recursive: true }); git(p, "clone", fork, workspace);
    for (const dir of [workspace]) { git(dir, "config", "user.name", "Fixture"); git(dir, "config", "user.email", "fixture@example.invalid"); }
    for (const [key, value] of Object.entries({ project: "proj", item: id, actor: "codex/test", branch: "main" })) git(workspace, "config", `atelier.${key}`, value);
    writeFileSync(join(workspace, "work.txt"), taskChange); git(workspace, "add", "."); git(workspace, "commit", "-m", `Task ${id}`); git(workspace, "push", "-q", "origin", "main");
    box.states[id] = "submitted";
  }
  // A commit on main after the tasks forked, so a landing has main to merge.
  let mainCommit = null;
  if (mainChange) {
    writeFileSync(join(checkout, mainChange.file), mainChange.text); git(checkout, "add", "."); git(checkout, "commit", "-m", mainChange.message);
    git(checkout, "push", "-q", "origin", "main");
    mainCommit = git(checkout, "rev-parse", "HEAD");
  }
  const repoHead = git(resolve("."), "rev-parse", "HEAD");
  const detail = (id) => {
    const head = forkHead(id);
    const reviews = id === "t1" && box.review.pending ? (box.reviews.t1.push({ by: box.review.reviewer, approve: box.review.approve, head, note: box.review.approve ? "Land fixture approves." : "Land fixture rejects.", at: new Date().toISOString() }), box.review.pending = false, box.reviews.t1) : box.reviews[id];
    const state = box.states[id];
    return {
      item: { id, title: `Fixture ${id}`, state, owner: "codex/test", head, acceptedHead: state === "accepted" || state === "merged" ? head : null },
      policy: { checks: ["exit 0"], protected: ["work.txt"], regenerate: box.regen },
      gate: { ready: true, outOfScope: [], blockers: [] }, evidence: [], reviews, events: [],
    };
  };
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const url = req.url;
    box.requests.push({ method: req.method, path: url, body });
    const item = /\/items\/(t\d+)/.exec(url)?.[1];
    const head = item ? forkHead(item) : null;
    let answer = item ? detail(item) : {};
    const fail = (status, error, detailText) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ error, detail: detailText })); };
    if (url === "/api/version") answer = { commit: box.version ?? repoHead, ...(box.routeLevel === null ? {} : { routeLevel: box.routeLevel }) };
    else if (url === "/api/projects/proj/landing-lease") {
      if (req.method === "GET") answer = { lease: box.lease };
      else if (body.cancel === true) { box.lease = null; answer = { held: true }; }
      else {
        // Another queued landing takes the lease first, once, when a test asks.
        if (box.takenFirst) { box.lease = box.takenFirst; box.takenFirst = null; }
        if (box.lease && box.lease.item !== item && !["merged", "abandoned"].includes(box.states[box.lease.item])) return fail(409, "landing_lease", `${box.lease.holder} has been landing ${box.lease.item} since ${box.lease.at}; one landing runs at a time in this project`);
        box.lease = { item, holder: "owner", at: new Date().toISOString() };
        answer = { item: { id: item, state: box.states[item] } };
      }
    } else if (url.endsWith("/base-token") || url === "/api/projects/proj/baseline-token") answer = { remote: baseline, token: "fixture", defaultBranch: "main" };
    else if (url.endsWith("/read-token")) answer = { remote: join(p, `fork-${item}.git`), token: "fixture", head, defaultBranch: "main" };
    else if (url.endsWith("/push")) { box.states[item] = "claimed"; answer = { ...answer.item, head }; }
    else if (url.endsWith("/evidence")) answer = item ? { ...detail(item), evidence: [] } : {};
    else if (url.endsWith("/submit")) { box.states[item] = "submitted"; answer = detail(item); }
    else if (url.endsWith("/review-request")) {
      if (!box.review.needed && !(body.wanted === true && body.reviewer)) answer = { needed: false, reason: "the gate counts an independent approval already" };
      else { box.review.reviewer = body.reviewer ?? box.review.reviewer; box.review.pending = true; box.review.at = new Date().toISOString(); answer = { needed: true, requested: true, reason: "a protected change needs an independent review", at: box.review.at, head, reviewer: body.reviewer ?? box.review.reviewer }; }
    }     else if (url.endsWith("/accept")) {
      assert.equal(body.head, head);
      box.states[item] = "accepted"; answer = detail(item).item;
    } else if (url.endsWith("/landing")) answer = {};
    else if (url.endsWith("/merged")) { box.states[item] = "merged"; answer = { ...answer.item, state: "merged" }; }
    else if (url.endsWith("/land")) answer = { item: { id: item, state: box.states[item] } };
    else if (req.method === "POST") answer = {};
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(answer));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok)); t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(config, "config.json"), JSON.stringify({ server: url, owner: "owner", projects: { proj: { path: checkout, branch: "main" } } }));
  const run = async (cwd, ...args) => {
    const child = spawn(process.execPath, [resolve("cli/atelier.mjs"), ...args, "--project", "proj"], { cwd, env: { ...process.env, ATELIER_CONFIG_DIR: config, ATELIER_TOKEN: "fixture", ATELIER_CACHE: cache, ATELIER_SERVER: url, ...fx.env } });
    let output = ""; child.stdout.on("data", (s) => { output += s; fx.onOutput?.(output); }); child.stderr.on("data", (s) => output += s);
    const status = await new Promise((ok) => child.on("close", ok));
    return { status, output };
  };
  const fx = { p, baseline, checkout, workspace: (id) => join(cache, "work", "proj", id), fork: (id) => join(p, `fork-${id}.git`), forkHead, mainCommit, box, run, env: {}, onOutput: null, posts: (suffix) => box.requests.filter((r) => r.method === "POST" && r.path.endsWith(suffix)) };
  return fx;
}

test("a clean landing takes the lease, merges main, regenerates, checks, waits for the review, accepts and merges", async (t) => {
  const f = await landFixture(t, { mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  const before = { fork: f.forkHead("t1"), checkout: git(f.checkout, "rev-parse", "HEAD"), baseline: git(f.p, "--git-dir", f.baseline, "rev-parse", "main") };
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  // The workspace holds a merge of main and the regeneration commit.
  const head = git(f.workspace("t1"), "rev-parse", "HEAD");
  assert.match(git(f.workspace("t1"), "log", "--format=%s", "-3"), /Regenerate after merging main into t1/);
  assert.match(git(f.workspace("t1"), "log", "--format=%s", "-3"), /Merge main into t1/);
  assert.equal(readFileSync(join(f.workspace("t1"), "gen-fixtures.txt"), "utf8"), "generated\n");
  assert.notEqual(head, before.fork);
  // The registered checkout and the baseline hold a merge commit with the
  // task's head as its second parent.
  const merged = git(f.checkout, "rev-parse", "HEAD");
  const parents = git(f.checkout, "rev-list", "--parents", "-n", "1", "HEAD").split(" ");
  assert.equal(parents[1], before.checkout); assert.equal(parents[2], head);
  assert.equal(git(f.p, "--git-dir", f.baseline, "rev-parse", "main"), merged);
  assert.equal(f.box.states.t1, "merged");
  // The lease was taken for t1 and released at the end.
  assert.ok(f.posts("/landing-lease").some((x) => x.body.item === "t1"));
  assert.ok(f.posts("/landing-lease").some((x) => x.body.cancel === true));
  assert.equal(f.box.lease, null);
  // The review was requested and the verdict waited for.
  const ask = f.posts("/review-request").at(-1);
  assert.equal(ask.body.reviewer, undefined); assert.equal(ask.path, "/api/projects/proj/items/t1/review-request");
  // Each step is recorded, in order, with its duration and the commits from main.
  const steps = f.posts("/land").map((x) => x.body.step);
  assert.deepEqual(steps, ["lease", "merge", "regenerate", "push", "check", "submit", "review", "accept", "merged"]);
  const events = f.posts("/land");
  for (const e of events) assert.ok(Number.isFinite(e.body.ms) && e.body.ms >= 0, `${e.body.step} records no duration`);
  assert.deepEqual(events.find((e) => e.body.step === "merge").body.fromMain, [f.mainCommit]);
  assert.deepEqual(events.find((e) => e.body.step === "regenerate").body, { step: "regenerate", ms: events.find((e) => e.body.step === "regenerate").body.ms, command: f.box.regen, changed: true });
  assert.equal(events.find((e) => e.body.step === "review").body.verdict, "approve");
  assert.equal(events.find((e) => e.body.step === "merged").body.mergeCommit, merged);
});

test("--reviewer waits for that review and lands on approval even where the gate needs none", async (t) => {
  const f = await landFixture(t);
  f.box.review.needed = false;
  const r = await f.run(f.checkout, "land", "t1", "--reviewer", "antigravity/gemini-3.1-pro");
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(f.posts("/review-request").at(-1).body, { reviewer: "antigravity/gemini-3.1-pro", wanted: true });
  assert.match(r.output, /Review requested for antigravity\/gemini-3\.1-pro/);
  assert.match(r.output, /antigravity\/gemini-3\.1-pro approved t1/);
  assert.equal(f.posts("/land").find((x) => x.body.step === "review").body.verdict, "approve");
  assert.equal(f.box.states.t1, "merged");
});

test("--reviewer stops the landing on a rejection even where the gate needs no review", async (t) => {
  const f = await landFixture(t);
  f.box.review.needed = false; f.box.review.approve = false;
  const before = git(f.checkout, "rev-parse", "HEAD");
  const r = await f.run(f.checkout, "land", "t1", "--reviewer", "antigravity/gemini-3.1-pro");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /antigravity\/gemini-3\.1-pro rejected t1/);
  assert.equal(f.posts("/accept").length, 0);
  assert.equal(f.posts("/merged").length, 0);
  assert.equal(f.box.states.t1, "submitted");
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), before);
  assert.equal(f.posts("/land").find((x) => x.body.step === "review").body.verdict, "reject");
  assert.equal(f.box.lease, null);
});

test("without --reviewer a gate that needs no review says why and does not claim to accept", async (t) => {
  const f = await landFixture(t);
  f.box.review.needed = false;
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(f.posts("/review-request").at(-1).body, {});
  assert.match(r.output, /No review was requested: the gate counts an independent approval already\./);
  assert.doesNotMatch(r.output, /accepting/);
});

test("--no-review leaves the task submitted, accepts and merges nothing, and releases the lease", async (t) => {
  const f = await landFixture(t);
  const before = git(f.checkout, "rev-parse", "HEAD");
  const r = await f.run(f.checkout, "land", "t1", "--no-review");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /left for you to settle the review by hand/);
  assert.equal(f.box.states.t1, "submitted");
  assert.equal(f.posts("/accept").length, 0);
  assert.equal(f.posts("/merged").length, 0);
  assert.equal(f.posts("/review-request").length, 0);
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), before);
  assert.equal(f.box.lease, null);
  assert.deepEqual(f.posts("/land").map((x) => x.body.step), ["lease", "merge", "regenerate", "push", "check", "submit", "review"]);
  const dry = await f.run(f.checkout, "land", "t2", "--no-review", "--dry-run");
  assert.doesNotMatch(dry.output, /accept t2 at the pushed head/);
});

test("the lease refuses a second landing with who holds it and since when", async (t) => {
  const f = await landFixture(t);
  const since = "2026-10-06T09:30:00.000Z";
  f.box.lease = { item: "t2", holder: "owner", at: since };
  const before = git(f.workspace("t1"), "rev-parse", "HEAD");
  f.box.requests.length = 0;
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /owner has been landing t2 since 2026-10-06 09:30 UTC/);
  assert.match(r.output, /atelier land t1 --wait queues behind it/);
  // Nothing changed: no lease was taken or posted, the workspace did not move.
  assert.ok(f.box.requests.every((x) => !(x.method === "POST" && x.path.endsWith("/landing-lease"))));
  assert.equal(git(f.workspace("t1"), "rev-parse", "HEAD"), before);
  assert.ok(!existsSync(join(f.workspace("t1"), ".git", "MERGE_HEAD")));
  assert.deepEqual(f.posts("/land"), []);
});

// --wait (t223): the landing queues for the lease instead of refusing.
const WAITING = /Waiting behind (\S+)'s landing of (t\d) \(since ([^)]+)\); t1 starts as soon as the lease is free\./g;

test("a lease held for a task that has closed guards nothing, so the landing starts without --wait", async (t) => {
  const f = await landFixture(t);
  f.box.lease = { item: "t2", holder: "owner", at: "2026-10-06T09:30:00.000Z" };
  f.box.states.t2 = "merged";
  const r = await f.run(f.checkout, "land", "t1", "--no-review");
  assert.equal(r.status, 0, r.output);
  assert.doesNotMatch(r.output, /already in progress|Waiting behind/);
  assert.equal(f.box.lease, null);
});

test("--wait queues behind another landing, says whose each time it changes, and starts once the lease is free", async (t) => {
  const f = await landFixture(t);
  f.box.lease = { item: "t2", holder: "owner", at: "2026-10-06T09:30:00.000Z" };
  f.env = { ATELIER_LAND_POLL_MS: "40" };
  let freedAt = null;
  f.onOutput = (out) => {
    const seen = [...out.matchAll(WAITING)].length;
    // The landing of t2 is started again (the lease moves to a new time), then ends.
    if (seen === 1 && f.box.lease?.at === "2026-10-06T09:30:00.000Z") setTimeout(() => { f.box.lease = { item: "t2", holder: "owner", at: "2026-10-06T10:05:00.000Z" }; }, 120);
    if (seen === 2 && freedAt === null) { freedAt = -1; setTimeout(() => { f.box.lease = null; freedAt = f.box.requests.length; }, 120); }
  };
  const r = await f.run(f.checkout, "land", "t1", "--wait", "--no-review");
  assert.equal(r.status, 0, r.output);
  const waits = [...r.output.matchAll(WAITING)].map((m) => m.slice(1));
  assert.deepEqual(waits, [["owner", "t2", "2026-10-06 09:30 UTC"], ["owner", "t2", "2026-10-06 10:05 UTC"]]);
  // It polled while it waited and took the lease only once it was free.
  const takes = f.box.requests.map((x, i) => ({ ...x, i })).filter((x) => x.method === "POST" && x.path.endsWith("/landing-lease") && x.body.item === "t1");
  assert.equal(takes.length, 1);
  assert.ok(freedAt > 0 && takes[0].i >= freedAt, "the lease was taken before it was free");
  assert.ok(f.box.requests.filter((x) => x.method === "GET" && x.path.endsWith("/landing-lease")).length > 3);
  assert.match(r.output, /Landing lease taken for t1/);
  assert.deepEqual(f.posts("/land").map((x) => x.body.step), ["lease", "merge", "regenerate", "push", "check", "submit", "review"]);
  assert.equal(f.box.lease, null);
});

test("--wait queues again when another queued landing takes the lease first", async (t) => {
  const f = await landFixture(t);
  f.box.takenFirst = { item: "t2", holder: "owner", at: "2026-10-06T11:00:00.000Z" };
  f.env = { ATELIER_LAND_POLL_MS: "40" };
  let freeing = false;
  f.onOutput = (out) => {
    if (!freeing && [...out.matchAll(WAITING)].length === 1) { freeing = true; setTimeout(() => { f.box.lease = null; }, 120); }
  };
  const r = await f.run(f.checkout, "land", "t1", "--wait", "--no-review");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /Waiting behind owner's landing of t2 \(since 2026-10-06 11:00 UTC\)/);
  assert.equal(f.posts("/landing-lease").filter((x) => x.body.item === "t1").length, 2);
  assert.equal(f.posts("/land").filter((x) => x.body.step === "lease").length, 1);
  assert.equal(f.box.lease, null);
});

test("--wait asks the refusals again once the lease is free, so a workspace changed while it queued is not landed", async (t) => {
  const f = await landFixture(t);
  f.box.lease = { item: "t2", holder: "owner", at: "2026-10-06T09:30:00.000Z" };
  f.env = { ATELIER_LAND_POLL_MS: "40" };
  let freeing = false;
  f.onOutput = () => {
    if (freeing) return;
    freeing = true;
    writeFileSync(join(f.workspace("t1"), "stray.txt"), "uncommitted\n");
    setTimeout(() => { f.box.lease = null; }, 120);
  };
  const r = await f.run(f.checkout, "land", "t1", "--wait");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /Waiting behind owner's landing of t2/);
  assert.match(r.output, /t1's workspace has uncommitted changes/);
  assert.deepEqual(f.posts("/landing-lease"), []);
  assert.deepEqual(f.posts("/land"), []);
});

test("--wait gives up after its limit with nothing changed, and --dry-run says it would wait", async (t) => {
  const f = await landFixture(t);
  f.box.lease = { item: "t2", holder: "owner", at: "2026-10-06T09:30:00.000Z" };
  const dry = await f.run(f.checkout, "land", "t1", "--wait", "--dry-run");
  assert.equal(dry.status, 0, dry.output);
  assert.match(dry.output, /1\. wait behind owner's landing of t2 \(since 2026-10-06 09:30 UTC\), then take the project's landing lease for t1/);
  const before = git(f.workspace("t1"), "rev-parse", "HEAD");
  f.env = { ATELIER_LAND_POLL_MS: "40", ATELIER_LAND_WAIT_TIMEOUT: "2000" };
  const r = await f.run(f.checkout, "land", "t1", "--wait");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /the landing lease was not free within 2 seconds: owner still holds it for t2\. Nothing was changed/);
  assert.deepEqual(f.posts("/landing-lease"), []);
  assert.deepEqual(f.posts("/land"), []);
  assert.equal(git(f.workspace("t1"), "rev-parse", "HEAD"), before);
});

test("a conflict stops the landing with the files named and the merge left for the owner", async (t) => {
  const f = await landFixture(t, { mainChange: { file: "work.txt", text: "from main\n", message: "Main edits the same file" } });
  const before = { fork: f.forkHead("t1"), baseline: git(f.p, "--git-dir", f.baseline, "rev-parse", "main") };
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /stops on conflicts in:\nwork\.txt/);
  assert.match(r.output, /The merge is left in the workspace for you to resolve/);
  // The merge is in progress in the workspace, nothing was pushed or merged.
  assert.ok(existsSync(join(f.workspace("t1"), ".git", "MERGE_HEAD")));
  assert.equal(f.forkHead("t1"), before.fork);
  assert.equal(git(f.p, "--git-dir", f.baseline, "rev-parse", "main"), before.baseline);
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), before.baseline);
  assert.equal(f.box.states.t1, "submitted");
  assert.deepEqual(f.posts("/push"), []); assert.deepEqual(f.posts("/merged"), []);
  // The step that stopped is recorded, with the file and who resolves it.
  const merge = f.posts("/land").find((x) => x.body.step === "merge");
  assert.equal(merge.body.failed, true); assert.deepEqual(merge.body.conflicts, ["work.txt"]);
  assert.equal(merge.body.resolvedBy, "the project owner, by hand");
  // The lease was taken and released.
  assert.ok(f.posts("/landing-lease").some((x) => x.body.item === "t1"));
  assert.ok(f.posts("/landing-lease").some((x) => x.body.cancel === true));
});

test("--dry-run prints the steps and the refusals without changing anything", async (t) => {
  const f = await landFixture(t, { mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  const before = { workspace: git(f.workspace("t1"), "rev-parse", "HEAD"), fork: f.forkHead("t1"), baseline: git(f.p, "--git-dir", f.baseline, "rev-parse", "main") };
  f.box.requests.length = 0;
  const r = await f.run(f.checkout, "land", "t1", "--dry-run");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /Dry run: atelier land t1 in proj would:/);
  assert.match(r.output, /merge main into t1's workspace/);
  assert.match(r.output, /regenerate the project's fixtures with `echo generated > gen-fixtures\.txt`/);
  assert.match(r.output, /Nothing was changed\./);
  // Reads only: the lease is read, never taken, and nothing that changes state was posted.
  assert.ok(f.box.requests.some((x) => x.method === "GET" && x.path.endsWith("/landing-lease")));
  assert.deepEqual(f.box.requests.filter((x) => x.method === "POST"), []);
  assert.equal(f.box.lease, null);
  assert.equal(git(f.workspace("t1"), "rev-parse", "HEAD"), before.workspace);
  assert.equal(f.forkHead("t1"), before.fork);
  assert.equal(git(f.p, "--git-dir", f.baseline, "rev-parse", "main"), before.baseline);
  // A dry run still refuses a held lease.
  f.box.lease = { item: "t2", holder: "owner", at: "2026-10-06T09:30:00.000Z" };
  const held = await f.run(f.checkout, "land", "t1", "--dry-run");
  assert.equal(held.status, 1, held.output); assert.match(held.output, /has been landing t2 since/);
});

test("a server at the CLI's route level passes whatever commit it runs", async (t) => {
  const f = await landFixture(t, { mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  f.box.version = "f".repeat(40);
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.equal(f.box.states.t1, "merged");
  assert.ok(f.posts("/landing-lease").some((x) => x.body.cancel === true));
});

test("a server a route level lower than the CLI's refuses, naming both levels and saying to deploy", async (t) => {
  const f = await landFixture(t);
  f.box.routeLevel = ROUTE_LEVEL - 1;
  const before = git(f.workspace("t1"), "rev-parse", "HEAD");
  f.box.requests.length = 0;
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, new RegExp(`runs route level ${ROUTE_LEVEL - 1}`));
  assert.match(r.output, new RegExp(`this CLI route level ${ROUTE_LEVEL}`));
  assert.match(r.output, /Deploy the server/);
  assert.deepEqual(f.box.requests.filter((x) => x.method === "POST"), []);
  assert.equal(git(f.workspace("t1"), "rev-parse", "HEAD"), before);
  assert.equal(f.box.lease, null);
});

test("a server that reports no route level refuses, saying to deploy", async (t) => {
  const f = await landFixture(t);
  f.box.routeLevel = null;
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /reports no route level/);
  assert.match(r.output, new RegExp(`this CLI route level ${ROUTE_LEVEL}`));
  assert.match(r.output, /Deploy the server/);
  assert.deepEqual(f.box.requests.filter((x) => x.method === "POST"), []);
  assert.equal(f.box.lease, null);
});
