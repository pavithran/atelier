import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

import { ROUTE_LEVEL } from "../src/route-level.ts";
import { LANDING_LEASE_EXPIRY_MS, landingLeaseLapsed } from "../src/landing-lease.ts";

// atelier land (t187) against a stand-in server and local bare repositories,
// as the other CLI tests run merge: the landing lease refuses a second
// landing naming who holds it and since when, a conflict stops with the
// files named and the merge left in the workspace (unless every conflicted
// file is one the regenerate command rewrites, when either side is taken,
// the command runs and the landing goes on), a clean landing merges
// main, regenerates the project's fixtures, pushes, checks, waits for the
// review verdict, accepts and merges, --dry-run changes nothing, and a
// server whose route level is lower than the CLI's, or none at all, refuses
// naming both levels and saying to deploy, while a different commit at the
// CLI's level passes. The lease never strands the project (t214): a signal
// releases it, the heartbeat renews it, a lapsed lease is taken over and
// named, --release-lease frees it saying which task held it since when, and
// every early refusal of the task holding it offers that command. With --wait
// (t223) the landing queues behind a live lease instead of refusing, asks the
// refusals again once it is free, and gives up after its limit. A landing
// that loses its lease stops (t232): one that slept while another landing
// took the lease over ends without accepting or merging, however it learns
// of the loss, and leaves the lease that took it over where it is.

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
  // `review.approveAfter` is how many polls of the task pass before the
  // reviewer answers (never, when null); `review.claimed` makes the request
  // claimed as soon as it is made, as a review.claimed event. `items` and `queue` answer
  // the project's items and the runner queue, which the wait explains from.
  const box = {
    states: {}, reviews: { t1: [], t2: [] }, lease: null, version: null, routeLevel: ROUTE_LEVEL,
    review: { needed: true, reviewer: "codex/gpt-6-astra", approve: true, pending: false, at: null, approveAfter: 0, claimed: false },
    requests: [], regen: "echo generated > gen-fixtures.txt", items: [], queue: [], renewFails: false,
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
    const due = id === "t1" && box.review.pending && box.review.approveAfter !== null && box.review.approveAfter-- <= 0;
    const reviews = due ? (box.reviews.t1.push({ by: box.review.reviewer, approve: box.review.approve, head, note: box.review.approve ? "Land fixture approves." : "Land fixture rejects.", at: new Date().toISOString() }), box.review.pending = false, box.reviews.t1) : box.reviews[id];
    const state = box.states[id];
    const events = id === "t1" && box.review.claimed && box.review.at ? [{ seq: 1, itemId: id, at: box.review.at, actor: box.review.reviewer, kind: "review.claimed", data: { head, runner: "home:mbp" } }] : [];
    return {
      item: { id, title: `Fixture ${id}`, state, owner: "codex/test", head, acceptedHead: state === "accepted" || state === "merged" ? head : null },
      policy: { checks: ["exit 0"], protected: ["work.txt"], regenerate: box.regen },
      gate: { ready: true, outOfScope: [], blockers: [] }, evidence: [], reviews, events,
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
      // The lease as the server keeps it: a renewal moves renewedAt on, a
      // lease not renewed for the expiry is taken over and named as expired.
      const now = new Date().toISOString();
      if (req.method === "GET") answer = { lease: box.lease };
      else if (body.cancel === true) {
        if (!body.item) return fail(400, "bad_item", "a cancel names the task whose landing lease it releases");
        if (box.lease && box.lease.item !== body.item) return fail(409, "landing_lease", `the landing lease is held for ${box.lease.item}, not ${body.item}: ${box.lease.holder} has been landing ${box.lease.item} since ${box.lease.at.slice(0, 16).replace("T", " ")} UTC, and its lease is left alone. Free it with atelier land ${box.lease.item} --release-lease`);
        answer = { held: !!box.lease, lease: box.lease }; box.lease = null;
      }
      else if (body.renew === true) {
        if (box.renewFails) return fail(503, "unavailable", "the ledger could not be reached");
        if (!box.lease || box.lease.item !== body.item) return fail(409, "no_lease", `the landing lease is held for ${box.lease?.item ?? "nobody"}, not ${body.item}`);
        box.lease = { ...box.lease, renewedAt: now }; answer = { lease: box.lease };
      } else {
        // Another queued landing takes the lease first, once, when a test asks.
        if (box.takenFirst) { box.lease = box.takenFirst; box.takenFirst = null; }
        let expired = null;
        // A lease held for a task that has closed guards nothing, as the
        // server hands it over; one that lapsed is taken over and named.
        if (box.lease && box.lease.item !== body.item && !["merged", "abandoned"].includes(box.states[box.lease.item])) {
          if (!landingLeaseLapsed(box.lease, Date.now())) return fail(409, "landing_lease", `${box.lease.holder} has been landing ${box.lease.item} since ${box.lease.at.slice(0, 16).replace("T", " ")} UTC; one landing runs at a time in this project. Wait for it to finish, run atelier land ${box.lease.item} again to finish or release that landing, or atelier land ${box.lease.item} --release-lease to free the lease`);
          expired = box.lease;
        }
        box.lease = { item: body.item, holder: "owner", at: now, renewedAt: now };
        answer = { item: { id: body.item, state: box.states[body.item] }, expired };
      }
    } else if (url === "/api/projects/proj/items") answer = box.items;
    else if (url === "/api/queue") answer = box.queue; else if (url.endsWith("/base-token") || url === "/api/projects/proj/baseline-token") answer = { remote: baseline, token: "fixture", defaultBranch: "main" };
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
    else if (url.endsWith("/merged")) {
      box.states[item] = "merged"; answer = { ...answer.item, state: "merged" };
      // The moment the server records the merge it treats the merged task's
      // lease as free (landingLive), so a landing queued with --wait takes
      // it — before the landing that finished releases it. A test asks for
      // that take by naming the queued task here.
      if (box.takeOverOnMerged) box.lease = { item: box.takeOverOnMerged, holder: "owner", at: new Date().toISOString(), renewedAt: new Date().toISOString() };
    }
    else if (url.endsWith("/land")) answer = { item: { id: item, state: box.states[item] } };
    else if (req.method === "POST") answer = {};
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(answer));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok)); t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(config, "config.json"), JSON.stringify({ server: url, owner: "owner", projects: { proj: { path: checkout, branch: "main" } } }));
  const run = async (cwd, ...args) => {
    const child = spawn(process.execPath, [resolve("cli/atelier.mjs"), ...args, "--project", "proj"], { cwd, env: { ...process.env, ATELIER_CONFIG_DIR: config, ATELIER_TOKEN: "fixture", ATELIER_CACHE: cache, ATELIER_SERVER: url, ATELIER_LAND_POLL_MS: "50", ...fx.env } });
    let output = ""; child.stdout.on("data", (s) => { output += s; fx.onOutput?.(output); }); child.stderr.on("data", (s) => output += s);
    const status = await new Promise((ok) => child.on("close", ok));
    return { status, output };
  };
  const fx = { p, url, baseline, checkout, workspace: (id) => join(cache, "work", "proj", id), fork: (id) => join(p, `fork-${id}.git`), forkHead, mainCommit, box, run, env: {}, onOutput: null, posts: (suffix) => box.requests.filter((r) => r.method === "POST" && r.path.endsWith(suffix)) };
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
  // Taken this morning and renewed just now: live.
  f.box.lease = { item: "t2", holder: "owner", at: since, renewedAt: new Date().toISOString() };
  const before = git(f.workspace("t1"), "rev-parse", "HEAD");
  f.box.requests.length = 0;
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /owner has been landing t2 since 2026-10-06 09:30 UTC/);
  assert.match(r.output, /atelier land t2 --release-lease/);
  assert.match(r.output, /atelier land t1 --wait queues behind it/);
  // The server decided: the one request for the lease was refused, nothing
  // was released, the lease stands, and the workspace did not move.
  assert.deepEqual(f.posts("/landing-lease").map((x) => x.body), [{ item: "t1" }]);
  assert.equal(f.box.lease.item, "t2");
  assert.equal(git(f.workspace("t1"), "rev-parse", "HEAD"), before);
  assert.ok(!existsSync(join(f.workspace("t1"), ".git", "MERGE_HEAD")));
  assert.deepEqual(f.posts("/land"), []);
});

