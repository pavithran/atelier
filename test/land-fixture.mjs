// The shared fixture and helpers of the atelier land tests in
// test/land.test.mjs, test/land-wait-merge.test.mjs and
// test/land-lease-workflow.test.mjs, split out of test/land.test.mjs (t550) so
// each test file stays well under test/guard.mjs's per-file limit. Not a test
// file itself: discovery (test/suites.mjs) runs only *.test.* and *.spec.* files.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ROUTE_LEVEL, SERVER_CAPABILITIES } from "../src/route-level.ts";
import { landingLeaseLapsed, waitingLandingGone } from "../src/landing-lease.ts";

export const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export function root(t) { const p = mkdtempSync(join(tmpdir(), "atelier-landcmd-")); t.after(() => rmSync(p, { recursive: true, force: true })); return p; }

// The owner's checkout, the baseline, and each task's fork and workspace,
// served by a stand-in ledger that answers from `box`: the items' states, the
// landing lease, the server's version (route level and commit), whether the
// gate needs a review (the reviewer approves, or rejects when `approve` is
// false, on the first poll after the request; a request naming a reviewer
// with `wanted` is made even where the gate needs none, as the server does),
// and every request made, so a test can say what a landing
// changed.
export async function landFixture(t, { mainChange = null, taskChange = "task\n", conflict = false, seedRouteLevel = null } = {}) {
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
    states: {}, reviews: { t1: [], t2: [] }, lease: null, waiting: [], version: null, routeLevel: ROUTE_LEVEL, capabilities: SERVER_CAPABILITIES, policy: {},
    review: { needed: true, reviewer: "codex/gpt-6-astra", approve: true, pending: false, at: null, approveAfter: 0, claimed: false, skips: [] },
    requests: [], leaseLog: [], regen: "echo generated > gen-fixtures.txt", checks: ["exit 0"], items: [], queue: [], runners: null, renewFails: false, kinds: {},
    // The evidence each check posts, as the server records it (t436): the
    // landing's failure summary reads the failed checks from it.
    evidence: { t1: [], t2: [] }, evidenceId: 0,
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
    // A task other than t1 has a reviewer of its own where a test gives it
    // one (`box.reviewOf`), so two landings can wait for their reviews at
    // once (t550); without one it never gets a verdict, as before.
    const rv = id === "t1" ? box.review : box.reviewOf?.[id];
    const due = rv && rv.pending && rv.approveAfter !== null && rv.approveAfter-- <= 0;
    const reviews = due ? (box.reviews[id].push({ by: rv.reviewer, approve: rv.approve, head, note: rv.approve ? "Land fixture approves." : "Land fixture rejects.", at: new Date().toISOString() }), rv.pending = false, box.reviews[id]) : box.reviews[id];
    const state = box.states[id];
    const events = [
      ...(id === "t1" && box.review.claimed && box.review.at ? [{ seq: 1, itemId: id, at: box.review.at, actor: box.review.reviewer, kind: "review.claimed", data: { head, runner: "home:mbp" } }] : []),
      // A skip names the request it refused (t353); the fixture's open
      // request is number 1 unless a test asks for another.
      ...(box.review.skips ?? []).map((s, i) => ({ seq: 100 + i, itemId: id, at: new Date().toISOString(), actor: s.runner, kind: "review.skipped", data: { head, runner: s.runner, request: s.request ?? 1 } })),
    ];
    return {
      item: { id, title: `Fixture ${id}`, state, owner: box.holder ?? "codex/test", ...(box.pushActors ? { pushActors: box.pushActors } : {}), head, ...(box.kinds[id] ? { kind: box.kinds[id] } : {}), acceptedHead: state === "accepted" || state === "merged" ? head : null },
      policy: { reviewerAdmissions: box.reviewerAdmissions, checks: box.checks, protected: ["work.txt"], regenerate: box.regen, commitIdentity: { name: "Fixture", email: "fixture@example.invalid", agentEmails: [] }, ...(box.agents ? { agents: box.agents } : {}), ...(box.eligible ? { eligible: box.eligible } : {}), ...box.policy },
      gate: box.gate ?? { ready: true, outOfScope: [], blockers: [] }, evidence: box.evidence[id] ?? [], reviews, events,
    };
  };
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const url = req.url;
    box.requests.push({ method: req.method, path: url, body, as: req.headers["x-atelier-actor"] });
    // A test can hold a request unanswered (`box.holdOn`), so a landing stays
    // at that step — under the lease, since t550, only its last steps are.
    if (box.holdOn?.(url, body)) {
      box.holding = url;
      while (box.holdOn?.(url, body) && !box.ended) await new Promise((ok) => setTimeout(ok, 20));
      box.holding = null;
      // One still held when its test ended is dropped unanswered.
      if (box.ended) { res.destroy(); return; }
    }
    const item = /\/items\/(t\d+)/.exec(url)?.[1];
    const head = item ? forkHead(item) : null;
    let answer = item ? detail(item) : {};
    const fail = (status, error, detailText) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ error, detail: detailText })); };
    // A server publishes its named capabilities, as a deployed one does; a
    // test that sets another route level (or none) stands in for a server
    // from before them, answering the legacy route level alone.
    if (url === "/api/version") answer = { commit: box.version ?? repoHead, ...(box.capabilities && box.routeLevel === ROUTE_LEVEL ? { capabilities: box.capabilities } : box.routeLevel === null ? {} : { routeLevel: box.routeLevel }) };
    else if (url.endsWith("/landing-workflow")) {
      // A stand-in for the landing Workflow (t280): the instance the route
      // remembers, its stage and round, and its status. A test moves it on
      // through `wf.tick` (after each read) and `wf.onEvent` (each event).
      const wf = box.wf;
      const view = () => ({ ...(wf.detail ? { detail: wf.detail } : {}), ...(wf.readError ? { readError: wf.readError } : {}), ...(wf.lastStatus ? { lastStatus: wf.lastStatus } : {}), instance: wf.instance, stage: wf.stage, round: wf.round, ...(wf.checks ? { checks: wf.checks } : {}), ...(wf.files ? { files: wf.files } : {}), status: wf.unreadable ? null : { status: wf.status, ...(wf.error ? { error: { name: "Error", message: wf.error } } : {}), ...(wf.output ? { output: wf.output } : {}) } });
      if (req.method === "GET") { answer = wf.instance ? view() : { instance: null, status: null, stage: null }; wf.reads++; }
      else if (body.event) { wf.events.push(body.event); wf.onEvent?.(body.event, box); answer = { sent: true, instance: wf.instance }; }
      else if (wf.instance && ["running", "waiting", "queued"].includes(wf.status) && !wf.replace) answer = { ...view(), created: false, ...(wf.attach ?? {}) };
      // A live instance the server replaces (t430): `wf.replace` names why.
      else if (wf.instance && wf.replace) { const from = wf.instance; Object.assign(wf, { instance: `land-${item}-r1`, stage: wf.firstStage ?? "lease", round: 0, checks: body.checks ?? "container", status: "running" }); wf.started.push(body); answer = { ...view(), created: true, replaced: { from, to: wf.instance, ...wf.replace } }; wf.replace = null; }
      // The checks mode is recorded as the server records it (t305):
      // container where the start names none; `wf.noChecksMode` stands in
      // for a server older than the modes, which records none.
      else { Object.assign(wf, { instance: `land-${item}-${wf.started.length + 1}`, stage: wf.firstStage ?? "lease", round: 0, checks: wf.noChecksMode ? null : body.checks ?? "container", status: "running", files: null, error: null }); wf.started.push(body); answer = { ...view(), created: true }; }
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
        answer = { held: !!box.lease, lease: box.lease };
        if (box.lease) box.leaseLog.push({ item: box.lease.item, kind: "release", i: box.requests.length });
        box.lease = null;
      }
      else if (body.confirm === true) {
        // The holder's confirmation of main under the lease (t550): the
        // server reads main itself (`box.serverMain`, else the baseline the
        // fixture pushed) and refuses a main it does not hold.
        if (!box.lease || box.lease.item !== body.item) return fail(409, "no_lease", `the landing lease is held for ${box.lease?.item ?? "nobody"}, not ${body.item}`);
        const top = box.serverMain ?? git(baseline, "rev-parse", "main");
        if (top !== body.main) return fail(409, "main_moved", `main is at ${top.slice(0, 8)}, not ${String(body.main).slice(0, 8)}, the commit ${body.item}'s head was merged with; release the lease and merge main again`);
        (box.confirmed ??= []).push({ item: body.item, main: body.main });
        answer = { confirmed: { main: body.main, head: forkHead(body.item) } };
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
        // Another landing's post-merge work refuses the lease, as many times
        // as a test asks (t477).
        if (box.postMergeBlocked > 0) { box.postMergeBlocked--; return fail(409, "post_merge_blocked", "t2's post-merge step publish is still running; the next landing waits for it"); }
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
        box.leaseLog.push({ item: body.item, kind: "take", i: box.requests.length });
        answer = { item: { id: body.item, state: box.states[body.item] }, expired };
      }
    } else if (url === "/api/projects/proj/items") answer = box.items;
    else if (url === "/api/queue") answer = box.queue;
    else if (url === "/api/runners") answer = box.runners;
    else if (url.endsWith("/base-token") || url === "/api/projects/proj/baseline-token") (box.wf.baseTokenAt.push(box.wf.stage), answer = { remote: baseline, token: "fixture", defaultBranch: "main" });
    else if (url.endsWith("/claim")) answer = { item: detail(item).item, workspace: { remote: join(p, `fork-${item}.git`), token: "fixture", defaultBranch: "main", expiresAt: "2999-01-01T00:00:00.000Z" } };
    else if (url.endsWith("/read-token")) answer = { remote: join(p, `fork-${item}.git`), token: "fixture", head, defaultBranch: "main" };
    else if (url.endsWith("/push")) { box.states[item] = "claimed"; answer = { ...answer.item, head }; }
    else if (url.endsWith("/evidence")) {
      if (item) (box.evidence[item] ??= []).push({ itemId: item, claim: body.claim, grade: body.kind === "check" ? "observed" : "reported", head: body.head, passed: body.kind === "check" ? body.passed === true : null, by: "codex/test", at: new Date().toISOString(), where: "runner", changedPaths: body.changedPaths ?? null, outputTail: body.outputTail ?? "", id: ++box.evidenceId });
      answer = item ? detail(item) : {};
    }
    else if (url.endsWith("/submit")) { box.states[item] = "submitted"; answer = detail(item); }
    else if (url.endsWith("/review-request")) {
      const rv = item !== "t1" && box.reviewOf?.[item] ? box.reviewOf[item] : box.review;
      box.reviewAsks = [...(box.reviewAsks ?? []), { item, head, at: Date.now() }];
      if (!rv.needed && !(body.wanted === true && body.reviewer)) answer = { needed: false, reason: rv.reason ?? "the gate counts an independent approval already" };
      else { rv.reviewer = body.reviewer ?? rv.reviewer; rv.pending = true; rv.at = new Date().toISOString(); answer = { needed: true, requested: true, reason: `a protected change needs an independent review${!body.reviewer && rv.why ? ` ${rv.why}` : ""}`, at: rv.at, head, reviewer: body.reviewer ?? rv.reviewer, request: rv.request ?? 1, ...(rv.withdrew ? { withdrew: rv.withdrew } : {}) }; }
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
  // A request a test held is dropped when the test ends, so no handler polls on.
  t.after(() => { box.ended = true; });
  const url = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(config, "config.json"), JSON.stringify({ server: url, owner: "owner", projects: { proj: { path: checkout, branch: "main" } } }));
  const run = async (cwd, ...args) => {
    const child = spawn(process.execPath, [resolve("cli/atelier.mjs"), ...args, "--project", "proj"], { cwd, env: { ...process.env, ATELIER_CONFIG_DIR: config, ATELIER_TOKEN: "fixture", ATELIER_CACHE: cache, ATELIER_SERVER: url, ATELIER_LAND_POLL_MS: "50", ...fx.env } });
    t.after(() => child.kill("SIGKILL"));
    let output = ""; child.stdout.on("data", (s) => { output += s; fx.onOutput?.(output); }); child.stderr.on("data", (s) => output += s);
    const status = await new Promise((ok) => child.on("close", ok));
    return { status, output };
  };
  const fx = { after: (fn) => t.after(fn), p, url, baseline, checkout, workspace: (id) => join(cache, "work", "proj", id), fork: (id) => join(p, `fork-${id}.git`), forkHead, mainCommit, box, run, env: {}, onOutput: null, posts: (suffix) => box.requests.filter((r) => r.method === "POST" && r.path.endsWith(suffix)) };
  return fx;
}

