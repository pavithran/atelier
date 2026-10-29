// Atelier 2.0, lessons gap G4, the read: `atelier situation` gives one read of
// the project from recorded state, text for a person and --json for a model;
// `show --json` carries the task's own fields under ls --json's key names;
// every error under --json is {code, detail, next}; `stuck` works with an
// actor set. Each test drives the real Node server, its real Ledgers and the
// real CLI through real transitions. Every credential here is a dummy.
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { startServer } from "../src/runtime/server.mjs";
import { situationOf, RUNNER_SILENT_MS } from "../src/situation.ts";
import { situationText, span } from "../cli/situation.mjs";
import { approvalsByHead, dispatchStateOf, standingGoOf } from "../cli/commands/show.mjs";

const run = promisify(execFile);
const OWNER = "atl_00112233445566778899aabbccddeeff";
const AGENT = "codex/gpt-6";
const OTHER = "claude-code/opus-5.5";
const ACTING = "claude-code/opus-5.5";
const root = mkdtempSync(join(tmpdir(), "atelier-situation-"));
after(() => rmSync(root, { recursive: true, force: true }));
const sha = (c) => c.repeat(40);

// The free disk the server reports is the DISK binding's; this test sets it.
let disk = { path: "/srv/atelier", freeBytes: 50 * 2 ** 30, totalBytes: 1000 * 2 ** 30 };
let server;
const L = () => server.namespace.get(server.namespace.idFromName("project:demo"));
const I = () => server.namespace.get(server.namespace.idFromName("__index"));
async function api(method, path, body, token = OWNER) {
  const res = await fetch(`${server.url}/api${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-atelier-actor": "owner", ...(token === OWNER ? { "x-atelier-acting": ACTING } : {}) },
  });
  return { status: res.status, body: await res.json() };
}
const config = join(root, "config");
async function cli(argv, extra = {}) {
  const env = { ...process.env, ATELIER_CONFIG_DIR: config, ATELIER_TOKEN: OWNER, ATELIER_SERVER: server.url, ATELIER_SECRET_STORE: "file", NO_COLOR: "1", ATELIER_ACTING: ACTING, ...extra };
  for (const k of ["ATELIER_PROJECT", "ATELIER_ACTOR", "ATELIER_JSON"]) if (!(k in extra)) delete env[k];
  try { const { stdout, stderr } = await run(process.execPath, ["cli/atelier.mjs", ...argv], { env, timeout: 60_000 }); return { code: 0, stdout, stderr }; }
  catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
}
async function task(title, scope = []) {
  const r = await api("POST", "/projects/demo/items", { title, scope });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return (r.body.item ?? r.body).id;
}
async function built(title, scope, head) {
  const id = await task(title, scope);
  const claim = await L().claim(id, AGENT);
  await L().recordToken(id, AGENT, claim.generation, null, null);
  await L().observePush(id, head, (await L().item(id)).head ?? null);
  return id;
}

before(async () => {
  mkdirSync(config);
  server = await startServer({ env: "test", dataDir: join(root, "data"), host: "127.0.0.1", vars: { ATELIER_TOKEN: OWNER }, bindings: { DISK: { read: () => disk } } });
  assert.equal((await api("PUT", "/projects/demo", { coreFiles: ["src/core.ts"], checks: ["npm test"], checkLimitMinutes: 45 })).status, 200);
});
after(async () => { await server?.close(); });

test("situation reads tasks, holds, review requests, runners, landings, blocks, limits, standing decisions and free disk from recorded state", async () => {
  const filed = await task("Only filed");
  const holder = await built("Holds the core file", ["src/core.ts"], sha("a"));
  const held = await task("Waits for the core file", ["src/core.ts"]);
  assert.equal((await api("POST", `/projects/demo/items/${held}/dispatch`, { to: "home", agent: "opencode", model: "glm-5.3" })).status, 200);
  const reviewed = await built("Asks a review", ["docs/**"], sha("b"));
  await L().addEvidence({ itemId: reviewed, claim: "npm test", grade: "observed", head: sha("b"), passed: true, by: AGENT, at: new Date().toISOString(), changedPaths: ["docs/a.md"] });
  await L().submit(reviewed, AGENT, "done");
  const opus = { id: "opus-5.5", harness: "claude-code", where: "cloud", provider: "subscription", aliases: [], family: "anthropic", note: "", addedBy: "owner", addedAt: new Date().toISOString() };
  await L().requestReview(reviewed, "owner", OTHER, [opus], true);
  const blocked = await task("Blocked on a decision");
  await L().block(blocked, "owner", "waiting on the developer");
  const gone = await task("Abandoned");
  await L().abandon(gone, "owner", "not wanted");
  // A failed check on the holder, recorded as evidence.
  await L().addEvidence({ itemId: holder, claim: "npm test", grade: "observed", head: sha("a"), passed: false, by: AGENT, at: new Date().toISOString(), changedPaths: ["src/core.ts"] });
  await L().beginProjectLanding(holder, "owner");
  assert.equal((await cli(["decide", "Every change is reviewed by another company", "--quote", "another company reviews everywhere", "--project", "demo"])).code, 0);

  // Runners: one polls on a commit other than the server's, one was silent
  // for ten minutes (its offer's time set back), one has a token and never polled.
  const studio = (await api("POST", "/tokens", { runner: "home:studio", projects: ["demo"] })).body.token;
  assert.equal((await api("POST", "/queue", { runner: "home:studio", kind: "home", jobs: ["build"], agents: [{ agent: "opencode", models: ["glm-5.3"] }], commit: sha("c") }, studio)).status, 200);
  await api("POST", "/tokens", { runner: "home:never", projects: ["demo"] });
  await I().putRunnerOffer({ runner: "home:old", kind: "home", jobs: ["review"], agents: [{ agent: "claude-code", models: ["opus-5.5"] }], projects: ["demo"] }, new Date(Date.now() - 10 * 60_000).toISOString());

  const r = await cli(["situation", "--project", "demo", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.equal(s.project, "demo");
  const ids = s.tasks.map((t) => t.id);
  for (const id of [filed, holder, held, reviewed, blocked]) assert.ok(ids.includes(id), `${id} is listed`);
  assert.ok(!ids.includes(gone), "an abandoned task is not live");
  const h = s.tasks.find((t) => t.id === holder);
  assert.equal(h.state, "claimed");
  assert.equal(h.owner, AGENT);
  assert.equal(h.head, sha("a"));
  assert.deepEqual(h.scope, ["src/core.ts"]);
  assert.equal(h.stage, "built", "the stage the newest event recorded");
  const pushed = (await L().events(holder, 100)).find((e) => e.kind === "push.observed");
  assert.ok(Date.parse(h.stageSince) <= Date.parse(pushed.at), "the stage dates from the first event of its run");
  assert.ok(h.stageAgeMs >= 0);
  assert.equal(h.lastCheck.claim, "npm test");
  assert.equal(h.lastCheck.passed, false);
  assert.equal(s.tasks.find((t) => t.id === filed).stage, "filed");
  assert.equal(s.tasks.find((t) => t.id === held).dispatch.model, "glm-5.3");

  const hold = s.holds.find((x) => x.task === held);
  assert.ok(hold, JSON.stringify([s.holds, s.tasks.filter((t) => t.id === held || t.id === holder)]));
  assert.equal(hold.kind, "core-file");
  assert.deepEqual(hold.blockers.map((b) => [b.id, b.file]), [[holder, "src/core.ts"]]);
  assert.ok(hold.since);

  const ask = s.reviewRequests.find((x) => x.task === reviewed);
  assert.ok(ask, JSON.stringify(s.reviewRequests));
  assert.equal(ask.reviewer, OTHER);
  assert.equal(ask.state, "open");
  assert.equal(ask.head, sha("b"));
  assert.ok(ask.ageMs >= 0 && ask.requestedAt);

  const runner = (name) => s.runners.find((x) => x.runner === name);
  assert.equal(runner("home:studio").silent, false);
  assert.equal(runner("home:studio").commit, sha("c"));
  assert.equal(runner("home:studio").otherCommit, true, "a runner on a commit other than the server's is flagged");
  assert.deepEqual(runner("home:studio").models, ["opencode/glm-5.3"]);
  assert.deepEqual(runner("home:studio").projects, ["demo"]);
  assert.equal(runner("home:old").silent, true, "silent ten minutes");
  assert.ok(runner("home:old").silentMs >= 10 * 60_000 - 1000);
  assert.equal(runner("home:never").never, true, "a runner token that never polled says never");
  assert.equal(runner("home:never").lastPoll, null);

  assert.equal(s.landings.lease.task, holder);
  assert.equal(s.landings.lease.holder, "owner");
  const b = s.blocks.find((x) => x.task === blocked);
  assert.equal(b.reason, "waiting on the developer");
  assert.equal(b.liftedBy, "the developer's words");
  assert.match(b.next, /atelier unblock t\d+ --quote/);
  assert.equal(s.limits.limitMinutes, 45);
  assert.deepEqual(s.limits.checks, ["npm test"]);
  assert.ok(s.limits.mode);
  assert.equal(s.standing[0].text, "Every change is reviewed by another company");
  assert.equal(s.server.commit.length >= 40, true);
  assert.equal(s.server.disk.freePercent, 5);
  assert.equal(s.server.disk.warning, true, "under 10 percent free is a warning");
  assert.deepEqual(s.spend, []);
  assert.deepEqual(s.unavailable, []);

  // The same read as text, for a person.
  const text = await cli(["situation", "--project", "demo"]);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, new RegExp(`${holder}\\s+claimed\\s+built for`));
  assert.match(text.stdout, /home:old: last poll 10m ago {2}SILENT 10m/);
  assert.match(text.stdout, /home:never: never polled {2}NEVER POLLED/);
  assert.match(text.stdout, /ON ANOTHER COMMIT \(cccccccc/);
  assert.match(text.stdout, new RegExp(`${held} waits on ${holder} \\(claimed by codex/gpt-6\\) at core file src/core.ts`));
  assert.match(text.stdout, new RegExp(`#\\d+ ${reviewed} at bbbbbbbb: open, asked of ${OTHER}`));
  assert.match(text.stdout, /WARNING: under 10 percent free/);
  assert.match(text.stdout, /lifted by the developer's words: atelier unblock/);
  assert.match(text.stdout, /check limit 45 min/);

  // Free disk over a tenth is no warning.
  disk = { ...disk, freeBytes: 500 * 2 ** 30 };
  const again = JSON.parse((await cli(["situation", "--project", "demo", "--json"])).stdout);
  assert.equal(again.server.disk.warning, false);
});

test("the Node server reads the real free disk of its data directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-situation-disk-"));
  const own = await startServer({ env: "test", dataDir: join(dir, "data"), host: "127.0.0.1", vars: { ATELIER_TOKEN: OWNER } });
  try {
    const res = await fetch(`${own.url}/api/projects/demo`, { method: "PUT", body: "{}", headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json", "x-atelier-actor": "owner", "x-atelier-acting": ACTING } });
    assert.equal(res.status, 200);
    const s = await (await fetch(`${own.url}/api/projects/demo/situation`, { headers: { authorization: `Bearer ${OWNER}`, "x-atelier-actor": "owner" } })).json();
    assert.ok(s.server.disk.totalBytes > 0 && s.server.disk.freeBytes > 0, JSON.stringify(s.server));
    assert.equal(typeof s.server.disk.warning, "boolean");
  } finally { await own.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("show --json carries id, state, owner, head, scope, dispatch, runner, holds and last failure under ls --json's names, closed tasks too", async () => {
  const holder = await built("Show: holder", ["src/core.ts"], sha("d"));
  await L().addEvidence({ itemId: holder, claim: "npm test", grade: "observed", head: sha("d"), passed: false, by: AGENT, at: new Date().toISOString(), changedPaths: ["src/core.ts"] });
  const waiting = await task("Show: waits", ["src/core.ts"]);
  assert.equal((await api("POST", `/projects/demo/items/${waiting}/dispatch`, { to: "home", agent: "opencode", model: "glm-5.3" })).status, 200);
  const ls = JSON.parse((await cli(["ls", "--project", "demo", "--json"])).stdout);
  const shown = JSON.parse((await cli(["show", holder, "--project", "demo", "--json"])).stdout);
  for (const key of Object.keys(ls.find((i) => i.id === holder))) assert.deepEqual(shown[key], ls.find((i) => i.id === holder)[key], `show --json's ${key} is ls --json's`);
  assert.equal(shown.state, "claimed");
  assert.equal(shown.owner, AGENT);
  assert.deepEqual(shown.scope, ["src/core.ts"]);
  assert.equal(shown.runner, null);
  assert.equal(shown.lastFailure.kind, "check");
  assert.equal(shown.lastFailure.claim, "npm test");
  assert.equal(shown.lastFailure.head, sha("d"));
  const w = JSON.parse((await cli(["show", waiting, "--project", "demo", "--json"])).stdout);
  assert.equal(w.dispatch.model, "glm-5.3");
  assert.ok(w.holds.some((x) => x.kind === "core-file" && x.blocker === holder && x.file === "src/core.ts"), JSON.stringify(w.holds));
  assert.equal(w.lastFailure, null);
  // G4 2a: why it is not taken, by kind; where it stands toward a dispatch.
  assert.ok(w.unclaimed.some((r) => r.kind === "held"), JSON.stringify(w.unclaimed));
  assert.equal(w.dispatchState, "dispatched");
  assert.deepEqual(w.standingGo, { landing: null, overrideConfirmation: null, fastMode: null });
  assert.deepEqual(shown.unclaimed, []);
  assert.equal(shown.dispatchState, null, "a claimed task is past dispatch");
  const fresh = JSON.parse((await cli(["show", await task("Show: not dispatched"), "--project", "demo", "--json"])).stdout);
  assert.equal(fresh.dispatchState, "not dispatched");
  // The approvals at each head, as the reviews recorded them.
  await L().addReview({ itemId: holder, by: OTHER, head: sha("d"), approve: true, criteria: (await L().detail(holder)).criteria, note: "Fine", at: new Date().toISOString() }, undefined, true);
  const reviewed = JSON.parse((await cli(["show", holder, "--project", "demo", "--json"])).stdout);
  assert.deepEqual(reviewed.approvals.map((a) => [a.head, a.current, a.approvedBy, a.rejectedBy]), [[sha("d"), true, [OTHER], []]]);
  // A closed task still answers.
  await L().abandon(waiting, "owner", "done with it");
  const closed = await cli(["show", waiting, "--project", "demo", "--json"]);
  assert.equal(closed.code, 0, closed.stderr);
  assert.equal(JSON.parse(closed.stdout).state, "abandoned");
});

test("every error under --json is {code, detail, next}: a server refusal and an error of the CLI's own", async () => {
  const refused = await cli(["situation", "--project", "nope", "--json"]);
  assert.notEqual(refused.code, 0);
  const a = JSON.parse(refused.stderr.trim().split("\n").at(-1));
  assert.deepEqual(Object.keys(a).sort(), ["code", "detail", "next"]);
  const local = await cli(["show", "--project", "demo", "--json"]);
  assert.notEqual(local.code, 0);
  const b = JSON.parse(local.stderr.trim().split("\n").at(-1));
  assert.deepEqual(Object.keys(b).sort(), ["code", "detail", "next"]);
  assert.equal(b.code, "refused");
  const env = await cli(["show", "--project", "demo"], { ATELIER_JSON: "1" });
  assert.deepEqual(Object.keys(JSON.parse(env.stderr.trim().split("\n").at(-1))).sort(), ["code", "detail", "next"]);
  // An unreachable server under --json too.
  const away = await cli(["situation", "--project", "demo", "--json"], { ATELIER_SERVER: "http://127.0.0.1:9", ATELIER_RETRY_MS: "" });
  assert.equal(away.code, 4);
  const c = JSON.parse(away.stderr.trim().split("\n").at(-1));
  assert.equal(c.code, "unreachable");
});

test("stuck works with an actor set, as situation does", async () => {
  for (const extra of [{ ATELIER_ACTOR: OTHER }, {}]) {
    const r = await cli(["stuck", "--project", "demo", "--json"], extra);
    assert.equal(r.code, 0, `${JSON.stringify(extra)}: ${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).project, "demo");
    const s = await cli(["situation", "--project", "demo", "--json"], extra);
    assert.equal(s.code, 0, s.stderr);
  }
  const asFlag = await cli(["stuck", "--project", "demo", "--as", OTHER]);
  assert.equal(asFlag.code, 0, asFlag.stderr);
});

test("situationOf flags silence past 5 minutes and its minute of coarsening, from an injected clock", () => {
  const now = new Date("2026-10-28T12:00:00.000Z");
  const facts = { project: { name: "demo", policy: {} }, mode: { mode: "normal", line: "normal" }, items: [], stages: {}, held: [], reviewRequests: [], landingLease: null, landJobs: [], landings: {}, lastChecks: {}, standing: [] };
  const offer = (runner, msAgo) => ({ runner, kind: "home", agents: [], jobs: [], at: new Date(now.getTime() - msAgo).toISOString() });
  const s = situationOf({ facts, offers: [offer("home:a", RUNNER_SILENT_MS), offer("home:b", RUNNER_SILENT_MS + 61_000)], tokens: [], names: ["demo"], commit: null, disk: null, now });
  assert.deepEqual(s.runners.map((r) => [r.runner, r.silent]), [["home:a", false], ["home:b", true]]);
  assert.deepEqual(s.unavailable, ["free disk"]);
  assert.match(situationText(s), /free disk not readable here/);
  assert.equal(span(3 * 3600e3 + 5 * 60e3), "3h 5m");
});

test("show --json's 2a fields: approval per head carried or not and why, approved not dispatched, the standing go", () => {
  const A = "a".repeat(40), B = "b".repeat(40);
  const d = {
    item: { id: "t1", state: "open", head: B, dispatch: null, overrideConfirmation: { head: B, at: "2026-10-28T10:00:00.000Z" } },
    reviews: [
      { by: "x/one", head: A, approve: true, at: "2026-10-28T09:00:00.000Z" },
      { by: "x/two", head: A, approve: false, at: "2026-10-28T09:10:00.000Z" },
      { by: "x/one", head: B, approve: true, at: "2026-10-28T09:30:00.000Z", retained: { oldHead: A, reason: "the merge brought in only main's changes" } },
      { by: "x/old", head: B, approve: true, at: "2026-10-28T09:40:00.000Z", withdrawn: { at: "x", reason: "criteria changed" } },
    ],
    events: [{ kind: "review.not_retained", at: "2026-10-28T09:20:00.000Z", data: { head: "c".repeat(40), from: A, approvals: ["x/one"], reason: "main changed src/a.ts" } }],
    criteriaReview: { status: { approved: true, reason: "approved" } },
    landJob: { by: "owner", at: "2026-10-28T11:00:00.000Z", quote: "land it" },
    mode: { mode: "fast", line: "fast mode on the developer's words" },
  };
  assert.equal(dispatchStateOf(d), "approved, not dispatched");
  const heads = approvalsByHead(d);
  assert.deepEqual(heads[0], { head: B, current: true, since: "2026-10-28T09:30:00.000Z", approvedBy: ["x/one"], rejectedBy: [], carried: [{ by: "x/one", from: A, reason: "the merge brought in only main's changes" }], notCarried: [] });
  assert.deepEqual([heads[1].approvedBy, heads[1].rejectedBy, heads[1].notCarried[0].reason], [["x/one"], ["x/two"], "main changed src/a.ts"]);
  assert.deepEqual(standingGoOf(d), { landing: d.landJob, overrideConfirmation: d.item.overrideConfirmation, fastMode: "fast mode on the developer's words" });
});

test("situation lists G6's standing instructions, each with whether it acts now, beside the standing decisions", async () => {
  const fast = await cli(["mode", "fast", "--reason", "the test's fast run", "--quote", "go fast for the test", "--project", "demo"], { ATELIER_ACTOR: ACTING });
  assert.equal(fast.code, 0, fast.stderr);
  const set = await cli(["decide", "--standing", "queue-landable", "on", "--quote", "queue what is landable", "--project", "demo"]);
  assert.equal(set.code, 0, set.stderr);
  const s = JSON.parse((await cli(["situation", "--project", "demo", "--json"])).stdout);
  const i = s.standingInstructions.find((x) => x.key === "queue-landable");
  assert.ok(i, JSON.stringify(s.standingInstructions));
  assert.deepEqual([i.value, i.acts, i.quote], ["on", true, "queue what is landable"]);
  assert.ok(!s.standing.some((d) => d.id === i.id), "an instruction is listed once, as an instruction");
  assert.match((await cli(["situation", "--project", "demo"])).stdout, new RegExp(`${i.id}: queue-landable = on .*withdraw with atelier decisions withdraw ${i.id}`));
  assert.equal((await cli(["mode", "full", "--quote", "back to full", "--project", "demo"], { ATELIER_ACTOR: ACTING })).code, 0);
  const after = JSON.parse((await cli(["situation", "--project", "demo", "--json"])).stdout);
  const off = after.standingInstructions.find((x) => x.id === i.id);
  assert.equal(off?.acts ?? false, false, "outside fast mode it does not act");
});