// --wait (t223): the landing queues for the lease instead of refusing. Each
// lease here is renewed just now, so it is live under t214's expiry: only
// its task's state, or its holder letting it go, frees it.
const WAITING = /Waiting behind (\S+)'s landing of (t\d) \(since ([^)]+)\); t1 starts as soon as the lease is free\./g;

test("a lease held for a task that has closed guards nothing, so the landing starts without --wait", async (t) => {
  const f = await landFixture(t);
  f.box.lease = { item: "t2", holder: "owner", at: "2026-10-06T09:30:00.000Z", renewedAt: new Date().toISOString() };
  f.box.states.t2 = "merged";
  const r = await f.run(f.checkout, "land", "t1", "--no-review");
  assert.equal(r.status, 0, r.output);
  assert.doesNotMatch(r.output, /already in progress|Waiting behind/);
  assert.equal(f.box.lease, null);
});

test("--wait queues behind another landing, says whose each time it changes, and starts once the lease is free", async (t) => {
  const f = await landFixture(t);
  f.box.lease = { item: "t2", holder: "owner", at: "2026-10-06T09:30:00.000Z", renewedAt: new Date().toISOString() };
  f.env = { ATELIER_LAND_POLL_MS: "40" };
  let freedAt = null;
  f.onOutput = (out) => {
    const seen = [...out.matchAll(WAITING)].length;
    // The landing of t2 is started again (the lease moves to a new time), then ends.
    if (seen === 1 && f.box.lease?.at === "2026-10-06T09:30:00.000Z") setTimeout(() => { f.box.lease = { item: "t2", holder: "owner", at: "2026-10-06T10:05:00.000Z", renewedAt: new Date().toISOString() }; }, 120);
    if (seen === 2 && freedAt === null) { freedAt = -1; setTimeout(() => { f.box.lease = null; freedAt = f.box.requests.length; }, 120); }
  };
  const r = await f.run(f.checkout, "land", "t1", "--wait", "--no-review");
  assert.equal(r.status, 0, r.output);
  const waits = [...r.output.matchAll(WAITING)].map((m) => m.slice(1));
  assert.deepEqual(waits, [["owner", "t2", "2026-10-06 09:30 UTC"], ["owner", "t2", "2026-10-06 10:05 UTC"]]);
  // It polled while it waited and took the lease only once it was free (the
  // release at the end names t1 too, t214, and is not a take).
  const takes = f.box.requests.map((x, i) => ({ ...x, i })).filter((x) => x.method === "POST" && x.path.endsWith("/landing-lease") && x.body.item === "t1" && !x.body.cancel && !x.body.renew);
  assert.equal(takes.length, 1);
  assert.ok(freedAt > 0 && takes[0].i >= freedAt, "the lease was taken before it was free");
  assert.ok(f.box.requests.filter((x) => x.method === "GET" && x.path.endsWith("/landing-lease")).length > 3);
  assert.match(r.output, /Landing lease taken for t1/);
  assert.deepEqual(f.posts("/land").map((x) => x.body.step), ["lease", "merge", "regenerate", "push", "check", "submit", "review"]);
  assert.equal(f.box.lease, null);
});

