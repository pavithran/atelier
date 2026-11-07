import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { autoDeploy, autoDeployWaits, composeShip, fileDeployStore, memoryDeployStore } from "../cli/ship.mjs";
import { deployOnLanding, executePostMerge } from "../cli/post-merge.mjs";
import { STANDING, parseStanding } from "../src/standing.ts";

// t519: a landed head whose gates are green deploys by itself. Every effect
// of the engine is passed in, so the deploy step here is a fake that counts
// its calls; none of these tests deploys, installs or pushes anything.

const sha = (c) => c.repeat(40);
const [H1, H2, H3] = [sha("1"), sha("2"), sha("3")];

// An engine run with fakes: `deploys` lists each head the fake deploy step
// was asked for, `records` the ledger records, `notes` the notifications.
function rig({ outcomes = [], waits = {}, store = memoryDeployStore(), on = true } = {}) {
  const r = { deploys: [], records: [], notes: [], lines: [], store };
  r.fakeDeploy = async (head) => {
    r.deploys.push(head);
    const outcome = outcomes.shift() ?? { passed: true };
    if (outcome.hold) await outcome.hold;
    if (outcome.throws) throw new Error(outcome.throws);
    return { passed: outcome.passed ?? true, output: outcome.output ?? "" };
  };
  r.run = (head) => autoDeploy({
    name: "demo", head, on, store, print: (l) => r.lines.push(l),
    waitsFor: async (h) => waits[h] ?? [],
    deploy: r.fakeDeploy,
    record: async (rec) => { r.records.push(rec); },
    notify: async (m) => { r.notes.push(m); },
  });
  return r;
}

// ── criterion 1: a deploy starts with no command from a session ─────────────

test("a landed head deploys by itself through the fake deploy step, and is marked delivered only after", async () => {
  const r = rig();
  const seen = [];
  r.fakeDeploy = async (head) => { r.deploys.push(head); seen.push(r.store.read().deployed); return { passed: true, output: "live" }; };
  const out = await r.run(H1);
  assert.equal(out.state, "deployed");
  assert.deepEqual(r.deploys, [H1]);
  assert.deepEqual(seen, [null], "nothing is marked delivered while the deploy runs");
  assert.equal(r.store.read().deployed, H1);
  assert.equal(r.store.read().running, null, "the claim is released");
  assert.deepEqual(r.records, [], "a deploy that works leaves its record to the ship it ran");
  assert.deepEqual(r.notes, []);
});

test("with the standing instruction off, nothing deploys", async () => {
  const r = rig({ on: false });
  assert.equal((await r.run(H1)).state, "off");
  assert.deepEqual(r.deploys, []);
  assert.equal(r.store.read().running, null);
});

test("a head already delivered is not deployed again", async () => {
  const r = rig();
  await r.run(H1);
  assert.equal((await r.run(H1)).state, "current");
  assert.deepEqual(r.deploys, [H1]);
});

test("deploy-on-landing is a standing instruction taking on or off", () => {
  assert.ok(STANDING["deploy-on-landing"]);
  assert.deepEqual(parseStanding({ key: "deploy-on-landing", value: "on" }), { key: "deploy-on-landing", value: "on" });
  assert.deepEqual(parseStanding({ key: "deploy-on-landing", value: "off" }), { key: "deploy-on-landing", value: "off" });
  assert.throws(() => parseStanding({ key: "deploy-on-landing", value: "yes" }), /deploy-on-landing takes on or off/);
});

// The landing's own command starts the deploy when the merge ends.
function postMergeRequests({ standing, run = null, deploys = [{ result: "shipped", head: H1 }], baseline = H2, down = false }) {
  const calls = [];
  const request = async (method, path) => {
    calls.push(`${method} ${path}`);
    if (down && path.endsWith("/decisions")) throw new Error("server unreachable");
    if (path.endsWith("/decisions")) return { decisions: standing.map((value, i) => ({ id: `d${i + 1}`, status: "standing", standing: { key: "deploy-on-landing", value } })) };
    if (path.endsWith("/baseline-head")) return { head: baseline };
    if (path.endsWith("/deploys")) return { deploys };
    return { run };
  };
  return { request, calls };
}

