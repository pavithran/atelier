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
// files named and the merge left in the workspace, a clean landing merges
// main, regenerates the project's fixtures, pushes, checks, waits for the
// review verdict, accepts and merges, --dry-run changes nothing, and a
// server whose route level is lower than the CLI's, or none at all, refuses
// naming both levels and saying to deploy, while a different commit at the
// CLI's level passes. The lease never strands the project (t214): a signal
// releases it, the heartbeat renews it, a lapsed lease is taken over and
// named, --release-lease frees it saying which task held it since when, and
// every early refusal of the task holding it offers that command.

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function root(t) { const p = mkdtempSync(join(tmpdir(), "atelier-landcmd-")); t.after(() => rmSync(p, { recursive: true, force: true })); return p; }

// The owner's checkout, the baseline, and each task's fork and workspace,
// served by a stand-in ledger that answers from `box`: the items' states, the
// landing lease, the server's version (route level and commit), whether the
// gate needs a review (the reviewer approves on the first poll after the
// request), and every request made, so a test can say what a landing
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
  // reviewer approves (never, when null); `review.claimed` makes the request
  // claimed as soon as it is made, as a review.claimed event. `items` and `queue` answer
  // the project's items and the runner queue, which the wait explains from.
  const box = {
    states: {}, reviews: { t1: [], t2: [] }, lease: null, version: null, routeLevel: ROUTE_LEVEL,
    review: { needed: true, reviewer: "codex/gpt-6-astra", pending: false, at: null, approveAfter: 0, claimed: false },
    requests: [], regen: "echo generated > gen-fixtures.txt", items: [], queue: [],
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
    const reviews = due ? (box.reviews.t1.push({ by: box.review.reviewer, approve: true, head, note: "Land fixture approves.", at: new Date().toISOString() }), box.review.pending = false, box.reviews.t1) : box.reviews[id];
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
      else if (body.cancel === true) { answer = { held: !!box.lease, lease: box.lease }; box.lease = null; }
      else if (body.renew === true) {
        if (!box.lease || box.lease.item !== body.item) return fail(409, "no_lease", `the landing lease is held for ${box.lease?.item ?? "nobody"}, not ${body.item}`);
        box.lease = { ...box.lease, renewedAt: now }; answer = { lease: box.lease };
      } else {
        let expired = null;
        if (box.lease && box.lease.item !== body.item) {
          if (!landingLeaseLapsed(box.lease, Date.now())) return fail(409, "landing_lease", `${box.lease.holder} has been landing ${box.lease.item} since ${box.lease.at}; one landing runs at a time in this project`);
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
      if (!box.review.needed) answer = { needed: false, reason: "the gate counts an independent approval already" };
      else { box.review.pending = true; box.review.at = new Date().toISOString(); answer = { needed: true, requested: true, reason: "a protected change needs an independent review", at: box.review.at, head, reviewer: body.reviewer ?? box.review.reviewer }; }
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
    const child = spawn(process.execPath, [resolve("cli/atelier.mjs"), ...args, "--project", "proj"], { cwd, env: { ...process.env, ATELIER_CONFIG_DIR: config, ATELIER_TOKEN: "fixture", ATELIER_CACHE: cache, ATELIER_SERVER: url, ATELIER_LAND_POLL_MS: "50" } });
    let output = ""; child.stdout.on("data", (s) => output += s); child.stderr.on("data", (s) => output += s);
    const status = await new Promise((ok) => child.on("close", ok));
    return { status, output };
  };
  return { p, url, baseline, checkout, workspace: (id) => join(cache, "work", "proj", id), fork: (id) => join(p, `fork-${id}.git`), forkHead, mainCommit, box, run, posts: (suffix) => box.requests.filter((r) => r.method === "POST" && r.path.endsWith(suffix)) };
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
  // Nothing changed: no lease was taken or posted, the workspace did not move.
  assert.ok(f.box.requests.every((x) => !(x.method === "POST" && x.path.endsWith("/landing-lease"))));
  assert.equal(git(f.workspace("t1"), "rev-parse", "HEAD"), before);
  assert.ok(!existsSync(join(f.workspace("t1"), ".git", "MERGE_HEAD")));
  assert.deepEqual(f.posts("/land"), []);
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
  assert.deepEqual(f.box.requests.map((x) => [x.method, x.path]), [["GET", "/api/projects/proj/landing-lease"], ["POST", "/api/projects/proj/landing-lease"]]);
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