test("--wait queues again when another queued landing takes the lease first", async (t) => {
  const f = await landFixture(t);
  f.box.takenFirst = { item: "t2", holder: "owner", at: "2026-10-06T11:00:00.000Z", renewedAt: new Date().toISOString() };
  f.env = { ATELIER_LAND_POLL_MS: "40" };
  let freeing = false;
  f.onOutput = (out) => {
    if (!freeing && [...out.matchAll(WAITING)].length === 1) { freeing = true; setTimeout(() => { f.box.lease = null; }, 120); }
  };
  const r = await f.run(f.checkout, "land", "t1", "--wait", "--no-review");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /Waiting behind owner's landing of t2 \(since 2026-10-06 11:00 UTC\)/);
  assert.equal(f.posts("/landing-lease").filter((x) => x.body.item === "t1" && !x.body.cancel && !x.body.renew).length, 2);
  assert.equal(f.posts("/land").filter((x) => x.body.step === "lease").length, 1);
  assert.equal(f.box.lease, null);
});

test("--wait asks the refusals again once the lease is free, so a workspace changed while it queued is not landed", async (t) => {
  const f = await landFixture(t);
  f.box.lease = { item: "t2", holder: "owner", at: "2026-10-06T09:30:00.000Z", renewedAt: new Date().toISOString() };
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
  f.box.lease = { item: "t2", holder: "owner", at: "2026-10-06T09:30:00.000Z", renewedAt: new Date().toISOString() };
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
  // The conflict can also go back to the task's builder (t243): the message
  // names the holder and the dispatch that sends the work there.
  assert.match(r.output, new RegExp(`Or send them back to the task's builder, codex/test, to resolve in this workspace: atelier dispatch t1 --job merge-main --agent codex --model test; its runner merges main at ${f.mainCommit.slice(0, 8)} into the workspace again`));
  assert.match(r.output, /and then atelier land t1 again\.$/m);
  // The regeneration was tried and could not settle the conflict, and says so.
  assert.match(r.output, /Taking either side and regenerating did not settle them: the regenerate command left work\.txt as either side had it/);
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
  assert.equal(merge.body.reason, "the regenerate command left work.txt as either side had it");
  // The lease was taken and released.
  assert.ok(f.posts("/landing-lease").some((x) => x.body.item === "t1"));
  assert.ok(f.posts("/landing-lease").some((x) => x.body.cancel === true));
});