test("after a merge whose post-merge run is complete, or absent, a deploy starts with no session command", async () => {
  for (const run of [null, { id: "r1", state: "complete", after: H2 }]) {
    const started = [], lines = [];
    const { request } = postMergeRequests({ standing: ["on"], run });
    await executePostMerge({ request, name: "demo", id: "t1", print: (l) => lines.push(l), cwd: "/checkout", deploy: (ctx) => deployOnLanding({ ...ctx, start: (s) => started.push(s) }) });
    assert.equal(started.length, 1, JSON.stringify(run));
    assert.deepEqual({ name: started[0].name, head: started[0].head, since: started[0].since, cwd: started[0].cwd }, { name: "demo", head: H2, since: H1, cwd: "/checkout" });
    assert.match(lines.join("\n"), /Deploy on landing: deploying 22222222 in the background/);
  }
});

test("a post-merge run that is still open, or failed, starts no deploy", async () => {
  const started = [];
  const base = postMergeRequests({ standing: ["on"] });
  const request = async (method, path, body) => path.includes("/post-merge/") ? { run: { id: "r1", state: "failed", policy: { steps: [] }, steps: [] } } : base.request(method, path, body);
  await executePostMerge({ request, name: "demo", id: "t1", print: () => {}, deploy: (ctx) => deployOnLanding({ ...ctx, start: (s) => started.push(s) }) }).catch(() => {});
  assert.deepEqual(started, []);
});

test("the deploy starts only while the latest standing value is on, and an unreadable server never starts one", async () => {
  const cases = [[["off"], "off"], [[], "off"], [["on", "off"], "off"], [["off", "on"], "started"]];
  for (const [standing, want] of cases) {
    const started = [];
    const { request } = postMergeRequests({ standing });
    assert.equal(await deployOnLanding({ request, name: "demo", print: () => {}, start: (s) => started.push(s) }), want, JSON.stringify(standing));
    assert.equal(started.length, want === "started" ? 1 : 0);
  }
  const lines = [], started = [];
  const down = postMergeRequests({ standing: ["on"], down: true });
  assert.equal(await deployOnLanding({ request: down.request, name: "demo", print: (l) => lines.push(l), start: (s) => started.push(s) }), "unavailable");
  assert.deepEqual(started, []);
  assert.match(lines.join("\n"), /Deploy on landing was not started: server unreachable\. Run atelier ship to deploy by hand\./);
  // A deploy that cannot be started never fails the landing.
  const throwing = postMergeRequests({ standing: ["on"] });
  assert.equal(await deployOnLanding({ request: throwing.request, name: "demo", print: () => {}, start: () => { throw new Error("no process"); } }), "unavailable");
});

// ── criterion 4: retried once, then failed, with one notification ───────────

test("a failed deploy is retried once, and a pass on the retry delivers with no failure record", async () => {
  const r = rig({ outcomes: [{ passed: false, output: "boom" }, { passed: true }] });
  const out = await r.run(H1);
  assert.deepEqual(r.deploys, [H1, H1]);
  assert.equal(out.state, "deployed");
  assert.equal(out.heads[0].attempts, 2);
  assert.deepEqual(r.records, []);
  assert.deepEqual(r.notes, []);
  assert.equal(r.store.read().deployed, H1);
});

test("a second failure records the deploy as failed and sends exactly one notification", async () => {
  const r = rig({ outcomes: [{ passed: false, output: "first" }, { passed: false, output: "verify-delivery: sign-in page" }, { passed: true }] });
  const out = await r.run(H1);
  assert.equal(out.state, "failed");
  assert.deepEqual(r.deploys, [H1, H1], "tried, retried once, and no third try");
  assert.equal(r.records.length, 1);
  assert.deepEqual({ ...r.records[0], note: undefined }, { ship: "auto-111111111111", head: H1, result: "failed", step: "deploy", ran: [], note: undefined });
  assert.match(r.records[0].note, /deploy on landing failed twice: verify-delivery: sign-in page/);
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /demo: deploying 11111111 on landing failed twice/);
  assert.match(r.notes[0], /atelier ship/);
  assert.equal(r.store.read().deployed, null, "a failed deploy marks nothing delivered");
  assert.equal(r.store.read().running, null, "and releases the claim");
  assert.deepEqual(r.store.read().notified, [H1]);
  // The same head again does not announce itself a second time.
  const again = await r.run(H1);
  assert.equal(again.state, "deployed", "the third scripted outcome passes");
  assert.equal(r.notes.length, 1);
});