// The takes of the lease a landing asked for (refused ones included), and
// the takes the server granted, in the order it granted them.
export const takesOf = (f, id = "t1") => f.posts("/landing-lease").filter((x) => x.body.item === id && !x.body.cancel && !x.body.renew && !x.body.confirm && x.body.queued !== true);
export const grantedTo = (f, id = "t1") => f.box.leaseLog.filter((x) => x.item === id && x.kind === "take");
// Where in the requests the landing recorded a step, the first time.
export const recordedAt = (f, step, id = "t1") => f.box.requests.findIndex((x) => x.method === "POST" && x.path === `/api/projects/proj/items/${id}/land` && x.body.step === step);

// Main moves (another task merged) after the head was merged with it and
// before this landing took the lease: under the lease the landing finds
// main moved, releases it without accepting, merges main again and asks
// for the review again, which the server answers as its rules have it.
export async function mainMovesDuringReview(f, { file = "other.txt", text = "another task\n" } = {}) {
  let moved = false;
  f.onOutput = (out) => {
    if (moved || !out.includes("Review requested")) return;
    moved = true;
    writeFileSync(join(f.checkout, file), text); git(f.checkout, "add", "."); git(f.checkout, "commit", "-q", "-m", "Another task merged");
    git(f.checkout, "push", "-q", "origin", "main");
  };
  return () => moved;
}