test("a conflict only in files the regenerate command rewrites is settled by taking either side and regenerating, and the landing goes on", async (t) => {
  const f = await landFixture(t, { mainChange: { file: "gen-fixtures.txt", text: "from main\n", message: "Main regenerates the fixture" } });
  // The task's own regeneration of the same file, so the two sides conflict in it.
  writeFileSync(join(f.workspace("t1"), "gen-fixtures.txt"), "from task\n");
  git(f.workspace("t1"), "add", "."); git(f.workspace("t1"), "commit", "-m", "Task regenerates the fixture"); git(f.workspace("t1"), "push", "-q", "origin", "main");
  const before = { fork: f.forkHead("t1"), checkout: git(f.checkout, "rev-parse", "HEAD") };
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /taking either side and regenerating with `echo generated > gen-fixtures\.txt`/);
  assert.match(r.output, /took either side and let the command write them again/);
  // The workspace holds the merge, with what the command wrote as the resolution.
  assert.match(git(f.workspace("t1"), "log", "--format=%s", "-3"), /Merge main into t1/);
  assert.equal(readFileSync(join(f.workspace("t1"), "gen-fixtures.txt"), "utf8"), "generated\n");
  // The registered checkout and the baseline hold a merge of the task's head.
  const merged = git(f.checkout, "rev-parse", "HEAD");
  const parents = git(f.checkout, "rev-list", "--parents", "-n", "1", "HEAD").split(" ");
  assert.equal(parents[1], before.checkout);
  assert.equal(git(f.p, "--git-dir", f.baseline, "rev-parse", "main"), merged);
  assert.equal(f.box.states.t1, "merged");
  assert.equal(f.box.lease, null);
  // The whole landing ran, and the merge step records the conflicts it settled and how.
  const events = f.posts("/land");
  assert.deepEqual(events.map((x) => x.body.step), ["lease", "merge", "regenerate", "push", "check", "submit", "review", "accept", "merged"]);
  const merge = events.find((x) => x.body.step === "merge");
  assert.deepEqual(merge.body.conflicts, ["gen-fixtures.txt"]);
  assert.equal(merge.body.resolvedBy, "atelier land, taking either side and regenerating");
  assert.equal(merge.body.failed, undefined);
  // The regeneration had already settled the file, so the second run changed nothing.
  assert.equal(events.find((x) => x.body.step === "regenerate").body.changed, false);
});

test("a conflict that also touches a file the regenerate command does not rewrite still stops, naming what regeneration left", async (t) => {
  const f = await landFixture(t, { mainChange: { file: "work.txt", text: "from main\n", message: "Main edits work" } });
  // Both sides also regenerate the fixture, so one conflict is generated and one is not.
  writeFileSync(join(f.checkout, "gen-fixtures.txt"), "from main\n");
  git(f.checkout, "add", "."); git(f.checkout, "commit", "-m", "Main regenerates the fixture"); git(f.checkout, "push", "-q", "origin", "main");
  writeFileSync(join(f.workspace("t1"), "gen-fixtures.txt"), "from task\n");
  git(f.workspace("t1"), "add", "."); git(f.workspace("t1"), "commit", "-m", "Task regenerates the fixture"); git(f.workspace("t1"), "push", "-q", "origin", "main");
  const before = { fork: f.forkHead("t1"), baseline: git(f.p, "--git-dir", f.baseline, "rev-parse", "main") };
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /stops on conflicts in:\ngen-fixtures\.txt\nwork\.txt/);
  assert.match(r.output, /the regenerate command left work\.txt as either side had it/);
  // The conflicted merge is back in the workspace, markers and all; nothing moved on.
  assert.ok(existsSync(join(f.workspace("t1"), ".git", "MERGE_HEAD")));
  assert.match(readFileSync(join(f.workspace("t1"), "work.txt"), "utf8"), /^<{7} /m);
  assert.equal(f.forkHead("t1"), before.fork);
  assert.equal(git(f.p, "--git-dir", f.baseline, "rev-parse", "main"), before.baseline);
  assert.equal(f.box.states.t1, "submitted");
  assert.deepEqual(f.posts("/push"), []); assert.deepEqual(f.posts("/merged"), []);
  const merge = f.posts("/land").find((x) => x.body.step === "merge");
  assert.equal(merge.body.failed, true);
  assert.deepEqual(merge.body.conflicts, ["gen-fixtures.txt", "work.txt"]);
  assert.equal(merge.body.resolvedBy, "the project owner, by hand");
  assert.equal(merge.body.reason, "the regenerate command left work.txt as either side had it");
});