test("a deploy step that throws counts as a failed try, and the failure is announced once", async () => {
  const r = rig({ outcomes: [{ throws: "ssh: connection refused" }, { throws: "ssh: connection refused" }] });
  const out = await r.run(H1);
  assert.equal(out.state, "failed");
  assert.deepEqual(r.deploys, [H1, H1]);
  assert.match(r.records[0].note, /the deploy could not run: ssh: connection refused/);
  assert.equal(r.notes.length, 1);
});

test("a notification that cannot be sent leaves the head unannounced, so the next landing says so again", async () => {
  const store = memoryDeployStore();
  const sent = [];
  const run = (notify) => autoDeploy({ name: "demo", head: H1, on: true, store, waitsFor: async () => [], deploy: async () => ({ passed: false, output: "x" }), record: async () => {}, notify });
  await assert.rejects(run(async () => { throw new Error("channel down"); }), /channel down/);
  assert.deepEqual(store.read().notified, []);
  assert.equal(store.read().running, null, "an error gives the claim back");
  await run(async (m) => { sent.push(m); });
  assert.equal(sent.length, 1);
  assert.deepEqual(store.read().notified, [H1]);
});

// ── criterion 5: two merges during a deploy make one more deploy ────────────

test("two merges landing while a deploy runs produce one more deploy of the newest head", async () => {
  let release;
  const gate = new Promise((done) => { release = done; });
  const r = rig({ outcomes: [{ hold: gate }] });
  const first = r.run(H1);
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(r.deploys, [H1], "the first deploy is running");
  const second = await r.run(H2);
  const third = await r.run(H3);
  assert.equal(second.state, "queued");
  assert.equal(third.state, "queued");
  assert.deepEqual(r.deploys, [H1], "neither landing starts a deploy beside the running one");
  release();
  const out = await first;
  assert.deepEqual(r.deploys, [H1, H3], "one more deploy, of the newest head; H2 never deploys");
  assert.deepEqual(out.heads.map((h) => [h.head, h.state]), [[H1, "deployed"], [H3, "deployed"]]);
  assert.equal(r.store.read().deployed, H3);
  assert.equal(r.store.read().pending, null);
  assert.equal(r.store.read().running, null);
  // With nothing queued, the next landing deploys at once.
  const later = await r.run(sha("4"));
  assert.equal(later.state, "deployed");
  assert.equal(r.deploys.length, 3);
});

test("a head that landed during a failed deploy still gets its own deploy, and its own failure record", async () => {
  let release;
  const gate = new Promise((done) => { release = done; });
  const r = rig({ outcomes: [{ hold: gate, passed: false }, { passed: false }, { passed: true }] });
  const first = r.run(H1);
  await new Promise((done) => setImmediate(done));
  await r.run(H2);
  release();
  const out = await first;
  assert.deepEqual(r.deploys, [H1, H1, H2]);
  assert.deepEqual(out.heads.map((h) => [h.head, h.state]), [[H1, "failed"], [H2, "deployed"]]);
  assert.equal(r.notes.length, 1);
});

test("a deploy whose process died holds nothing: the next landing deploys", async () => {
  const dead = new Set();
  const store = memoryDeployStore({ pid: 111, alive: (pid) => !dead.has(pid) });
  assert.deepEqual(await store.claim(H1), { run: true });
  assert.equal((await store.claim(H2)).run, false, "while its process lives, a later head waits");
  dead.add(111);
  const r = rig({ store });
  assert.equal((await r.run(H3)).state, "deployed");
  assert.deepEqual(r.deploys, [H3]);
});

// ── a crash before completion leaves the markers unset ──────────────────────

