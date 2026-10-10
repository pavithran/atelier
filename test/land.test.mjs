import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

import { ROUTE_LEVEL } from "../src/route-level.ts";
import { runLand } from "../cli/land.mjs";
import { LANDING_LEASE_EXPIRY_MS, landingLeaseLapsed, waitingLandingGone } from "../src/landing-lease.ts";

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
// refusals again once it is free, and gives up after its limit. The queue has
// an order (t249): the server hands the lease to the waiting landings in the
// order they queued, each waiting landing asking again on every poll and
// leaving the queue when its wait ends, so a landing whose polls land first
// cannot take the lease ahead of one that queued earlier. A landing that
// loses its lease stops (t232): one that slept while another landing
// took the lease over ends without accepting or merging, however it learns
// of the loss, and leaves the lease that took it over where it is. Where
// main and the task each raised the route level from one base (t248), the
// landing raises the merged level past both, its own commit, saying to
// deploy — after its own merge, on a rerun of a conflicted merge the
// owner resolved by hand, which finds main already merged, and wherever a
// merge brought main in through a side branch, which the walk down HEAD's
// first-parent line finds by ancestry; a raise on one side alone, or a
// repo with no route-level file, lands as it is, the comparison skipped
// and the landing going on.

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
async function landFixture(t, { mainChange = null, taskChange = "task\n", conflict = false, seedRouteLevel = null } = {}) {
  const p = root(t), seed = join(p, "seed"), baseline = join(p, "baseline.git"), checkout = join(p, "checkout"), config = join(p, "config"), cache = join(p, "cache");
  mkdirSync(seed); mkdirSync(config);
  git(seed, "init", "-b", "main"); git(seed, "config", "user.name", "Fixture"); git(seed, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(seed, "work.txt"), "base\n");
  // A seed route level, from which a test can raise it on the task's side,
  // on main's, or both, and see what the landing's merge makes of that.
  if (seedRouteLevel !== null) {
    mkdirSync(join(seed, "src"), { recursive: true });
    writeFileSync(join(seed, "src", "route-level.ts"), `export const ROUTE_LEVEL = ${seedRouteLevel};\n`);
  }
  git(seed, "add", "."); git(seed, "commit", "-m", "Initial");
  git(p, "clone", "--bare", seed, baseline); git(p, "clone", baseline, checkout);
  for (const dir of [checkout]) { git(dir, "config", "user.name", "Fixture"); git(dir, "config", "user.email", "fixture@example.invalid"); }
  const forkHead = (id) => { try { return git(p, "--git-dir", join(p, `fork-${id}.git`), "rev-parse", "main"); } catch { return null; } };
  // `review.approveAfter` is how many polls of the task pass before the
  // reviewer answers (never, when null); `review.claimed` makes the request
  // claimed as soon as it is made, as a review.claimed event. `items` and `queue` answer
  // the project's items and the runner queue, which the wait explains from.
  const box = {
    states: {}, reviews: { t1: [], t2: [] }, lease: null, waiting: [], version: null, routeLevel: ROUTE_LEVEL,
    review: { needed: true, reviewer: "codex/gpt-6-astra", approve: true, pending: false, at: null, approveAfter: 0, claimed: false },
    requests: [], regen: "echo generated > gen-fixtures.txt", checks: ["exit 0"], items: [], queue: [], runners: null, renewFails: false, kinds: {},
    wf: { instance: null, stage: null, round: 0, checks: null, status: null, files: null, error: null, output: null, events: [], started: [], reads: 0, baseTokenAt: [], tick: null, onEvent: null },
  };
  // The tasks fork from the baseline before main moves, so a landing has
  // main's commits to merge; each has a workspace in the cache's layout.
  for (const id of ["t1", "t2"]) {
    const fork = join(p, `fork-${id}.git`), workspace = join(cache, "work", "proj", id);
    git(p, "clone", "--bare", baseline, fork); mkdirSync(dirname(workspace), { recursive: true }); git(p, "clone", fork, workspace);
    for (const dir of [workspace]) { git(dir, "config", "user.name", "Fixture"); git(dir, "config", "user.email", "fixture@example.invalid"); }
    // A claim records its write token's expiry (t275); these are far off, so
    // no landing here refreshes them.
    for (const [key, value] of Object.entries({ project: "proj", item: id, actor: "codex/test", branch: "main", "write-token-expires-at": "2999-01-01T00:00:00.000Z" })) git(workspace, "config", `atelier.${key}`, value);
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
    // A tier review (`box.tier`) answers on the first poll after the request, before the gate's reviewer.
    if (id === "t1" && box.review.pending && box.tier && !box.tier.given) { box.tier.given = true; box.reviews.t1.push({ by: box.tier.by, approve: box.tier.approve, tier: true, head, note: "Tier fixture.", at: new Date().toISOString() }); }
    const due = id === "t1" && box.review.pending && box.review.approveAfter !== null && box.review.approveAfter-- <= 0;
    const reviews = due ? (box.reviews.t1.push({ by: box.review.reviewer, approve: box.review.approve, head, note: box.review.approve ? "Land fixture approves." : "Land fixture rejects.", at: new Date().toISOString() }), box.review.pending = false, box.reviews.t1) : box.reviews[id];
    const state = box.states[id];
    const events = id === "t1" && box.review.claimed && box.review.at ? [{ seq: 1, itemId: id, at: box.review.at, actor: box.review.reviewer, kind: "review.claimed", data: { head, runner: "home:mbp" } }] : [];
    return {
      item: { id, title: `Fixture ${id}`, state, owner: "codex/test", ...(box.pushActors ? { pushActors: box.pushActors } : {}), head, ...(box.kinds[id] ? { kind: box.kinds[id] } : {}), acceptedHead: state === "accepted" || state === "merged" ? head : null },
      policy: { checks: box.checks, protected: ["work.txt"], regenerate: box.regen, ...(box.agents ? { agents: box.agents } : {}), ...(box.eligible ? { eligible: box.eligible } : {}) },
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
    else if (url.endsWith("/landing-workflow")) {
      // A stand-in for the landing Workflow (t280): the instance the route
      // remembers, its stage and round, and its status. A test moves it on
      // through `wf.tick` (after each read) and `wf.onEvent` (each event).
      const wf = box.wf;
      const view = () => ({ instance: wf.instance, stage: wf.stage, round: wf.round, ...(wf.checks ? { checks: wf.checks } : {}), ...(wf.files ? { files: wf.files } : {}), status: { status: wf.status, ...(wf.error ? { error: { name: "Error", message: wf.error } } : {}), ...(wf.output ? { output: wf.output } : {}) } });
      if (req.method === "GET") { answer = wf.instance ? view() : { instance: null, status: null, stage: null }; wf.reads++; }
      else if (body.event) { wf.events.push(body.event); wf.onEvent?.(body.event, box); answer = { sent: true, instance: wf.instance }; }
      else if (wf.instance && ["running", "waiting", "queued"].includes(wf.status)) answer = { ...view(), created: false };
      // The checks mode is recorded as the server records it (t305):
      // container where the start names none; `wf.noChecksMode` stands in
      // for a server older than the modes, which records none.
      else { Object.assign(wf, { instance: `land-${item}-${wf.started.length + 1}`, stage: "lease", round: 0, checks: wf.noChecksMode ? null : body.checks ?? "container", status: "running", files: null, error: null }); wf.started.push(body); answer = { ...view(), created: true }; }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(answer));
      if (req.method === "GET") wf.tick?.(box);
      return;
    }
    else if (url === "/api/projects/proj/landing-lease") {
      // The lease and the queue of waiting landings as the server keeps
      // them (t249): a renewal moves renewedAt on, a lease not renewed for
      // the expiry is taken over and named as expired, a waiting landing's
      // ask refreshes its place in the queue (kept, when it had one, so the
      // order is the order the landings queued) and never takes, and the
      // lease is handed to the landing that queued first once it is free.
      const now = new Date().toISOString();
      // The rows that still count: fresh (their landing keeps asking) and
      // for a task that could still land.
      const rows = () => (box.waiting ?? []).filter((w) => !waitingLandingGone(w, Date.now()) && !["merged", "abandoned"].includes(box.states[w.item]));
      if (req.method === "GET") answer = { lease: box.lease, waiting: rows() };
      else if (body.cancel === true) {
        if (!body.item) return fail(400, "bad_item", "a cancel names the task whose landing lease it releases");
        if (box.lease && box.lease.item !== body.item) return fail(409, "landing_lease", `the landing lease is held for ${box.lease.item}, not ${body.item}: ${box.lease.holder} has been landing ${box.lease.item} since ${box.lease.at.slice(0, 16).replace("T", " ")} UTC, and its lease is left alone. Free it with atelier land ${box.lease.item} --release-lease`);
        answer = { held: !!box.lease, lease: box.lease }; box.lease = null;
      }
      else if (body.renew === true) {
        if (box.renewFails) return fail(503, "unavailable", "the ledger could not be reached");
        if (!box.lease || box.lease.item !== body.item) return fail(409, "no_lease", `the landing lease is held for ${box.lease?.item ?? "nobody"}, not ${body.item}`);
        box.lease = { ...box.lease, renewedAt: now }; answer = { lease: box.lease };
      }
      else if (body.queued === true) {
        // A waiting landing asks again, or leaves the queue.
        const kept = rows();
        const mine = kept.findIndex((w) => w.item === body.item);
        if (body.leave === true) { if (mine >= 0) kept.splice(mine, 1); }
        else if (mine >= 0) kept[mine] = { ...kept[mine], renewedAt: now };
        else kept.push({ item: body.item, holder: "owner", at: now, renewedAt: now });
        box.waiting = kept;
        answer = { lease: box.lease, waiting: kept };
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
        // A landing that queued earlier still waits: the lease is not this
        // take's, however its poll landed, and the landings queued behind
        // the taker are not in its way (t249).
        const kept = rows();
        const mine = kept.findIndex((w) => w.item === body.item);
        const ahead = mine === -1 ? kept : kept.slice(0, mine);
        if (box.lease?.item !== body.item && ahead.length) {
          const head = ahead[0];
          return fail(409, "landing_lease", `${head.holder}'s landing of ${head.item} has been waiting for the lease since ${head.at.slice(0, 16).replace("T", " ")} UTC, first of ${ahead.length} landing${ahead.length === 1 ? "" : "s"} queued for it; landings take the lease in the order they queued, so ${body.item} cannot take it ahead of them`);
        }
        box.waiting = rows().filter((w) => w.item !== body.item);
        box.lease = { item: body.item, holder: "owner", at: now, renewedAt: now };
        answer = { item: { id: body.item, state: box.states[body.item] }, expired };
      }
    } else if (url === "/api/projects/proj/items") answer = box.items;
    else if (url === "/api/queue") answer = box.queue;
    else if (url === "/api/runners") answer = box.runners;
    else if (url.endsWith("/base-token") || url === "/api/projects/proj/baseline-token") (box.wf.baseTokenAt.push(box.wf.stage), answer = { remote: baseline, token: "fixture", defaultBranch: "main" });
    else if (url.endsWith("/read-token")) answer = { remote: join(p, `fork-${item}.git`), token: "fixture", head, defaultBranch: "main" };
    else if (url.endsWith("/push")) { box.states[item] = "claimed"; answer = { ...answer.item, head }; }
    else if (url.endsWith("/evidence")) answer = item ? { ...detail(item), evidence: [] } : {};
    else if (url.endsWith("/submit")) { box.states[item] = "submitted"; answer = detail(item); }
    else if (url.endsWith("/review-request")) {
      if (!box.review.needed && !(body.wanted === true && body.reviewer)) answer = { needed: false, reason: box.review.reason ?? "the gate counts an independent approval already" };
      else { box.review.reviewer = body.reviewer ?? box.review.reviewer; box.review.pending = true; box.review.at = new Date().toISOString(); answer = { needed: true, requested: true, reason: `a protected change needs an independent review${!body.reviewer && box.review.why ? ` ${box.review.why}` : ""}`, at: box.review.at, head, reviewer: body.reviewer ?? box.review.reviewer }; }
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

// With no --reviewer the server suggests the reviewer (t370): the landing
// prints the reviewer it chose and the reasons the server gave.
test("a landing with no --reviewer prints the reviewer the server chose and why", async (t) => {
  const f = await landFixture(t);
  f.box.review.why = "Frontier reviewer required for security, concurrency or gate work. From the pool, which goes by review precision, then outcome record, then actor name.";
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(f.posts("/review-request").at(-1).body, {});
  assert.match(r.output, /Review requested for codex\/gpt-6-astra: a protected change needs an independent review Frontier reviewer required for security, concurrency or gate work\. From the pool, which goes by review precision, then outcome record, then actor name\. Waiting for the verdict/);
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

test("--reviewer who contributed to the task is refused before the lease and the checks", async (t) => {
  const f = await landFixture(t);
  f.box.pushActors = ["codex/gpt-6-luna"];
  const before = git(f.checkout, "rev-parse", "HEAD");
  const r = await f.run(f.checkout, "land", "t1", "--reviewer", "codex/gpt-6-luna");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /codex\/gpt-6-luna contributed to t1 .* cannot review it/);
  assert.equal(f.posts("/landing-lease").length, 0);
  assert.equal(f.posts("/review-request").length, 0);
  assert.equal(f.posts("/land").length, 0);
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), before);
});

test("--reviewer whose approval would not count under the policy is refused up front, naming the reviewers that would", async (t) => {
  const f = await landFixture(t);
  f.box.agents = { claude: { available: true, eligible_roles: ["assessor"] }, codex: { available: false, eligible_roles: ["assessor"] } };
  const before = git(f.checkout, "rev-parse", "HEAD");
  const r = await f.run(f.checkout, "land", "t1", "--reviewer", "codex/gpt-6-astra");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /codex\/gpt-6-astra's approval would not count in proj: codex\/gpt-6-astra needs an available agent with the assessor role; available agents with the assessor role: claude\. Name another reviewer with --reviewer H\/M/);
  assert.equal(f.posts("/landing-lease").length, 0);
  assert.equal(f.posts("/review-request").length, 0);
  assert.equal(f.posts("/land").length, 0);
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), before);
  // The eligible reviewer is not refused.
  const ok = await f.run(f.checkout, "land", "t1", "--reviewer", "claude-code/opus-5.5");
  assert.equal(ok.status, 0, ok.output);
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

test("a tier approval that comes first is said and not taken for the gate's verdict; the landing waits for the gate's review alone", async (t) => {
  const f = await landFixture(t);
  f.box.tier = { by: "claude-code/sonnet-5.5", approve: true };
  f.box.review.approveAfter = 2;
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /claude-code\/sonnet-5\.5 approved t1 at \w+ as its tier review; the landing still waits for the gate's review\./);
  assert.match(r.output, /codex\/gpt-6-astra approved t1/);
  assert.equal(f.posts("/land").find((x) => x.body.step === "review").body.reviewer, "codex/gpt-6-astra");
  assert.equal(f.box.states.t1, "merged");
});

test("a tier rejection that arrives in the same poll as the gate's later approval still stops the landing", async (t) => {
  const f = await landFixture(t);
  f.box.tier = { by: "claude-code/sonnet-5.5", approve: false };
  f.box.review.approveAfter = 0;
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /claude-code\/sonnet-5\.5 \(tier review\) rejected t1/);
  assert.equal(f.posts("/accept").length, 0);
  assert.equal(f.box.states.t1, "submitted");
});

test("a tier rejection stops the landing as any rejection does", async (t) => {
  const f = await landFixture(t);
  f.box.tier = { by: "claude-code/sonnet-5.5", approve: false };
  f.box.review.approveAfter = 2;
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /claude-code\/sonnet-5\.5 \(tier review\) rejected t1/);
  assert.equal(f.posts("/accept").length, 0);
  assert.equal(f.box.states.t1, "submitted");
});