test("a regenerate command that fails while settling conflicts stops the landing with the failure named", async (t) => {
  const f = await landFixture(t, { mainChange: { file: "gen-fixtures.txt", text: "from main\n", message: "Main regenerates the fixture" } });
  writeFileSync(join(f.workspace("t1"), "gen-fixtures.txt"), "from task\n");
  git(f.workspace("t1"), "add", "."); git(f.workspace("t1"), "commit", "-m", "Task regenerates the fixture"); git(f.workspace("t1"), "push", "-q", "origin", "main");
  f.box.regen = "echo boom >&2; exit 3";
  const before = f.forkHead("t1");
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /Taking either side and regenerating did not settle them: the regenerate command `echo boom >&2; exit 3` failed \(exit 3\)/);
  assert.match(r.output, /boom/);
  // The merge is left in the workspace, still conflicted, and nothing landed.
  assert.ok(existsSync(join(f.workspace("t1"), ".git", "MERGE_HEAD")));
  assert.equal(f.forkHead("t1"), before);
  assert.equal(f.box.states.t1, "submitted");
  const merge = f.posts("/land").find((x) => x.body.step === "merge");
  assert.equal(merge.body.failed, true);
  assert.deepEqual(merge.body.conflicts, ["gen-fixtures.txt"]);
  assert.equal(merge.body.reason, "the regenerate command `echo boom >&2; exit 3` failed (exit 3)");
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
  // The default review wait outlasts the runner's 45 minute build timeout.
  assert.match(r.output, /for up to 60 minutes/);
  // Reads only: the lease is read, never taken, and nothing that changes state was posted.
  assert.ok(f.box.requests.some((x) => x.method === "GET" && x.path.endsWith("/landing-lease")));
  assert.deepEqual(f.box.requests.filter((x) => x.method === "POST"), []);
  assert.equal(f.box.lease, null);
  assert.equal(git(f.workspace("t1"), "rev-parse", "HEAD"), before.workspace);
  assert.equal(f.forkHead("t1"), before.fork);
  assert.equal(git(f.p, "--git-dir", f.baseline, "rev-parse", "main"), before.baseline);
  // A dry run still refuses a held lease.
  f.box.lease = { item: "t2", holder: "owner", at: "2026-10-06T09:30:00.000Z", renewedAt: new Date().toISOString() };
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

// Waits until `ready()` holds, polling, or fails after `ms`.
async function until(ready, ms = 15_000, what = "the condition") {
  for (const t0 = Date.now(); !ready();) {
    if (Date.now() - t0 > ms) throw new Error(`${what} did not come within ${ms}ms`);
    await new Promise((ok) => setTimeout(ok, 25));
  }
}

// A landing that is waiting for a review verdict that never comes, spawned
// rather than awaited, so a test can signal it or watch its heartbeat.
function waitingLanding(f, env = {}) {
  f.box.review.approveAfter = null;
  const child = spawn(process.execPath, [resolve("cli/atelier.mjs"), "land", "t1", "--project", "proj"], {
    cwd: f.checkout,
    env: { ...process.env, ATELIER_CONFIG_DIR: join(f.p, "config"), ATELIER_TOKEN: "fixture", ATELIER_CACHE: join(f.p, "cache"), ATELIER_SERVER: f.url, ATELIER_LAND_POLL_MS: "30", ...env },
  });
  let output = ""; child.stdout.on("data", (s) => output += s); child.stderr.on("data", (s) => output += s);
  const done = new Promise((ok) => child.on("close", (status, signal) => ok({ status, signal })));
  return { child, done, output: () => output };
}

test("SIGINT and SIGTERM release the lease before the landing ends, with the signal's status", async (t) => {
  for (const [signal, status] of [["SIGTERM", 143], ["SIGINT", 130]]) {
    const f = await landFixture(t);
    const landing = waitingLanding(f);
    await until(() => f.box.review.pending, 15_000, "the review request");
    assert.equal(f.box.lease?.item, "t1");
    landing.child.kill(signal);
    const ended = await landing.done;
    assert.equal(ended.status, status, landing.output());
    assert.match(landing.output(), new RegExp(`${signal} received; releasing the landing lease of proj`));
    assert.equal(f.box.lease, null);
    assert.ok(f.posts("/landing-lease").some((x) => x.body.cancel === true));
    assert.equal(f.box.states.t1, "submitted");
  }
});

test("the landing renews the lease while it waits, and the renewal moves renewedAt on", async (t) => {
  const f = await landFixture(t);
  const landing = waitingLanding(f, { ATELIER_LAND_RENEW_MS: "40" });
  await until(() => f.posts("/landing-lease").filter((x) => x.body.renew === true).length >= 3, 15_000, "three renewals");
  assert.ok(f.posts("/landing-lease").some((x) => x.body.item === "t1" && x.body.renew !== true), "the lease was taken before it was renewed");
  for (const renew of f.posts("/landing-lease").filter((x) => x.body.renew === true)) assert.equal(renew.body.item, "t1");
  assert.equal(f.box.lease.item, "t1");
  assert.ok(Date.parse(f.box.lease.renewedAt) > Date.parse(f.box.lease.at), "renewedAt moved past the time the lease was taken");
  // Nothing was approved; the landing is still waiting.
  assert.equal(f.box.states.t1, "submitted");
  landing.child.kill("SIGTERM");
  await landing.done;
  assert.equal(f.box.lease, null);
});

test("a lease not renewed for the expiry is taken over, and the landing says whose lapsed", async (t) => {
  const f = await landFixture(t);
  const at = new Date(Date.now() - LANDING_LEASE_EXPIRY_MS - 5 * 60_000).toISOString();
  f.box.lease = { item: "t2", holder: "owner", at, renewedAt: at };
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /Took over the landing lease of proj from owner, which had been landing t2 since .* and stopped renewing it 20 minutes ago; that landing is treated as ended/);
  assert.equal(f.box.states.t1, "merged");
  assert.equal(f.box.lease, null);
});