export const WAITING = /Waiting behind (\S+)'s landing of (t\d) \(since ([^)]+)\); t1 takes the lease for its merge as soon as the lease is free\./g;

// t463: the project declares gen-fixtures.txt as an output its generator
// writes from in/*.txt, and routes it to the generated driver. Each side
// commits the same declarations with an input of its own and the output it
// generated, so the two sides' outputs conflict.
export function declareGenerated(dir, side, { command = ["sh", "-c", "cat in/*.txt > gen-fixtures.txt"], also = {} } = {}) {
  mkdirSync(join(dir, "bin"), { recursive: true }); mkdirSync(join(dir, "in"), { recursive: true });
  writeFileSync(join(dir, "bin", "merge-manifest.json"), JSON.stringify({ version: 1, generators: [{ name: "fixtures", command, inputs: ["in/**"], outputs: ["gen-fixtures.txt"] }] }));
  writeFileSync(join(dir, ".gitattributes"), "gen-fixtures.txt merge=atelier-generated\n");
  writeFileSync(join(dir, "in", `${side}.txt`), `${side}\n`);
  writeFileSync(join(dir, "gen-fixtures.txt"), `${side}\n`);
  for (const [file, text] of Object.entries(also)) writeFileSync(join(dir, file), text);
  git(dir, "add", "."); git(dir, "commit", "-m", `${side} adds an input and regenerates`); git(dir, "push", "-q", "origin", "main");
}