test("without --reviewer a gate that needs no review says why and does not claim to accept", async (t) => {
  const f = await landFixture(t);
  f.box.review.needed = false;
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(f.posts("/review-request").at(-1).body, {});
  assert.match(r.output, /No review request was needed: an independent approval already covers this change\./);
  assert.doesNotMatch(r.output, /accepting/);
});

test("a coordinated change without protected paths says plainly why no review was needed", async (t) => {
  const f = await landFixture(t);
  f.box.review.needed = false;
  f.box.review.reason = "a coordinated change needs no review in a project without an execution policy; automatic review covers parts and the changes the gate needs reviewed";
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /No review was needed: this change touched no protected paths\./);
  assert.doesNotMatch(r.output, /execution policy/);
});

test("a direct change says plainly that it touched no protected paths", async (t) => {
  const f = await landFixture(t);
  f.box.review.needed = false;
  f.box.review.reason = "a direct change needs no review";
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /No review was needed: this change touched no protected paths\./);
});

test("a needed:false answer for failing checks prints the server's reason, never a claim about protected paths (t319)", async (t) => {
  const f = await landFixture(t);
  f.box.review.needed = false;
  f.box.review.reason = "npm test failed at 1a2b3c4d; the builder fixes that before a review";
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /No review request was needed: npm test failed at 1a2b3c4d; the builder fixes that before a review\./);
  assert.doesNotMatch(r.output, /protected path|touched no/);
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

// A plan lands through atelier merge at its integration head: the merge of
// main a landing makes would put a commit beside the recorded integrations,
// so the landing refuses before the lease or the workspace changes, dry run
// included, naming the merge and the refresh that take its place.
test("a plan item is refused before the lease, pointing at atelier merge and atelier plan refresh", async (t) => {
  const f = await landFixture(t, { mainChange: { file: "main.txt", text: "main\n", message: "Main moves" } });
  f.box.kinds.t1 = "plan";
  const before = git(f.workspace("t1"), "rev-parse", "HEAD");
  for (const args of [["land", "t1"], ["land", "t1", "--dry-run"]]) {
    const r = await f.run(f.checkout, ...args);
    assert.notEqual(r.status, 0, r.output);
    assert.match(r.output, /t1 is a plan, which atelier land does not land: a plan lands with atelier merge t1 --head INTEGRATION_HEAD, the integration head atelier plan show t1 prints, and a plan branch that is behind main takes main through atelier plan refresh t1\./);
  }
  assert.equal(f.posts("/landing-lease").length, 0);
  assert.equal(f.posts("/land").length, 0);
  assert.equal(f.box.lease, null);
  assert.equal(git(f.workspace("t1"), "rev-parse", "HEAD"), before);
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
  // It polled while it waited (each poll an ask that refreshed its place in
  // the server's queue) and took the lease only once it was free (the
  // release at the end names t1 too, t214, and is not a take).
  const takes = f.box.requests.map((x, i) => ({ ...x, i })).filter((x) => x.method === "POST" && x.path.endsWith("/landing-lease") && x.body.item === "t1" && !x.body.cancel && !x.body.renew && x.body.queued !== true);
  assert.equal(takes.length, 1);
  assert.ok(freedAt > 0 && takes[0].i >= freedAt, "the lease was taken before it was free");
  assert.ok(f.posts("/landing-lease").filter((x) => x.body.queued === true).length > 3, "the landing asked again while it waited");
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
  assert.equal(f.posts("/landing-lease").filter((x) => x.body.item === "t1" && !x.body.cancel && !x.body.renew && x.body.queued !== true).length, 2);
  assert.equal(f.posts("/land").filter((x) => x.body.step === "lease").length, 1);
  assert.equal(f.box.lease, null);
});

// The queue's order (t249): a landing queued with --wait takes the lease in
// its turn, not whenever its poll happens to land on a free lease. t247 once
// took it ahead of t245, which had waited longer and was the one its plan
// needed (2026-10-07); the server now keeps the waiting landings in the
// order they queued and hands the lease down that order.
test("--wait keeps the queue's order: the landing that queued first takes the lease first, however the polls land", async (t) => {
  const f = await landFixture(t);
  f.box.lease = { item: "t2", holder: "owner", at: "2026-10-07T09:00:00.000Z", renewedAt: new Date().toISOString() };
  // t2's landing queued for the lease at 09:14; t1 queues behind it now, and
  // once the lease frees t1's polls land while t2's row still waits.
  const queuedAt = "2026-10-07T09:14:00.000Z";
  f.box.waiting = [{ item: "t2", holder: "owner", at: queuedAt, renewedAt: new Date().toISOString() }];
  f.env = { ATELIER_LAND_POLL_MS: "40" };
  const takes = () => f.posts("/landing-lease").filter((x) => x.body.item === "t1" && !x.body.cancel && !x.body.renew && x.body.queued !== true);
  let tookEarly = false;
  let phase = 0;
  f.onOutput = (out) => {
    if (phase === 0 && out.includes("Waiting behind owner's landing of t2 (since 2026-10-07 09:00 UTC)")) {
      phase = 1;
      setTimeout(() => { f.box.lease = null; }, 120);
    } else if (phase === 1 && out.includes("Waiting for the lease behind 1 landing queued ahead of t1")) {
      phase = 2;
      // The lease is free and this landing's poll has landed: it must not
      // have taken the lease ahead of the landing that queued first.
      tookEarly = takes().length > 0;
      // The landing that queued first takes it (its poll lands now) and
      // finishes, releasing the lease.
      setTimeout(() => {
        f.box.waiting = f.box.waiting.filter((w) => w.item !== "t2");
        f.box.lease = { item: "t2", holder: "owner", at: "2026-10-07T09:31:00.000Z", renewedAt: new Date().toISOString() };
        setTimeout(() => { f.box.lease = null; }, 150);
      }, 120);
    }
  };
  const r = await f.run(f.checkout, "land", "t1", "--wait", "--no-review");
  assert.equal(r.status, 0, r.output);
  assert.equal(tookEarly, false, "t1 took the free lease ahead of the landing that queued first");
  assert.match(r.output, /Waiting behind owner's landing of t2 \(since 2026-10-07 09:00 UTC\), with 1 landing queued ahead of t1: t2 \(queued 2026-10-07 09:14 UTC\); t1 starts when its turn comes, in the order the landings queued\./);
  assert.match(r.output, /Waiting for the lease behind 1 landing queued ahead of t1: t2 \(queued 2026-10-07 09:14 UTC\); t1 takes the lease when its turn comes, in the order the landings queued\./);
  assert.match(r.output, /Waiting behind owner's landing of t2 \(since 2026-10-07 09:31 UTC\); t1 starts as soon as the lease is free\./);
  // It asked again while it waited, took the lease once, in its turn, and
  // ran its landing to the submitted step (--no-review leaves the rest).
  assert.ok(f.posts("/landing-lease").filter((x) => x.body.queued === true && x.body.item === "t1").length > 2, "the landing asked again while it waited");
  assert.equal(takes().length, 1);
  assert.match(r.output, /Landing lease taken for t1/);
  assert.deepEqual(f.posts("/land").map((x) => x.body.step), ["lease", "merge", "regenerate", "push", "check", "submit", "review"]);
  assert.equal(f.box.states.t1, "submitted");
  assert.equal(f.box.lease, null);
});

test("a landing without --wait cannot take the lease ahead of one that queued for it, and is told to queue", async (t) => {
  const f = await landFixture(t);
  f.box.waiting = [{ item: "t2", holder: "owner", at: "2026-10-07T09:14:00.000Z", renewedAt: new Date().toISOString() }];
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /owner's landing of t2 has been waiting for the lease since 2026-10-07 09:14 UTC, first of 1 landing queued for it; landings take the lease in the order they queued, so t1 cannot take it ahead of them; or atelier land t1 --wait queues behind it and starts when its turn comes/);
  // One take was asked for and refused; nothing was landed or recorded.
  assert.deepEqual(f.posts("/landing-lease").map((x) => x.body), [{ item: "t1" }]);
  assert.deepEqual(f.posts("/land"), []);
  assert.equal(f.box.lease, null);
  assert.equal(f.box.states.t1, "submitted");
});

// The queue a landing reads is the server's answer already pruned (a row
// whose landing stopped asking for the expiry's span no longer counts), so
// the CLI judges no row by its own machine's clock — a clock ahead of the
// server's would drop a live row and jump the queue.
test("a row whose landing stopped asking no longer counts: the landing reads the queue as the server pruned it", async (t) => {
  const f = await landFixture(t);
  f.box.lease = { item: "t2", holder: "owner", at: "2026-10-07T09:00:00.000Z", renewedAt: new Date().toISOString() };
  // t3 queued ahead of this landing but stopped asking more than the expiry
  // ago; the server drops its row before answering, so t1 waits behind the
  // holder alone and never names t3.
  const gone = new Date(Date.now() - LANDING_LEASE_EXPIRY_MS - 60_000).toISOString();
  f.box.waiting = [{ item: "t3", holder: "owner", at: "2026-10-07T08:00:00.000Z", renewedAt: gone }];
  f.env = { ATELIER_LAND_POLL_MS: "40" };
  let freeing = false;
  f.onOutput = (out) => {
    if (freeing) return;
    if (out.includes("Waiting behind owner's landing of t2 (since 2026-10-07 09:00 UTC)")) { freeing = true; setTimeout(() => { f.box.lease = null; }, 120); }
  };
  const r = await f.run(f.checkout, "land", "t1", "--wait", "--no-review");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /Waiting behind owner's landing of t2 \(since 2026-10-07 09:00 UTC\); t1 starts as soon as the lease is free\./);
  assert.doesNotMatch(r.output, /queued ahead/);
  assert.doesNotMatch(r.output, /t3/);
  // The lease was taken once it freed, not held up behind the stale row, and
  // the landing ran to its end.
  assert.equal(f.posts("/landing-lease").filter((x) => x.body.item === "t1" && !x.body.cancel && !x.body.renew && x.body.queued !== true).length, 1);
  assert.match(r.output, /Landing lease taken for t1/);
  assert.equal(f.box.states.t1, "submitted");
  assert.equal(f.box.lease, null);
});

test("--wait gives up behind the landing that queued first, saying it is still first, and leaves the queue", async (t) => {
  const f = await landFixture(t);
  f.box.waiting = [{ item: "t2", holder: "owner", at: "2026-10-07T09:14:00.000Z", renewedAt: new Date().toISOString() }];
  f.env = { ATELIER_LAND_POLL_MS: "40", ATELIER_LAND_WAIT_TIMEOUT: "1500" };
  const r = await f.run(f.checkout, "land", "t1", "--wait");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /Waiting for the lease behind 1 landing queued ahead of t1: t2 \(queued 2026-10-07 09:14 UTC\); t1 takes the lease when its turn comes, in the order the landings queued\./);
  assert.match(r.output, /the landing lease was not t1's within 2 seconds: owner's landing of t2 is still first in the queue for it\. Nothing was changed; run atelier land t1 --wait again to queue once more, or wait for t2's landing to take the lease and finish/);
  // It asked again while it waited and left the queue when it gave up,
  // taking nothing: the landing that queued first still waits alone.
  const asked = f.posts("/landing-lease").filter((x) => x.body.queued === true);
  assert.ok(asked.length > 2);
  assert.deepEqual(f.posts("/landing-lease").at(-1).body, { item: "t1", queued: true, leave: true });
  // One take was asked for, at the start, and refused; none followed.
  assert.equal(f.posts("/landing-lease").filter((x) => x.body.item === "t1" && !x.body.cancel && !x.body.renew && x.body.queued !== true).length, 1);
  assert.deepEqual(f.box.waiting.map((w) => w.item), ["t2"]);
  assert.deepEqual(f.posts("/land"), []);
});

test("a signal ends a queued landing, leaving the queue and taking no lease", async (t) => {
  const f = await landFixture(t);
  f.box.lease = { item: "t2", holder: "owner", at: "2026-10-07T09:00:00.000Z", renewedAt: new Date().toISOString() };
  const child = spawn(process.execPath, [resolve("cli/atelier.mjs"), "land", "t1", "--wait", "--no-review", "--project", "proj"], {
    cwd: f.checkout,
    env: { ...process.env, ATELIER_CONFIG_DIR: join(f.p, "config"), ATELIER_TOKEN: "fixture", ATELIER_CACHE: join(f.p, "cache"), ATELIER_SERVER: f.url, ATELIER_LAND_POLL_MS: "30" },
  });
  let output = ""; child.stdout.on("data", (s) => { output += s; }); child.stderr.on("data", (s) => { output += s; });
  const done = new Promise((ok) => child.on("close", (status, signal) => ok({ status, signal })));
  await until(() => f.posts("/landing-lease").some((x) => x.body.queued === true && x.body.item === "t1"), 15_000, "the queued ask");
  child.kill("SIGTERM");
  const ended = await done;
  assert.equal(ended.status, 143, output);
  assert.match(output, /SIGTERM received; releasing the landing lease of proj/);
  // It left the queue it held a place in and took no lease.
  assert.ok(f.posts("/landing-lease").some((x) => x.body.leave === true && x.body.item === "t1"));
  assert.ok(!f.posts("/landing-lease").some((x) => x.body.item === "t1" && !x.body.cancel && !x.body.renew && x.body.queued !== true), "a take was made");
  assert.equal(f.box.lease?.item, "t2");
  assert.deepEqual(f.box.waiting.filter((w) => w.item === "t1"), []);
  assert.equal(f.box.states.t1, "submitted");
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
  // While it queued it only asked (never took), and its end left the queue.
  const asked = f.posts("/landing-lease");
  assert.ok(asked.length > 1);
  for (const x of asked.slice(0, -1)) assert.deepEqual(x.body, { item: "t1", queued: true });
  assert.deepEqual(asked.at(-1).body, { item: "t1", queued: true, leave: true });
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
  // While it queued it only asked (never took), and giving up left the queue.
  const asked = f.posts("/landing-lease");
  assert.ok(asked.length > 1);
  for (const x of asked.slice(0, -1)) assert.deepEqual(x.body, { item: "t1", queued: true });
  assert.deepEqual(asked.at(-1).body, { item: "t1", queued: true, leave: true });
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

// Raises the route level in one of the fixture's checkouts — the task's
// workspace or main's — and pushes it, so a test can raise it on either
// side of a landing's merge.
const raiseRouteLevel = (dir, level, message) => {
  writeFileSync(join(dir, "src", "route-level.ts"), `export const ROUTE_LEVEL = ${level};\n`);
  git(dir, "add", "."); git(dir, "commit", "-m", message); git(dir, "push", "-q", "origin", "main");
};

test("where main and the task each raised the route level from one base, the landing raises the merged level past both", async (t) => {
  const f = await landFixture(t, { seedRouteLevel: 6 });
  // Both sides raise 6 to 7, so the merge is clean at the number they share.
  raiseRouteLevel(f.workspace("t1"), 7, "Task raises the route level");
  raiseRouteLevel(f.checkout, 7, "Main raises the route level");
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /main and t1 each raised the route level from 6 \(main to 7, t1 to 7\), and the merge left it at 7: the merged CLI calls both sides' routes, so the level is raised to 8\. Deploy the server from a checkout at route level 8 or newer/);
  // The raise is its own commit in the workspace, and it is what lands.
  assert.match(git(f.workspace("t1"), "log", "--format=%s"), /Raise the route level after merging main into t1/);
  assert.match(readFileSync(join(f.workspace("t1"), "src", "route-level.ts"), "utf8"), /ROUTE_LEVEL = 8;/);
  assert.match(readFileSync(join(f.checkout, "src", "route-level.ts"), "utf8"), /ROUTE_LEVEL = 8;/);
  assert.match(git(f.p, "--git-dir", f.baseline, "show", "main:src/route-level.ts"), /ROUTE_LEVEL = 8;/);
  assert.equal(f.box.states.t1, "merged");
  // The merge step records the levels it compared and the one it set.
  const merge = f.posts("/land").find((x) => x.body.step === "merge");
  assert.deepEqual(merge.body.routeLevel, { base: 6, main: 7, task: 7, was: 7, set: 8 });
});

test("where only main raised the route level, the merge takes main's number and nothing is raised past it", async (t) => {
  const f = await landFixture(t, { seedRouteLevel: 6 });
  raiseRouteLevel(f.checkout, 7, "Main raises the route level");
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.doesNotMatch(r.output, /raised the route level/);
  assert.match(readFileSync(join(f.workspace("t1"), "src", "route-level.ts"), "utf8"), /ROUTE_LEVEL = 7;/);
  assert.match(git(f.p, "--git-dir", f.baseline, "show", "main:src/route-level.ts"), /ROUTE_LEVEL = 7;/);
  assert.doesNotMatch(git(f.workspace("t1"), "log", "--format=%s"), /Raise the route level/);
  assert.equal(f.posts("/land").find((x) => x.body.step === "merge").body.routeLevel, undefined);
  assert.equal(f.box.states.t1, "merged");
});

test("where only the task raised the route level, the merge keeps the task's number", async (t) => {
  const f = await landFixture(t, { seedRouteLevel: 6, mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  raiseRouteLevel(f.workspace("t1"), 7, "Task raises the route level");
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.doesNotMatch(r.output, /raised the route level/);
  assert.match(readFileSync(join(f.workspace("t1"), "src", "route-level.ts"), "utf8"), /ROUTE_LEVEL = 7;/);
  assert.match(git(f.p, "--git-dir", f.baseline, "show", "main:src/route-level.ts"), /ROUTE_LEVEL = 7;/);
  assert.equal(f.posts("/land").find((x) => x.body.step === "merge").body.routeLevel, undefined);
  assert.equal(f.box.states.t1, "merged");
});

test("a rerun of a conflicted merge resolved by hand still compares and raises the route level", async (t) => {
  const f = await landFixture(t, { seedRouteLevel: 6 });
  // Both sides raise, to different numbers, so the merge stops on the
  // conflict and is left for the owner to resolve.
  raiseRouteLevel(f.workspace("t1"), 8, "Task raises the route level");
  raiseRouteLevel(f.checkout, 9, "Main raises the route level");
  const stopped = await f.run(f.checkout, "land", "t1");
  assert.equal(stopped.status, 1, stopped.output);
  assert.match(stopped.output, /stops on conflicts in:\nsrc\/route-level\.ts/);
  assert.match(stopped.output, /The merge is left in the workspace for you to resolve/);
  // The owner resolves it by hand, writing main's number — one side's
  // alone, as a hand resolution does — and reruns the landing, which now
  // finds main already merged and would else skip the comparison.
  writeFileSync(join(f.workspace("t1"), "src", "route-level.ts"), "export const ROUTE_LEVEL = 9;\n");
  git(f.workspace("t1"), "add", ".");
  git(f.workspace("t1"), "commit", "-m", "Resolve the merge by hand");
  f.box.requests.length = 0;
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /main at [0-9a-f]{8} is already merged into t1's workspace\./);
  assert.match(r.output, /main and t1 each raised the route level from 6 \(main to 9, t1 to 8\), and the merge left it at 9: the merged CLI calls both sides' routes, so the level is raised to 11\. Deploy the server from a checkout at route level 11 or newer/);
  // The raise is its own commit above the hand-resolved merge, measured
  // from the task's head before that merge, and it is what lands.
  assert.match(git(f.workspace("t1"), "log", "--format=%s"), /Raise the route level after merging main into t1/);
  assert.match(readFileSync(join(f.workspace("t1"), "src", "route-level.ts"), "utf8"), /ROUTE_LEVEL = 11;/);
  assert.match(git(f.p, "--git-dir", f.baseline, "show", "main:src/route-level.ts"), /ROUTE_LEVEL = 11;/);
  assert.equal(f.box.states.t1, "merged");
  // The merge step records the skipped merge beside the levels it compared and set.
  const merge = f.posts("/land").find((x) => x.body.step === "merge");
  assert.equal(merge.body.skipped, true);
  assert.deepEqual(merge.body.routeLevel, { base: 6, main: 9, task: 8, was: 9, set: 11 });
});

test("a rerun after the route level was raised compares the same levels and raises nothing further", async (t) => {
  const f = await landFixture(t, { seedRouteLevel: 6 });
  raiseRouteLevel(f.workspace("t1"), 8, "Task raises the route level");
  raiseRouteLevel(f.checkout, 9, "Main raises the route level");
  const stopped = await f.run(f.checkout, "land", "t1");
  assert.equal(stopped.status, 1, stopped.output);
  writeFileSync(join(f.workspace("t1"), "src", "route-level.ts"), "export const ROUTE_LEVEL = 9;\n");
  git(f.workspace("t1"), "add", ".");
  git(f.workspace("t1"), "commit", "-m", "Resolve the merge by hand");
  const raised = await f.run(f.checkout, "land", "t1", "--no-review");
  assert.equal(raised.status, 0, raised.output);
  assert.match(raised.output, /so the level is raised to 11\./);
  // The task is still submitted (--no-review), so the landing can run
  // once more: the same fork point, task head and main head give the same
  // right level, which the tree already reports, so nothing is raised.
  f.box.requests.length = 0;
  const again = await f.run(f.checkout, "land", "t1", "--no-review");
  assert.equal(again.status, 0, again.output);
  assert.match(again.output, /main at [0-9a-f]{8} is already merged into t1's workspace\./);
  assert.doesNotMatch(again.output, /each raised the route level/);
  assert.equal(git(f.workspace("t1"), "log", "--format=%s").split("\n").filter((s) => /^Raise the route level/.test(s)).length, 1);
  assert.match(readFileSync(join(f.workspace("t1"), "src", "route-level.ts"), "utf8"), /ROUTE_LEVEL = 11;/);
  assert.equal(f.posts("/land").find((x) => x.body.step === "merge").body.routeLevel, undefined);
});

test("a merge that brought main in through a side branch still compares and raises the route level", async (t) => {
  const f = await landFixture(t, { seedRouteLevel: 6 });
  // Both sides raise 6 to 7, so every merge below is clean at 7.
  raiseRouteLevel(f.workspace("t1"), 7, "Task raises the route level");
  raiseRouteLevel(f.checkout, 7, "Main raises the route level");
  // Main reaches the task's head through a side branch: main merged into
  // the side branch, the side branch into the task's line. The merge that
  // brought main in is no merge of HEAD's first-parent line at all, so a
  // --first-parent rev-list finds nothing and the comparison would be
  // skipped exactly where both sides raised the level.
  const w = f.workspace("t1");
  git(w, "checkout", "-q", "-b", "side");
  git(w, "fetch", "-q", f.baseline, "main");
  git(w, "merge", "-q", "--no-ff", "-m", "Merge main into the side branch", "FETCH_HEAD");
  git(w, "checkout", "-q", "main");
  git(w, "merge", "-q", "--no-ff", "-m", "Merge the side branch into the task", "side");
  git(w, "push", "-q", "origin", "main");
  // The premise of the regression: this topology leaves the --first-parent
  // rev-list empty, so the merge that brought main in must be found another way.
  const mainHead = git(f.checkout, "rev-parse", "HEAD");
  assert.equal(git(w, "rev-list", "--first-parent", "--ancestry-path", `${mainHead}..HEAD`), "");
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /main at [0-9a-f]{8} is already merged into t1's workspace\./);
  assert.match(r.output, /main and t1 each raised the route level from 6 \(main to 7, t1 to 7\), and the merge left it at 7: the merged CLI calls both sides' routes, so the level is raised to 8\. Deploy the server from a checkout at route level 8 or newer/);
  // The raise is its own commit above the side branch's merge, measured
  // from the task's head before that merge, and it is what lands.
  const subjects = git(w, "log", "--format=%s").split("\n");
  assert.ok(subjects.includes("Merge the side branch into the task"));
  assert.equal(subjects.filter((s) => /^Raise the route level/.test(s)).length, 1);
  assert.match(readFileSync(join(w, "src", "route-level.ts"), "utf8"), /ROUTE_LEVEL = 8;/);
  assert.match(git(f.p, "--git-dir", f.baseline, "show", "main:src/route-level.ts"), /ROUTE_LEVEL = 8;/);
  assert.equal(f.box.states.t1, "merged");
  // The merge step records the skipped merge beside the levels it compared and set.
  const merge = f.posts("/land").find((x) => x.body.step === "merge");
  assert.equal(merge.body.skipped, true);
  assert.deepEqual(merge.body.routeLevel, { base: 6, main: 7, task: 7, was: 7, set: 8 });
});

test("a repo with no route-level file skips the comparison and the landing goes on", async (t) => {
  const f = await landFixture(t, { mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.doesNotMatch(r.output, /route level/);
  assert.ok(!existsSync(join(f.workspace("t1"), "src", "route-level.ts")));
  assert.equal(f.posts("/land").find((x) => x.body.step === "merge").body.routeLevel, undefined);
  assert.equal(f.box.states.t1, "merged");
});

test("--dry-run says a merge that finds both sides raised the route level raises it past both", async (t) => {
  const f = await landFixture(t, { seedRouteLevel: 6 });
  raiseRouteLevel(f.workspace("t1"), 7, "Task raises the route level");
  raiseRouteLevel(f.checkout, 7, "Main raises the route level");
  const before = git(f.workspace("t1"), "rev-parse", "HEAD");
  const r = await f.run(f.checkout, "land", "t1", "--dry-run");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /2\. merge main into t1's workspace \(.*\); on conflicts, stop and leave them for you to resolve, naming the files, or send them to the task's builder: atelier dispatch t1 --job merge-main; where main and the task each raised the route level \(src\/route-level\.ts\) from one base, raise the merged level past both/);
  assert.equal(git(f.workspace("t1"), "rev-parse", "HEAD"), before);
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

// The queued ask is the route whose meaning changed (t249), so --wait is
// where an older server would bite: a level 9 server, which lacks the
// queue, would read `{ item, queued: true }` as a take and refuse it, so
// the wait would crash on the 409 instead of waiting. The start refusal
// above must reach --wait too, before any queued ask is made of it.
test("a server a route level lower than the CLI's refuses --wait at start, saying to deploy, before any queued ask", async (t) => {
  const f = await landFixture(t);
  f.box.routeLevel = ROUTE_LEVEL - 1;
  f.box.lease = { item: "t2", holder: "owner", at: "2026-10-07T09:00:00.000Z", renewedAt: new Date().toISOString() };
  f.box.waiting = [{ item: "t3", holder: "owner", at: "2026-10-07T09:14:00.000Z", renewedAt: new Date().toISOString() }];
  f.box.requests.length = 0;
  const r = await f.run(f.checkout, "land", "t1", "--wait");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, new RegExp(`runs route level ${ROUTE_LEVEL - 1}`));
  assert.match(r.output, new RegExp(`this CLI route level ${ROUTE_LEVEL}`));
  assert.match(r.output, /Deploy the server/);
  // Nothing was asked of the lease — no queued ask, no take — and the lease
  // and the queue stand exactly as they were.
  assert.deepEqual(f.box.requests.filter((x) => x.method === "POST"), []);
  assert.equal(f.box.lease?.item, "t2");
  assert.deepEqual(f.box.waiting.map((w) => w.item), ["t3"]);
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

// Waits until `count()` has gone quiet — unchanged for `quiet` ms, several
// of the heartbeat's beats — and returns what it settled on. A stream that
// keeps coming never settles, so this waits on the renewal calls themselves
// rather than proving they stopped with a fixed sleep on the clock.
async function settled(count, quiet, ms = 15_000, what = "the count") {
  let last = count(), at = Date.now();
  for (const t0 = Date.now();;) {
    if (Date.now() - t0 > ms) throw new Error(`${what} did not settle within ${ms}ms`);
    await new Promise((ok) => setTimeout(ok, 10));
    const now = count();
    if (now !== last) { last = now; at = Date.now(); }
    else if (Date.now() - at >= quiet) return last;
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

test("while the review request is unclaimed and no live runner offers the reviewer, the landing says it can never be claimed", async (t) => {
  const f = await landFixture(t);
  f.box.review.approveAfter = 4;
  // No runner offers the review job for the routed reviewer: one offers the
  // job under another model, one offers no review job, one is the wrong kind.
  f.box.runners = [
    { runner: "cloud:far", kind: "cloud", jobs: ["build", "review"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }], at: new Date().toISOString() },
    { runner: "home:mbp", kind: "home", jobs: ["build", "plan"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }], at: new Date().toISOString() },
    { runner: "home:studio", kind: "home", jobs: ["build", "plan", "review"], agents: [{ agent: "opencode", models: ["glm-5.3"] }], at: new Date().toISOString() },
  ];
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /The review request is not claimed yet, and no live runner can take it: cloud:far is a cloud runner, not a home one; home:mbp offers no review job; home:studio offers review as opencode\/glm-5\.3\. It will not be claimed until a runner that offers codex\/gpt-6-astra for the review job asks the server for work\. Review it by hand \(atelier review t1 --approve --as codex\/gpt-6-astra --note "…"\), then atelier accept t1 and atelier merge t1, or run atelier land t1 again with --reviewer H\/M to ask a model a live runner offers\./);
  // Said once, not on every poll, and the landing still lands on approval.
  assert.equal(r.output.split("The review request is not claimed yet").length - 1, 1);
  assert.equal(f.box.states.t1, "merged");
  // A runner that offers the reviewer reads as an ordinary wait again.
  const g = await landFixture(t);
  g.box.review.approveAfter = 3;
  g.box.runners = [{ runner: "home:studio", kind: "home", jobs: ["build", "plan", "review"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }], at: new Date().toISOString() }];
  const offered = await g.run(g.checkout, "land", "t1");
  assert.equal(offered.status, 0, offered.output);
  assert.doesNotMatch(offered.output, /no live runner/);
  assert.equal(g.box.states.t1, "merged");
  // No runner has ever asked: said as that, not as a mismatch.
  const h = await landFixture(t);
  h.box.review.approveAfter = 3;
  h.box.runners = [];
  const none = await h.run(h.checkout, "land", "t1");
  assert.equal(none.status, 0, none.output);
  assert.match(none.output, /The review request is not claimed yet, and no runner has asked the server for work\. It will not be claimed until a runner that offers codex\/gpt-6-astra for the review job asks the server for work\./);
  assert.equal(h.box.states.t1, "merged");
});

test("a refused renewal stops the heartbeat and is said once, and the lost lease is left alone; a failed one is retried and warned of once", async (t) => {
  const f = await landFixture(t);
  const beatMs = 40;
  const landing = waitingLanding(f, { ATELIER_LAND_RENEW_MS: String(beatMs) });
  const renewals = () => f.posts("/landing-lease").filter((x) => x.body.renew === true).length;
  await until(() => renewals() >= 2, 15_000, "two renewals");
  // The server cannot be reached for a while: one warning, renewals go on.
  f.box.renewFails = true;
  await until(() => landing.output().includes("could not be renewed"), 15_000, "the warning");
  const failed = renewals();
  await until(() => renewals() >= failed + 3, 15_000, "three more renewals");
  assert.equal(landing.output().split("could not be renewed").length - 1, 1);
  f.box.renewFails = false;
  await until(() => landing.output().includes("renewed again"), 15_000, "the recovery");
  // Another landing took the lease over: the renewal is refused, said once,
  // and no renewal follows — the renewal calls themselves must settle, quiet
  // for several beats, at the count the refusal left them at.
  f.box.lease = { item: "t2", holder: "owner", at: new Date().toISOString(), renewedAt: new Date().toISOString() };
  await until(() => landing.output().includes("no longer t1's"), 15_000, "the loss");
  const after = renewals();
  // The landing stops on its own — every step, and each poll of the review
  // wait, asks the guard — so its end is waited for, not raced with a sleep.
  const ended = await landing.done;
  assert.equal(ended.status, 1, landing.output());
  assert.match(landing.output(), /run atelier land t1 again once the other landing ends/);
  assert.equal(await settled(renewals, beatMs * 5, 15_000, "the renewals"), after, "renewals continued after the refusal");
  assert.equal(landing.output().split("no longer t1's").length - 1, 1);
  // The landing's end leaves t2's lease where it is.
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

// ── atelier land --workflow (t280) ──────────────────────────────────────────

// The stand-in landing Workflow as the real one moves (src/landing-workflow.ts):
// it queues for the lease, then holds it and asks for the workspace (on its
// second read, so the executor sees the queueing first); a report of the
// round's pushed head makes it accept (as the review and the checks would on
// the server) and ask for the merge; a report of conflicts pauses it with the
// lease released; a resume starts the next round; the recorded merge
// completes it.
function scriptWorkflow(f) {
  const wf = f.box.wf;
  let leaseReads = 0;
  wf.tick = (box) => {
    if (wf.stage === "lease" && ++leaseReads >= 2) {
      const now = new Date().toISOString();
      wf.stage = "workspace"; box.lease = { item: "t1", holder: "owner", at: now, renewedAt: now };
    }
    if (wf.stage === "merge" && box.states.t1 === "merged") { wf.stage = "done"; wf.status = "complete"; wf.output = { landed: true }; box.lease = null; }
  };
  wf.onEvent = (event, box) => {
    if (event.type === "workspace" && event.payload.round !== wf.round) return;
    if (event.type === "workspace" && event.payload.conflict) { wf.stage = "conflict"; wf.files = event.payload.files; box.lease = null; }
    else if (event.type === "workspace" && event.payload.failed) { wf.stage = "failed"; wf.status = "errored"; wf.error = event.payload.reason; box.lease = null; }
    else if (event.type === "workspace") { wf.stage = "merge"; box.states.t1 = "accepted"; }
    else if (event.type === "resume" && event.payload.round === wf.round) { wf.stage = "lease"; wf.round++; leaseReads = 0; }
  };
  return wf;
}

test("land --workflow starts the Workflow, merges main and pushes only once the Workflow holds the lease, reports the head, and merges when it accepts", async (t) => {
  const f = await landFixture(t, { mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  const wf = scriptWorkflow(f);
  const before = git(f.checkout, "rev-parse", "HEAD");
  const r = await f.run(f.checkout, "land", "t1", "--workflow", "--checks", "container");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /Landing t1 as a Cloudflare Workflow \(instance land-t1-1\)/);
  assert.equal(wf.started[0].checks, "container");
  assert.match(r.output, /runs the checks \(in a Cloudflare container\)/);
  assert.match(r.output, /The landing Workflow queues for the landing lease\./);
  assert.match(r.output, /The landing Workflow holds the lease and waits for this machine to merge main and push\./);
  assert.match(r.output, /t1 landed through the landing Workflow/);
  // The merge of main began only when the Workflow held the lease (the
  // merge in the checkout reads the baseline's token later, at `merge`).
  assert.equal(wf.baseTokenAt[0], "workspace");
  assert.ok(!wf.baseTokenAt.includes("lease"));
  // The workspace report names the round, the pushed head and main's head.
  const head = git(f.workspace("t1"), "rev-parse", "HEAD");
  assert.equal(f.forkHead("t1"), head);
  assert.deepEqual(wf.events, [{ type: "workspace", payload: { round: 0, head, mainHead: f.mainCommit, mergedIn: true } }]);
  // The server's steps are the Workflow's: this machine ran no check and
  // made no submission, review request or acceptance of its own.
  for (const route of ["/submit", "/review-request", "/accept", "/sandbox"]) assert.deepEqual(f.posts(route), [], route);
  assert.deepEqual(f.posts("/land").map((x) => x.body.step), ["merge", "regenerate", "push", "merged"]);
  // The merge in the registered checkout holds the pushed head.
  assert.equal(f.box.states.t1, "merged");
  assert.deepEqual(git(f.checkout, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").slice(1), [before, head]);
});

test("land --workflow pauses the Workflow on a conflict, and the rerun after the owner resolves it resumes the landing in a new round", async (t) => {
  const f = await landFixture(t, { mainChange: { file: "work.txt", text: "from main\n", message: "Main edits the same file" } });
  const wf = scriptWorkflow(f);
  const r = await f.run(f.checkout, "land", "t1", "--workflow");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /stops on conflicts in:\nwork\.txt/);
  assert.match(r.output, /The landing Workflow is paused at its conflict stage and has released the lease\. Once the conflicts are resolved and committed, run atelier land t1 --workflow again: it resumes this landing\./);
  assert.equal(wf.events.length, 1);
  assert.deepEqual({ ...wf.events[0].payload, reason: undefined }, { round: 0, conflict: true, files: ["work.txt"], reason: undefined });
  assert.ok(existsSync(join(f.workspace("t1"), ".git", "MERGE_HEAD")));
  assert.deepEqual(f.posts("/push"), []);
  assert.equal(wf.stage, "conflict");
  // The owner resolves and commits; the rerun attaches, resumes round 0's
  // pause, and does the workspace steps of round 1 when the Workflow asks.
  writeFileSync(join(f.workspace("t1"), "work.txt"), "task and main\n");
  git(f.workspace("t1"), "add", "-A"); git(f.workspace("t1"), "commit", "--no-edit", "-q");
  const again = await f.run(f.checkout, "land", "t1", "--workflow");
  assert.equal(again.status, 0, again.output);
  assert.match(again.output, /Attached to t1's landing Workflow \(instance land-t1-1, at conflict\)/);
  assert.match(again.output, /Resumed the landing after the conflicts of round 1/);
  assert.equal(wf.started.length, 1);
  const head = git(f.workspace("t1"), "rev-parse", "HEAD");
  assert.deepEqual(wf.events.slice(1), [{ type: "resume", payload: { round: 0 } }, { type: "workspace", payload: { round: 1, head, mainHead: f.mainCommit, mergedIn: false } }]);
  assert.equal(f.box.states.t1, "merged");
});

test("land --workflow ends with the Workflow's own reason when the Workflow fails", async (t) => {
  const f = await landFixture(t);
  const wf = scriptWorkflow(f);
  wf.onEvent = (event, box) => { wf.stage = "failed"; wf.status = "errored"; wf.error = "the required checks failed at abcdef12 in the Cloudflare container: npm test"; box.lease = null; };
  const r = await f.run(f.checkout, "land", "t1", "--workflow");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /the landing Workflow land-t1-1 failed: the required checks failed at abcdef12 in the Cloudflare container: npm test/);
  assert.deepEqual(f.posts("/merged"), []);
});

test("land --workflow refuses an accepted task with no live Workflow, as the plain landing does, and starts nothing", async (t) => {
  const f = await landFixture(t);
  scriptWorkflow(f);
  f.box.states.t1 = "accepted";
  const r = await f.run(f.checkout, "land", "t1", "--workflow");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /t1 is accepted at \w+; merge it with: atelier merge t1\./);
  assert.deepEqual(f.posts("/landing-workflow"), []);
});

test("land without --workflow never reaches the landing Workflow, and --dry-run with --workflow is refused", async (t) => {
  const f = await landFixture(t);
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.doesNotMatch(r.output, /Merge it with: atelier merge t1/);
  assert.equal((r.output.match(/The project branch was not pushed to its own remotes\. Nothing was deployed\./g) ?? []).length, 1);
  assert.match(r.output, /t1 landed: merged as [0-9a-f]{8}\.\n/);
  assert.ok(f.box.requests.every((x) => !x.path.includes("landing-workflow")));
  assert.equal(f.box.states.t1, "merged");
  const both = await f.run(f.checkout, "land", "t2", "--workflow", "--dry-run");
  assert.equal(both.status, 1, both.output);
  assert.match(both.output, /--dry-run and --workflow together say two things/);
});

// ── the local checks mode (t305) ────────────────────────────────────────────

test("land --workflow runs the required checks here in a clean clone after the push, by default, and reports the head only once they pass", async (t) => {
  const f = await landFixture(t, { mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  const wf = scriptWorkflow(f);
  const r = await f.run(f.checkout, "land", "t1", "--workflow");
  assert.equal(r.status, 0, r.output);
  // The mode is local without --checks, sent to the server and said.
  assert.equal(wf.started[0].checks, "local");
  assert.match(r.output, /runs the required checks in a clean clone \(checks mode local\)/);
  assert.match(r.output, /Pushed \w+ to t1's fork; running the required checks in a clean clone\./);
  assert.match(r.output, /The required checks pass at \w+; reporting the head to the landing Workflow\./);
  // The check ran through atelier check (its observed result posted to the
  // server at the pushed head) after the push and before the report.
  const head = git(f.workspace("t1"), "rev-parse", "HEAD");
  const at = (pred) => f.box.requests.findIndex(pred);
  const pushed = at((x) => x.method === "POST" && x.path.endsWith("/t1/push"));
  const checked = at((x) => x.method === "POST" && x.path.endsWith("/t1/evidence") && x.body.kind === "check");
  const reported = at((x) => x.method === "POST" && x.path.endsWith("/landing-workflow") && x.body.event?.type === "workspace");
  assert.ok(pushed >= 0 && checked > pushed && reported > checked, `push ${pushed}, check ${checked}, report ${reported}`);
  const evidence = f.box.requests[checked].body;
  assert.equal(evidence.claim, "exit 0"); assert.equal(evidence.passed, true); assert.equal(evidence.head, head);
  assert.deepEqual(wf.events, [{ type: "workspace", payload: { round: 0, head, mainHead: f.mainCommit, mergedIn: true } }]);
  // The executor records the check step it ran, as the plain landing does;
  // the submission, the review and the acceptance stay the Workflow's.
  assert.deepEqual(f.posts("/land").map((x) => x.body.step), ["merge", "regenerate", "push", "check", "merged"]);
  for (const route of ["/submit", "/review-request", "/accept", "/sandbox"]) assert.deepEqual(f.posts(route), [], route);
  assert.equal(f.box.states.t1, "merged");
});

test("land --workflow with a failing local check reports the workspace failed, never the head, and ends with the check's failure", async (t) => {
  const f = await landFixture(t);
  const wf = scriptWorkflow(f);
  f.box.checks = ["exit 3"];
  const r = await f.run(f.checkout, "land", "t1", "--workflow");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /atelier check failed/);
  assert.equal(wf.events.length, 1);
  assert.equal(wf.events[0].payload.failed, true);
  assert.equal(wf.events[0].payload.head, undefined);
  assert.match(wf.events[0].payload.reason, /atelier check failed/);
  const check = f.posts("/land").find((x) => x.body.step === "check");
  assert.equal(check?.body.failed, true);
  assert.deepEqual(f.posts("/merged"), []);
});

test("land --workflow --checks container runs no check here; --checks is refused without --workflow or with another mode; a server with no modes is warned of", async (t) => {
  const f = await landFixture(t);
  const wf = scriptWorkflow(f);
  const alone = await f.run(f.checkout, "land", "t1", "--checks", "local");
  assert.equal(alone.status, 1, alone.output);
  assert.match(alone.output, /--checks says where a Workflow landing runs the required checks; give it with --workflow/);
  const bogus = await f.run(f.checkout, "land", "t1", "--workflow", "--checks", "laptop");
  assert.equal(bogus.status, 1, bogus.output);
  assert.match(bogus.output, /--checks takes local or container: atelier land t1 --workflow --checks local\|container/);
  assert.deepEqual(f.posts("/landing-workflow"), []);
  // A server older than the modes records none and runs the checks in the
  // container: this machine runs none and says so.
  wf.noChecksMode = true;
  const old = await f.run(f.checkout, "land", "t1", "--workflow");
  assert.equal(old.status, 0, old.output);
  assert.match(old.output, /Warning: the server recorded no checks mode for this landing/);
  assert.deepEqual(f.posts("/evidence"), []);
  assert.ok(!f.posts("/land").some((x) => x.body.step === "check"));
});

test("land --workflow reports a finished landing, not a lost one, when the merged task no longer names its Workflow (t308)", async (t) => {
  const f = await landFixture(t, { mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  const wf = scriptWorkflow(f);
  // As in production on 2026-10-08: once the task is merged, the route
  // answers with no instance instead of a completed one.
  const tick = wf.tick;
  wf.tick = (box) => { tick(box); if (box.states.t1 === "merged") wf.instance = null; };
  const r = await f.run(f.checkout, "land", "t1", "--workflow", "--checks", "container");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /t1 landed through the landing Workflow; the lease is released\./);
  assert.doesNotMatch(r.output, /can no longer be read/);
  assert.ok(f.posts("/landing-lease").some((x) => x.body.cancel === true && x.body.item === "t1"));
});

// The workspace's write token (t275), against runLand with injected fakes:
// the server's answers, Git's (a real repository only where the preflight
// reads one from disk, under .scratch/) and the CLI's own steps. The task is
// held by codex/test, the owner is "owner", and the workspace records
// `expiresAt` as its token's expiry (none when null).
function tokenLanding(t, { expiresAt, claim = "ok", holder = "codex/test", runner = null, workflow = false, push = [] } = {}) {
  const scratch = resolve(".scratch"); mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "land-token-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", dir]);
  const config = { "atelier.project": "proj", "atelier.item": "t1", "atelier.actor": "codex/test", ...(expiresAt ? { "atelier.write-token-expires-at": expiresAt } : {}) };
  const calls = [], lines = [], adopted = [], commands = [];
  const itemPath = "/projects/proj/items/t1", leasePath = "/projects/proj/landing-lease";
  const fresh = new Date(Date.now() + 8 * 3600_000).toISOString();
  const request = async (method, path, body, as, extra) => {
    calls.push({ method, path, body, as, extra });
    if (path === "/version") return { routeLevel: ROUTE_LEVEL, commit: "c0ffee" };
    if (path === leasePath && method === "GET") return { lease: null, waiting: [] };
    if (path === leasePath) return body.cancel ? {} : { item: { id: "t1", state: "submitted" } };
    if (path === itemPath) return { item: { id: "t1", state: "submitted", owner: holder, runner }, policy: { checks: [] } };
    if (path === `${itemPath}/claim`) {
      if (claim !== "ok") throw Object.assign(new Error(claim), { status: 409 });
      return { item: { id: "t1" }, workspace: { remote: "https://fork.invalid/t1.git", token: "fresh-token", expiresAt: fresh, defaultBranch: "main" } };
    }
    if (path === `${itemPath}/base-token`) return { remote: "https://base.invalid/main.git", token: "read", defaultBranch: "main" };
    if (path === `${itemPath}/landing-workflow`) return method === "GET" && calls.some((c) => c.method === "POST" && c.path === path)
      ? { instance: "w1", stage: "done", round: 0, status: { status: "complete" } }
      : method === "GET" ? { instance: null, status: null } : { instance: "w1", created: true, checks: "local", stage: "lease" };
    return {};
  };
  // Git as a landing asks it: main already merged, nothing to compare or
  // regenerate, the config above.
  const fakeGit = (args, o = {}) => {
    const out = args[0] === "config" ? config[args.at(-1)] ?? null : args[0] === "rev-parse" ? "a".repeat(40) : "";
    if (o.allowFail) return { status: out === null ? 1 : 0, stdout: out ?? "", stderr: "" };
    return out ?? "";
  };
  // Each `atelier push` answers the next of `push` (true passes, a string
  // fails with that output); every other step passes.
  const pushes = [...push];
  const runCommand = async (argv) => {
    commands.push(argv[2]);
    const next = argv[2] === "push" ? pushes.shift() ?? true : true;
    return next === true ? { passed: true, status: 0, output: "ok\n", durationMs: 1 } : { passed: false, status: 1, output: `${next}\n`, durationMs: 1 };
  };
  const io = {
    args: { _: ["land", "t1"], ...(workflow ? { workflow: true } : { "no-review": true }) }, name: "proj", id: "t1", p: { path: dir, branch: "main" },
    request, git: fakeGit, print: (line) => lines.push(line), die: (message) => { throw new Error(message); },
    workspacePath: () => dir, atelier: "atelier.mjs", env: {}, redact: (text) => text, secrets: () => [], runCommand,
    adoptWorkspaceToken: (where, w) => { adopted.push({ where, ...w }); config["atelier.write-token-expires-at"] = w.expiresAt; },
  };
  const leaseTaken = () => calls.some((c) => c.method === "POST" && c.path === leasePath && !c.body.cancel);
  const claims = () => calls.filter((c) => c.path === `${itemPath}/claim`);
  return { io, dir, calls, lines, adopted, commands, leaseTaken, claims, fresh };
}

test("a write token expiring within the window is refreshed for the holder before the lease is taken (t275)", async (t) => {
  const l = tokenLanding(t, { expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), runner: "home:mbp" });
  await runLand(l.io);
  assert.equal(l.claims().length, 1);
  // The re-claim is made as the holder, with the runner holding the task, never as the owner.
  assert.equal(l.claims()[0].as, "codex/test");
  assert.notEqual(l.claims()[0].as, "owner");
  assert.deepEqual(l.claims()[0].extra, { "x-atelier-runner": "home:mbp" });
  assert.deepEqual(l.adopted.map((a) => [a.where, a.token, a.expiresAt]), [[l.dir, "fresh-token", l.fresh]]);
  const claimAt = l.calls.findIndex((c) => c.path.endsWith("/claim"));
  const leaseAt = l.calls.findIndex((c) => c.method === "POST" && c.path.endsWith("/landing-lease") && !c.body.cancel);
  assert.ok(claimAt >= 0 && leaseAt > claimAt, "the refresh comes before the lease");
  assert.ok(l.lines.some((x) => /write token expires .*refreshing it for its holder before the landing takes the lease/.test(x)), l.lines.join("\n"));
  assert.deepEqual(l.commands, ["push", "check", "submit"]);
});

test("a write token far from expiry is not refreshed, and an unknown expiry is refreshed once and recorded (t275)", async (t) => {
  const far = tokenLanding(t, { expiresAt: new Date(Date.now() + 4 * 3600_000).toISOString() });
  await runLand(far.io);
  assert.equal(far.claims().length, 0);
  assert.ok(far.leaseTaken());
  const unknown = tokenLanding(t, { expiresAt: null });
  await runLand(unknown.io);
  assert.equal(unknown.claims().length, 1);
  assert.equal(unknown.claims()[0].as, "codex/test");
  assert.ok(unknown.lines.some((x) => /records no write token expiry/.test(x)), unknown.lines.join("\n"));
  // The refresh recorded the expiry, so the next landing reads it and claims nothing.
  await runLand(unknown.io);
  assert.equal(unknown.claims().length, 1);
});

test("a refresh the server refuses stops the landing before the lease, naming atelier claim (t275)", async (t) => {
  const l = tokenLanding(t, { expiresAt: new Date(Date.now() - 60_000).toISOString(), claim: "owned: t1 is held by codex/test on home:mbp, not a claim made without a runner" });
  await assert.rejects(runLand(l.io), (error) => {
    assert.match(error.message, /could not be refreshed, so the landing stops before taking the lease/);
    assert.match(error.message, /atelier claim t1/);
    return true;
  });
  assert.equal(l.claims().length, 1);
  assert.equal(l.leaseTaken(), false);
  assert.deepEqual(l.commands, []);
  assert.deepEqual(l.adopted, []);
});

test("a workspace whose recorded actor is not the task's holder is not refreshed: nothing is claimed, as the owner or anyone (t275)", async (t) => {
  for (const holder of ["owner", "claude-code/opus-5.5", null]) {
    const l = tokenLanding(t, { expiresAt: null, holder });
    await assert.rejects(runLand(l.io), /atelier claim t1/);
    assert.equal(l.claims().length, 0, `held by ${holder}`);
    assert.equal(l.leaseTaken(), false);
  }
});

test("land --workflow refreshes the write token before starting the Workflow, and starts none when the refresh fails (t275)", async (t) => {
  const ok = tokenLanding(t, { expiresAt: new Date(Date.now() + 60_000).toISOString(), workflow: true });
  await runLand(ok.io);
  const started = ok.calls.findIndex((c) => c.method === "POST" && c.path.endsWith("/landing-workflow"));
  assert.equal(ok.claims().length, 1);
  assert.equal(ok.claims()[0].as, "codex/test");
  assert.ok(started > ok.calls.findIndex((c) => c.path.endsWith("/claim")));
  const refused = tokenLanding(t, { expiresAt: new Date(Date.now() + 60_000).toISOString(), workflow: true, claim: "not_owner: refused" });
  await assert.rejects(runLand(refused.io), /atelier claim t1/);
  assert.equal(refused.calls.filter((c) => c.method === "POST" && c.path.endsWith("/landing-workflow")).length, 0);
});

test("a push refused for an expired token is refreshed for the holder and tried exactly once more (t275)", async (t) => {
  const once = tokenLanding(t, { expiresAt: new Date(Date.now() + 4 * 3600_000).toISOString(), push: ["remote: Invalid or expired token\nfatal: unable to access the fork"] });
  await runLand(once.io);
  assert.deepEqual(once.commands, ["push", "push", "check", "submit"]);
  assert.equal(once.claims().length, 1);
  assert.equal(once.claims()[0].as, "codex/test");
  assert.equal(once.adopted.length, 1);
  // Refused again after the refresh: no third push, and the landing ends.
  const twice = tokenLanding(t, { expiresAt: new Date(Date.now() + 4 * 3600_000).toISOString(), push: ["Invalid or expired token", "Invalid or expired token"] });
  await assert.rejects(runLand(twice.io), /atelier push failed[\s\S]*Invalid or expired token/);
  assert.deepEqual(twice.commands, ["push", "push"]);
  assert.equal(twice.claims().length, 1);
  // The lease is released either way.
  assert.ok(twice.calls.some((c) => c.method === "POST" && c.path.endsWith("/landing-lease") && c.body.cancel === true));
});

test("a push that fails for any other reason is not refreshed or retried (t275)", async (t) => {
  const l = tokenLanding(t, { expiresAt: new Date(Date.now() + 4 * 3600_000).toISOString(), push: ["error: failed to push some refs (non-fast-forward)"] });
  await assert.rejects(runLand(l.io), /non-fast-forward/);
  assert.deepEqual(l.commands, ["push"]);
  assert.equal(l.claims().length, 0);
});