test("--release-lease frees the lease and says which task held it since when; none held, or another task's, is said", async (t) => {
  const f = await landFixture(t);
  const none = await f.run(f.checkout, "land", "t1", "--release-lease");
  assert.equal(none.status, 0, none.output);
  assert.match(none.output, /No landing lease is held in proj; nothing to release/);
  f.box.lease = { item: "t1", holder: "owner", at: "2026-10-06T09:30:00.000Z", renewedAt: "2026-10-06T09:31:00.000Z" };
  const other = await f.run(f.checkout, "land", "t2", "--release-lease");
  assert.equal(other.status, 1, other.output);
  assert.match(other.output, /held for t1, not t2: owner has been landing t1 since 2026-10-06 09:30 UTC\. Free it with atelier land t1 --release-lease/);
  assert.equal(f.box.lease?.item, "t1");
  f.box.requests.length = 0;
  const freed = await f.run(f.checkout, "land", "t1", "--release-lease");
  assert.equal(freed.status, 0, freed.output);
  assert.match(freed.output, /Released the landing lease of proj: owner held it for t1 since 2026-10-06 09:30 UTC/);
  assert.equal(f.box.lease, null);
  // The lease alone was touched: no version check, no step recorded, nothing landed.
  assert.deepEqual(f.box.requests.map((x) => [x.method, x.path, x.body]), [["GET", "/api/projects/proj/landing-lease", {}], ["POST", "/api/projects/proj/landing-lease", { cancel: true, item: "t1" }]]);
  const mixed = await f.run(f.checkout, "land", "t1", "--release-lease", "--dry-run");
  assert.equal(mixed.status, 1); assert.match(mixed.output, /does nothing else; give it alone/);
});

test("re-running land on the task holding the lease reaches the release from every early refusal", async (t) => {
  const f = await landFixture(t);
  const lease = { item: "t1", holder: "owner", at: "2026-10-06T09:30:00.000Z", renewedAt: new Date().toISOString() };
  const offer = /The landing lease of proj is still held for t1 since 2026-10-06 09:30 UTC, from an earlier landing; atelier land t1 --release-lease frees it\./;
  // Accepted: the next step is the merge, and the lease is still offered.
  f.box.lease = { ...lease }; f.box.states.t1 = "accepted";
  const accepted = await f.run(f.checkout, "land", "t1");
  assert.equal(accepted.status, 1, accepted.output);
  assert.match(accepted.output, /t1 is accepted at [0-9a-f]{8}; merge it with: atelier merge t1\./); assert.match(accepted.output, offer);
  // Merged: nothing to land, the lease still offered.
  f.box.states.t1 = "merged";
  const merged = await f.run(f.checkout, "land", "t1");
  assert.equal(merged.status, 1, merged.output); assert.match(merged.output, /t1 is merged; there is nothing to land\./); assert.match(merged.output, offer);
  f.box.states.t1 = "submitted";
  // A merge in progress in the workspace.
  writeFileSync(join(f.workspace("t1"), ".git", "MERGE_HEAD"), `${f.forkHead("t1")}\n`);
  const midMerge = await f.run(f.checkout, "land", "t1");
  assert.equal(midMerge.status, 1, midMerge.output); assert.match(midMerge.output, /a Git merge is already in progress/); assert.match(midMerge.output, offer);
  rmSync(join(f.workspace("t1"), ".git", "MERGE_HEAD"));
  // Uncommitted changes.
  writeFileSync(join(f.workspace("t1"), "draft.txt"), "draft\n");
  const dirty = await f.run(f.checkout, "land", "t1");
  assert.equal(dirty.status, 1, dirty.output); assert.match(dirty.output, /uncommitted changes/); assert.match(dirty.output, offer);
  rmSync(join(f.workspace("t1"), "draft.txt"));
  assert.equal(f.box.lease?.item, "t1");
  // Without a held lease the refusals carry no offer.
  f.box.lease = null; f.box.states.t1 = "accepted";
  const plain = await f.run(f.checkout, "land", "t1");
  assert.equal(plain.status, 1); assert.doesNotMatch(plain.output, /--release-lease/);
  f.box.states.t1 = "submitted";
  // And the offered command frees it.
  f.box.lease = { ...lease };
  const freed = await f.run(f.checkout, "land", "t1", "--release-lease");
  assert.equal(freed.status, 0, freed.output); assert.equal(f.box.lease, null);
});