test("a crash during the deploy leaves delivered and announced unset, and the next landing takes over", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-auto-deploy-"));
  try {
    const alive = new Set();
    const options = (pid) => ({ pid, alive: (p) => alive.has(p) });
    // The process dies between its claim and the end of its deploy.
    const killed = fileDeployStore(dir, options(4002));
    alive.add(4002);
    assert.deepEqual(await killed.claim(H2), { run: true });
    alive.delete(4002);
    const seen = fileDeployStore(dir, options(4003)).read();
    assert.equal(seen.deployed, null, "no delivered marker was written");
    assert.deepEqual(seen.notified, []);
    assert.equal(seen.running.head, H2, "the dead run's claim is still on file");
    alive.add(4003);
    const next = fileDeployStore(dir, options(4003));
    assert.deepEqual(await next.claim(H3), { run: true }, "a claim whose process is gone is taken over");
    assert.equal(next.read().running.head, H3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the file store is shared between stores on one folder, and a stale lock is cleared", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-auto-deploy-"));
  try {
    const live = () => true;
    const a = fileDeployStore(dir, { pid: 1, alive: live }), b = fileDeployStore(dir, { pid: 2, alive: live });
    assert.deepEqual(await a.claim(H1), { run: true });
    assert.deepEqual(await b.claim(H2), { run: false, running: H1 });
    assert.deepEqual(await b.claim(H3), { run: false, running: H1 });
    assert.equal(await a.next(H1), H3, "the newest queued head, once");
    assert.equal(a.read().pending, null);
    await a.delivered(H3);
    assert.equal(b.read().deployed, H3);
    assert.equal(await a.next(H3), null);
    assert.equal(b.read().running, null);
    // A lock left by a process that died inside it (older than 30 seconds).
    mkdirSync(join(dir, "lock"));
    writeFileSync(join(dir, "lock", "at"), String(Date.now() - 60_000));
    assert.deepEqual(await b.claim(sha("5")), { run: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── criterion 6: needs PAVI, so no auto-deploy ──────────────────────────────

function checkout(t, ship, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-auto-waits-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@x.test", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@x.test" } }).trim();
  git("init", "-q", "-b", "main");
  const put = (path, text) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); };
  put("docs/atelier/ship.json", JSON.stringify(ship));
  put("README.md", "one\n");
  git("add", "."); git("commit", "-q", "-m", "one");
  const since = git("rev-parse", "HEAD");
  for (const [path, text] of Object.entries(files)) put(path, text);
  git("add", "."); git("commit", "-q", "--allow-empty", "-m", "two");
  const head = git("rev-parse", "HEAD");
  const run = (args, o = {}) => { try { return { status: 0, stdout: execFileSync("git", args, { cwd: dir, encoding: "utf8" }) }; } catch (error) { if (o.allowFail) return { status: error.status, stdout: "" }; throw error; } };
  return { dir, since, head, git: (a, o) => (o?.allowFail ? run(a, o) : run(a).stdout.trim()) };
}
const WEB = { schema_version: 1, kind: "atelier.ship", class: "web", deploy: { run: ["./deploy"] }, "verify-deploy": { request: "https://x.test/version", status: 200 } };
const waits = (c) => autoDeployWaits({ plan: composeShip(c.dir), git: c.git, cwd: c.dir, head: c.head, since: c.since });

test("a change to a migration, or to the Cloudflare configuration, waits on PAVI", (t) => {
  assert.deepEqual(waits(checkout(t, WEB, { "src/a.ts": "x" })), [], "an ordinary change does not wait");
  assert.match(waits(checkout(t, WEB, { "migrations/0007_add.sql": "x" })).join("\n"), /a database migration changed.*migrations\/0007_add\.sql changed since/);
  assert.match(waits(checkout(t, WEB, { "worker/migrations/0001.sql": "x" })).join("\n"), /a database migration changed/);
  assert.match(waits(checkout(t, WEB, { "wrangler.jsonc": "{}" })).join("\n"), /Cloudflare configuration changed.*wrangler\.jsonc/);
  assert.match(waits(checkout(t, WEB, { "apps/site/wrangler.toml": "x" })).join("\n"), /Cloudflare configuration changed/);
});