// t463: the merge steps the CLI posts are kept, with what varies from run to
// run put in place, in test/fixtures/land/merge-steps.json; the route spec
// (test/land-routes.spec.ts) sends those bodies to the ledger through the
// route, so a field the CLI starts sending that the ledger refuses fails
// there. ATELIER_WRITE_FIXTURES=1 rewrites the entry.
const MERGE_STEPS = join(dirname(new URL(import.meta.url).pathname), "fixtures", "land", "merge-steps.json");
export function sameMergeStep(name, body) {
  const steady = JSON.parse(JSON.stringify(body, (key, value) => key === "ms" ? 0
    : key === "log" ? `/tmp/merge-logs/${value.split("/").pop().replace(/^[0-9TZ-]+-/, "")}`
      : typeof value === "string" && /^[0-9a-f]{40}$/.test(value) ? "0".repeat(40)
        : typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? "f".repeat(64)
          : typeof value === "string" ? value.replace(/\b[0-9a-f]{7,40}\b/g, "0000000").replace(/"[^"]*\/t1"/g, '"/workspace/t1"') : value));
  const kept = existsSync(MERGE_STEPS) ? JSON.parse(readFileSync(MERGE_STEPS, "utf8")) : {};
  if (process.env.ATELIER_WRITE_FIXTURES === "1") {
    mkdirSync(dirname(MERGE_STEPS), { recursive: true });
    writeFileSync(MERGE_STEPS, `${JSON.stringify({ ...kept, [name]: steady }, null, 2)}\n`);
  } else assert.deepEqual(steady, kept[name], `the ${name} merge step the CLI posts is not the one test/fixtures/land/merge-steps.json keeps for the route spec; rerun with ATELIER_WRITE_FIXTURES=1 and check the spec still passes`);
}

// Raises the route level in one of the fixture's checkouts — the task's
// workspace or main's — and pushes it, so a test can raise it on either
// side of a landing's merge.
export const raiseRouteLevel = (dir, level, message) => {
  writeFileSync(join(dir, "src", "route-level.ts"), `export const ROUTE_LEVEL = ${level};\n`);
  git(dir, "add", "."); git(dir, "commit", "-m", message); git(dir, "push", "-q", "origin", "main");
};

// Waits until `ready()` holds, polling, or fails after `ms`.
// The deadline is only a ceiling for a machine under load (a landing spawns
// node and runs git, which took over 15 s at load ~20); the wait ends as soon
// as the event happens, so a quiet machine never waits for it.
// The expiry landing exceeded the runner's 180 s default under load (t389).
// These two tests override that default as well as their event-wait deadlines.
export const CEILING_MS = 300_000;
export async function until(ready, ms = CEILING_MS, what = "the condition") {
  for (const t0 = Date.now(); !ready();) {
    if (Date.now() - t0 > ms) throw new Error(`${what} did not come within ${ms}ms`);
    await new Promise((ok) => setTimeout(ok, 25));
  }
}

// Waits until `count()` has gone quiet — unchanged for `quiet` ms, several
// of the heartbeat's beats — and returns what it settled on. A stream that
// keeps coming never settles, so this waits on the renewal calls themselves
// rather than proving they stopped with a fixed sleep on the clock.
export async function settled(count, quiet, ms = CEILING_MS, what = "the count") {
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
// rather than awaited, so a test can signal it or watch it. Since t550 it
// holds no lease while it waits.
export function waitingLanding(f, env = {}) {
  f.box.review.approveAfter = null;
  return spawnLanding(f, env);
}

// A landing held under the lease (t550): its review approved, the lease
// taken, and its acceptance left unanswered until the test lets it go, so a
// test can signal it or watch its heartbeat.
export function holdingLanding(f, env = {}) {
  f.box.holdOn = (url) => url.endsWith("/accept");
  return spawnLanding(f, env);
}
export const underLease = (f) => f.box.holding?.endsWith("/accept") && f.box.lease?.item === "t1";

export function spawnLanding(f, env = {}) {
  const child = spawn(process.execPath, [resolve("cli/atelier.mjs"), "land", "t1", "--project", "proj"], {
    cwd: f.checkout,
    env: { ...process.env, ATELIER_CONFIG_DIR: join(f.p, "config"), ATELIER_TOKEN: "fixture", ATELIER_CACHE: join(f.p, "cache"), ATELIER_SERVER: f.url, ATELIER_LAND_POLL_MS: "30", ...env },
  });
  // Ended however the test ends, so a failed wait leaves no landing polling.
  f.after(() => child.kill("SIGKILL"));
  let output = ""; child.stdout.on("data", (s) => output += s); child.stderr.on("data", (s) => output += s);
  const done = new Promise((ok) => child.on("close", (status, signal) => ok({ status, signal })));
  return { child, done, output: () => output };
}

// The stand-in landing Workflow as the real one moves (src/landing-workflow.ts)
// since t550: it asks for the workspace at once, holding no lease; a report
// of the round's pushed head stands for its checks, submission and review,
// after which it queues for the lease, takes it on its second read (so the
// executor sees the queueing first), accepts and asks for the merge; a
// report of conflicts pauses it, holding no lease; a resume starts the next
// round; the recorded merge completes it.
export function scriptWorkflow(f) {
  const wf = f.box.wf;
  wf.firstStage = "workspace";
  let leaseReads = 0;
  wf.tick = (box) => {
    if (wf.stage === "lease" && ++leaseReads >= 2) {
      const now = new Date().toISOString();
      box.lease = { item: "t1", holder: "owner", at: now, renewedAt: now };
      wf.stage = "merge"; box.states.t1 = "accepted";
    }
    if (wf.stage === "merge" && box.states.t1 === "merged") { wf.stage = "done"; wf.status = "complete"; wf.output = { landed: true }; box.lease = null; }
  };
  wf.onEvent = (event, box) => {
    if (event.type === "workspace" && event.payload.round !== wf.round) return;
    if (event.type === "workspace" && event.payload.conflict) { wf.stage = "conflict"; wf.files = event.payload.files; }
    else if (event.type === "workspace" && event.payload.failed) { wf.stage = "failed"; wf.status = "errored"; wf.error = event.payload.reason; }
    else if (event.type === "workspace") { wf.stage = "lease"; wf.detail = `${event.payload.head.slice(0, 8)} is checked and approved; waiting for the landing lease for the merge`; leaseReads = 0; }
    else if (event.type === "resume" && event.payload.round === wf.round) { wf.stage = "workspace"; wf.round++; }
  };
  return wf;
}

// The workspace's write token (t275), against runLand with injected fakes:
// the server's answers, Git's (a real repository only where the preflight
// reads one from disk, under .scratch/) and the CLI's own steps. The task is
// held by codex/test, the owner is "owner", and the workspace records
// `expiresAt` as its token's expiry (none when null).
export function tokenLanding(t, { expiresAt, claim = "ok", holder = "codex/test", runner = null, dispatch = null, actor = "codex/test", committed = true, workflow = false, push = [] } = {}) {
  const scratch = resolve(".scratch"); mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "land-token-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", dir]);
  const config = { "atelier.project": "proj", "atelier.item": "t1", "atelier.actor": actor, ...(expiresAt ? { "atelier.write-token-expires-at": expiresAt } : {}) };
  const calls = [], lines = [], adopted = [], commands = [];
  const itemPath = "/projects/proj/items/t1", leasePath = "/projects/proj/landing-lease";
  const fresh = new Date(Date.now() + 8 * 3600_000).toISOString();
  const request = async (method, path, body, as, extra) => {
    calls.push({ method, path, body, as, extra });
    if (path === "/version") return { capabilities: SERVER_CAPABILITIES, commit: "c0ffee" };
    if (path === leasePath && method === "GET") return { lease: null, waiting: [] };
    if (path === leasePath) return body.cancel ? {} : { item: { id: "t1", state: "submitted" } };
    if (path === itemPath) return { item: { id: "t1", state: holder ? "submitted" : "open", owner: holder, runner, dispatch }, policy: { checks: [] } };
    if (path === `${itemPath}/undispatch`) { dispatch = null; return {}; }
    if (path === `${itemPath}/claim`) {
      if (dispatch && !holder) throw new Error("dispatched: withdraw the dispatch to claim it by hand");
      if (claim !== "ok") throw Object.assign(new Error(claim), { status: 409 });
      holder = as;
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
    const out = args[0] === "config" ? config[args.at(-1)] ?? null : args[0] === "rev-parse" ? committed ? "a".repeat(40) : null : "";
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