test("while the review request is unclaimed, the landing names the runner's job and what is queued ahead", async (t) => {
  const f = await landFixture(t);
  f.box.review.approveAfter = 4;
  f.box.items = [
    { id: "t2", title: "Fixture t2", state: "claimed", owner: "opencode/glm-5.3", runner: "home:mbp", dispatch: { job: "build", at: "2026-10-06T08:00:00.000Z" }, updatedAt: "2026-10-06T08:05:00.000Z" },
    { id: "t3", title: "Fixture t3", state: "open", owner: null, runner: null, dispatch: { job: "build", at: "2026-10-06T08:10:00.000Z" } },
  ];
  f.box.queue = [
    { project: "proj", item: { id: "t3", title: "Fixture t3", dispatch: { job: "build", at: "2026-10-06T08:10:00.000Z" } } },
    { project: "other", item: { id: "t9", title: "Elsewhere", dispatch: { job: "review", at: "2026-10-06T08:20:00.000Z" } } },
  ];
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /The review request is not claimed yet\. home:mbp is busy with t2 \(build, opencode\/glm-5\.3\) since 2026-10-06 08:05 UTC; 2 jobs queued ahead of it: proj\/t3 \(build\), other\/t9 \(review\)\./);
  // Said once, not on every poll.
  assert.equal(r.output.split("The review request is not claimed yet").length - 1, 1);
  assert.equal(f.box.states.t1, "merged");
  // A claimed request is waited for without the explanation.
  const g = await landFixture(t);
  g.box.review.approveAfter = 3; g.box.review.claimed = true;
  const claimed = await g.run(g.checkout, "land", "t1");
  assert.equal(claimed.status, 0, claimed.output);
  assert.doesNotMatch(claimed.output, /not claimed yet/);
  assert.equal(g.box.states.t1, "merged");
});

test("a refused renewal stops the heartbeat and is said once, and the lost lease is left alone; a failed one is retried and warned of once", async (t) => {
  const f = await landFixture(t);
  const landing = waitingLanding(f, { ATELIER_LAND_RENEW_MS: "40" });
  await until(() => f.posts("/landing-lease").filter((x) => x.body.renew === true).length >= 2, 15_000, "two renewals");
  // The server cannot be reached for a while: one warning, renewals go on.
  f.box.renewFails = true;
  await until(() => landing.output().includes("could not be renewed"), 15_000, "the warning");
  const failed = f.posts("/landing-lease").filter((x) => x.body.renew === true).length;
  await until(() => f.posts("/landing-lease").filter((x) => x.body.renew === true).length >= failed + 3, 15_000, "three more renewals");
  assert.equal(landing.output().split("could not be renewed").length - 1, 1);
  f.box.renewFails = false;
  await until(() => landing.output().includes("renewed again"), 15_000, "the recovery");
  // Another landing took the lease over: the renewal is refused, said once,
  // and no renewal follows.
  f.box.lease = { item: "t2", holder: "owner", at: new Date().toISOString(), renewedAt: new Date().toISOString() };
  await until(() => landing.output().includes("no longer t1's"), 15_000, "the loss");
  const after = f.posts("/landing-lease").filter((x) => x.body.renew === true).length;
  await new Promise((ok) => setTimeout(ok, 300));
  assert.equal(f.posts("/landing-lease").filter((x) => x.body.renew === true).length, after, "renewals continued after the refusal");
  assert.equal(landing.output().split("no longer t1's").length - 1, 1);
  assert.match(landing.output(), /run atelier land t1 again once the other landing ends/);
  // Ending the landing leaves t2's lease where it is.
  landing.child.kill("SIGTERM");
  await landing.done;
  assert.equal(f.box.lease?.item, "t2");
  assert.ok(!f.posts("/landing-lease").some((x) => x.body.cancel === true));
});

test("a landing that learns from its heartbeat that it lost the lease stops without accepting or merging", async (t) => {
  const f = await landFixture(t);
  const landing = waitingLanding(f, { ATELIER_LAND_RENEW_MS: "40" });
  await until(() => f.box.review.pending, 15_000, "the review request");
  const before = { checkout: git(f.checkout, "rev-parse", "HEAD"), baseline: git(f.p, "--git-dir", f.baseline, "rev-parse", "main") };
  // The Mac sleeps (t232): the renewals pause, the lease lapses, and t2's
  // landing, queued with --wait, takes it over.
  const taken = new Date().toISOString();
  f.box.lease = { item: "t2", holder: "owner", at: taken, renewedAt: taken };
  const ended = await landing.done;
  assert.equal(ended.status, 1, landing.output());
  assert.match(landing.output(), /no longer t1's/);
  assert.match(landing.output(), /another landing took the landing lease of proj over, so this landing stops without accepting or merging t1/);
  assert.match(landing.output(), /Nothing was merged; run atelier land t1 again once the other landing ends/);
  // Nothing was accepted or merged, and main did not move.
  assert.equal(f.posts("/accept").length, 0);
  assert.equal(f.posts("/merged").length, 0);
  assert.equal(f.box.states.t1, "submitted");
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), before.checkout);
  assert.equal(git(f.p, "--git-dir", f.baseline, "rev-parse", "main"), before.baseline);
  // The lease the other landing took stands, and the landing that lost it
  // did not try to free it.
  assert.equal(f.box.lease?.item, "t2");
  assert.ok(!f.posts("/landing-lease").some((x) => x.body.cancel === true));
});