test("the ship file can name more paths that wait, or turn auto-deploy off", (t) => {
  const more = { ...WEB, auto_deploy: { waits_on: [{ paths: ["secrets/**"], because: "a secret list changed, and PAVI sets the secret" }] } };
  assert.match(waits(checkout(t, more, { "secrets/names.json": "[]" })).join("\n"), /a secret list changed, and PAVI sets the secret \(secrets\/names\.json changed since/);
  assert.deepEqual(waits(checkout(t, more, { "src/a.ts": "x" })), []);
  assert.match(waits(checkout(t, { ...WEB, auto_deploy: false }, { "src/a.ts": "x" })).join("\n"), /"auto_deploy": false/);
  for (const bad of [true, "no", { waits_on: [{ paths: [], because: "x" }] }, { waits_on: [{ paths: ["a"], because: "" }] }, { waits_on: [{ paths: ["a"] }] }, { other: 1 }]) {
    const plan = composeShip(checkout(t, { ...WEB, auto_deploy: bad }).dir);
    assert.match(plan.problems.join("\n"), /"auto_deploy" must be false, or/, JSON.stringify(bad));
  }
});

test("an approval only PAVI gives, an unknown last deploy or a ship file problem waits too", (t) => {
  const paid = { ...WEB, deploy: [{ run: ["./deploy"] }, { run: ["./caption"], approval: "paid-run" }] };
  assert.match(waits(checkout(t, paid)).join("\n"), /needs a paid-run approval, which only PAVI gives/);
  const c = checkout(t, WEB);
  const plan = composeShip(c.dir);
  const nothingBefore = autoDeployWaits({ plan, git: c.git, cwd: c.dir, head: c.head, since: null });
  assert.match(nothingBefore.join("\n"), /no earlier deploy is recorded/);
  const unknown = autoDeployWaits({ plan, git: c.git, cwd: c.dir, head: c.head, since: "f".repeat(40) });
  assert.match(unknown.join("\n"), /could not be read/);
  assert.match(waits(checkout(t, { ...WEB, class: "bogus" })).join("\n"), /the ship file has problems/);
});

test("a head that waits on PAVI is not deployed, is shown as waiting, and the next head can still deploy", async () => {
  const r = rig({ waits: { [H1]: ["a database migration changed, and PAVI runs the remote migration (migrations/0007.sql changed since 00000000)"] } });
  const out = await r.run(H1);
  assert.equal(out.state, "waiting");
  assert.deepEqual(r.deploys, [], "nothing deploys");
  assert.deepEqual(r.records, []);
  assert.deepEqual(r.notes, [], "waiting is shown, not announced as a failure");
  assert.match(r.lines.join("\n"), /Deploy on landing: 11111111 is waiting on PAVI, not deployed: a database migration changed/);
  const held = r.store.read();
  assert.equal(held.waiting.head, H1);
  assert.match(held.waiting.reasons[0], /remote migration/);
  assert.equal(held.running, null, "a waiting head holds no claim");
  // PAVI deploys it by hand; the next ordinary head deploys by itself and clears the mark.
  const next = await r.run(H2);
  assert.equal(next.state, "deployed");
  assert.equal(r.store.read().waiting, null);
});

test("ship --dry-run shows the wait in its plan", async (t) => {
  const c = checkout(t, WEB, { "migrations/0001.sql": "x" });
  const { ship } = await import("../cli/ship.mjs");
  const lines = [];
  await ship({
    name: "p", cwd: c.dir, branch: "main", git: (a, o) => (a[0] === "branch" ? "main" : a[0] === "status" ? "" : o?.allowFail ? c.git(a, o) : a[0] === "rev-parse" ? c.head : c.git(a, o)),
    request: async () => ({ approvals: [], project: { policy: {} } }), read: async () => ({ deploys: [{ result: "shipped", head: c.since }] }),
    print: (l) => lines.push(l), fail: (m) => { throw new Error(m); }, inProgress: () => [], baselineHead: c.head, paired: () => c.head, dryRun: true, push: false,
  });
  assert.match(lines.join("\n"), /Note: not deployed on landing, waiting on PAVI: a database migration changed/);
});