test("before accepting, the landing asks for the lease again, so a takeover its heartbeat has not reported stops it", async (t) => {
  const f = await landFixture(t);
  // The heartbeat is slow, so the takeover (the Mac slept and woke at the
  // verdict) must be caught by the renewal the landing asks for itself
  // before the steps that publish.
  f.env = { ATELIER_LAND_RENEW_MS: "3600000", ATELIER_LAND_POLL_MS: "40" };
  f.onOutput = (out) => {
    if (out.includes("Review requested")) f.box.lease = { item: "t2", holder: "owner", at: new Date().toISOString(), renewedAt: new Date().toISOString() };
  };
  const before = { checkout: git(f.checkout, "rev-parse", "HEAD"), baseline: git(f.p, "--git-dir", f.baseline, "rev-parse", "main") };
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /the landing lease is no longer t1's \(no_lease: the landing lease is held for t2, not t1\); this landing stops before accepting or merging t1\. Nothing was merged/);
  // The verdict came and was recorded, but nothing was accepted or merged.
  assert.equal(f.posts("/land").find((x) => x.body.step === "review").body.verdict, "approve");
  assert.equal(f.posts("/accept").length, 0);
  assert.equal(f.posts("/merged").length, 0);
  assert.equal(f.box.states.t1, "submitted");
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), before.checkout);
  assert.equal(git(f.p, "--git-dir", f.baseline, "rev-parse", "main"), before.baseline);
  // The lease the other landing took stands.
  assert.equal(f.box.lease?.item, "t2");
  assert.ok(!f.posts("/landing-lease").some((x) => x.body.cancel === true));
});

test("a landing whose lease lapsed and was taken over releases nothing of the landing that took it", async (t) => {
  const f = await landFixture(t);
  // t1's landing waits for a review while its lease is renewed; then its
  // renewals stop reaching the server and t2's landing takes the lease over.
  const landing = waitingLanding(f, { ATELIER_LAND_RENEW_MS: "40" });
  await until(() => f.box.review.pending, 15_000, "the review request");
  f.box.renewFails = true;
  const taken = new Date().toISOString();
  f.box.lease = { item: "t2", holder: "owner", at: taken, renewedAt: taken };
  // t1's landing ends on a signal, as a killed one would: its release names
  // t1, so the server leaves t2's lease where it is.
  landing.child.kill("SIGTERM");
  await landing.done;
  assert.deepEqual(f.posts("/landing-lease").filter((x) => x.body.cancel === true).map((x) => x.body), [{ cancel: true, item: "t1" }]);
  assert.deepEqual(f.box.lease, { item: "t2", holder: "owner", at: taken, renewedAt: taken });
  // The refusal names the landing that holds the lease now, as the handover
  // it is, not a warning about a lease left stranded (t237).
  assert.match(landing.output(), /The landing lease of proj is held for t2's landing now, so this release left it alone/);
  assert.doesNotMatch(landing.output(), /could not be released/);
  // --release-lease aimed at t1 refuses too, naming t2's landing, and leaves the lease.
  const r = await f.run(f.checkout, "land", "t1", "--release-lease");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /held for t2, not t1: owner has been landing t2 since .*atelier land t2 --release-lease/);
  assert.deepEqual(f.box.lease, { item: "t2", holder: "owner", at: taken, renewedAt: taken });
});

test("a landing that merged says the handover, not a warning, when a queued landing takes the lease in the moment after the merge", async (t) => {
  const f = await landFixture(t, { mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  // The server treats a merged task's lease as free (landingLive), so t2's
  // landing, queued with --wait, takes it the moment t1's merge is recorded,
  // before t1's landing releases it (t237): the release's cancel is refused
  // naming t2, which is the handover working, not a failure.
  f.box.takeOverOnMerged = "t2";
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /t1 landed:/);
  assert.match(r.output, /The landing lease of proj is held for t2's landing now, so this release left it alone: the server treats a merged task's lease \(a lapsed one the same way\) as free, so a landing queued with --wait takes it in the moment after the merge, and that landing holds and renews it\. Nothing of t1's landing is stranded\./);
  // No warning of a lease that could not be released, and no claim that it
  // was released: another landing holds it now.
  assert.doesNotMatch(r.output, /could not be released/);
  assert.doesNotMatch(r.output, /The landing lease for proj is released/);
  // The cancel still named t1, and the lease is left with t2's landing.
  assert.ok(f.posts("/landing-lease").some((x) => x.body.cancel === true && x.body.item === "t1"));
  assert.equal(f.box.lease?.item, "t2");
  assert.equal(f.box.states.t1, "merged");
});
