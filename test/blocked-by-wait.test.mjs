// Atelier 2.0, lessons gap G3, the read: tasks wait on tasks (blockedBy),
// which the queue, a claim and a landing honour and `show` lists, and
// `atelier wait` waits on a condition: --all or --any of tasks, a stage, a
// review request answered, a runner silent. Each test drives the real Node
// server, its Ledgers and the real CLI through real transitions, a server
// restart among them. Every credential here is a dummy.
import { strict as assert } from "node:assert";
import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { execFileSync } from "node:child_process";
import { startServer } from "../src/runtime/server.mjs";
import "./support/default-proof.ts";
import { claimRefusedLine, lostToHold } from "../cli/runner.mjs";
import { ROLE_PROMPTS } from "../src/usage.ts";
import { judgeCondition, waitUntil } from "../cli/wait.mjs";

const run = promisify(execFile);
const OWNER = "atl_00112233445566778899aabbccddeeff";
const AGENT = "codex/gpt-6";
const OTHER = "claude-code/opus-5.5";
const ACTING = "claude-code/opus-5.5";
const root = mkdtempSync(join(tmpdir(), "atelier-blocked-by-"));
after(() => rmSync(root, { recursive: true, force: true }));
const sha = (c) => c.repeat(40);

let server, port;
const dataDir = join(root, "data");
const L = () => server.namespace.get(server.namespace.idFromName("project:demo"));
async function api(method, path, body, token = OWNER) {
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-atelier-actor": "owner", ...(token === OWNER ? { "x-atelier-acting": ACTING } : {}) },
  });
  return { status: res.status, body: await res.json() };
}
const config = join(root, "config");
const cliEnv = (extra = {}) => {
  const env = { ...process.env, ATELIER_CONFIG_DIR: config, ATELIER_TOKEN: OWNER, ATELIER_SERVER: `http://127.0.0.1:${port}`, ATELIER_SECRET_STORE: "file", NO_COLOR: "1", ATELIER_ACTING: ACTING, ATELIER_RETRY_MS: "200,200,200", ...extra };
  for (const k of ["ATELIER_PROJECT", "ATELIER_ACTOR", "ATELIER_JSON"]) if (!(k in extra)) delete env[k];
  return env;
};
async function cli(argv, extra = {}) {
  try { const { stdout, stderr } = await run(process.execPath, ["cli/atelier.mjs", ...argv], { env: cliEnv(extra), timeout: 60_000 }); return { code: 0, stdout, stderr }; }
  catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
}
// A wait started in the background, so the test makes the transitions it
// waits for; resolves to its exit code and output, and when it ended.
function waiting(argv) {
  const child = spawn(process.execPath, ["cli/atelier.mjs", "wait", ...argv, "--project", "demo", "--interval", "0.1"], { env: cliEnv() });
  let out = "";
  child.stdout.on("data", (s) => out += s); child.stderr.on("data", (s) => out += s);
  const done = new Promise((ok) => child.on("close", (code) => ok({ code, out: out.trim(), at: Date.now() })));
  return { child, done, ended: () => child.exitCode !== null };
}
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function task(title) {
  const r = await api("POST", "/projects/demo/items", { title });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return (r.body.item ?? r.body).id;
}
// Claim, push, submit, accept, land and merge, as the Ledger records a landing.
async function merge(id, head = sha("e")) {
  const claim = await L().claim(id, AGENT);
  await L().recordToken(id, AGENT, claim.generation, null, null);
  await L().observePush(id, head, (await L().item(id)).head ?? null);
  await observed(id, head);
  await L().submit(id, AGENT, "done");
  await L().accept(id, "owner");
  await L().beginLanding(id, "owner", head);
  await L().merged(id, "owner", sha("9"), true);
  assert.equal((await L().item(id)).state, "merged");
}
// The changed paths a landing reads, as an observed check records them.
const observed = (id, head) => L().addEvidence({ itemId: id, claim: "git status", grade: "observed", head, passed: true, by: AGENT, at: new Date().toISOString(), changedPaths: ["docs/a.md"] });
async function start() {
  server = await startServer({ env: "test", dataDir, host: "127.0.0.1", port: port ?? 0, vars: { ATELIER_TOKEN: OWNER } });
  port = Number(new URL(server.url).port);
}

before(async () => {
  mkdirSync(config);
  await start();
  assert.equal((await api("PUT", "/projects/demo", { checks: ["git status"] })).status, 200);
});
after(async () => { await server?.close(); });

test("a task with blockers is listed by show, offered to no runner, claimed and accepted by none until every blocker merges", async () => {
  const first = await task("Blocker");
  const waits = await task("Waits on the blocker");
  const set = await cli(["edit", waits, "--blocked-by", first, "--project", "demo"]);
  assert.equal(set.code, 0, set.stderr);
  assert.match(set.stdout, new RegExp(`${waits} waits on ${first}`));
  const blockedEvent = (await L().events(waits, 50)).find((e) => e.kind === "item.blocked_by");
  assert.deepEqual(blockedEvent.data.blockedBy, [first]);
  assert.equal(blockedEvent.data.acting, ACTING, "the developer-token write names the acting model (G18)");

  const shown = await cli(["show", waits, "--project", "demo"]);
  assert.match(shown.stdout, new RegExp(`Blocked by: ${first} \\(open\\); it waits until each is merged`));
  const json = JSON.parse((await cli(["show", waits, "--project", "demo", "--json"])).stdout);
  assert.deepEqual(json.blockedBy, [{ id: first, state: "open" }]);
  assert.ok(json.holds.some((h) => h.kind === "blocked-by" && h.blocker === first));

  // Dispatched, it waits in the queue, said why, and a runner's poll is offered nothing.
  assert.equal((await api("POST", `/projects/demo/items/${waits}/dispatch`, { to: "home", agent: "opencode", model: "glm-5.3" })).status, 200);
  const runner = (await api("POST", "/tokens", { runner: "home:studio", projects: ["demo"] })).body.token;
  const poll = async () => (await api("POST", "/queue", { runner: "home:studio", kind: "home", jobs: ["build"], agents: [{ agent: "opencode", models: ["glm-5.3"] }] }, runner)).body;
  assert.deepEqual((await poll()).map((q) => q.item.id), [], "a waiting task is offered to no runner");
  const why = (await api("GET", "/queue")).body.find((q) => q.item.id === waits).item.why;
  assert.match(why[0].line, new RegExp(`^Waiting on ${first} \\(open\\) to merge`));
  const status = await cli(["show", waits, "--project", "demo"]);
  assert.match(status.stdout, /Waiting on t\d+ \(open\) to merge/);

  // A claim and an acceptance are refused, each naming the next command.
  await assert.rejects(L().claim(waits, "opencode/glm-5.3"), (e) => /^409\|blocked_by\|/.test(e.message) && /atelier wait --all t\d+ --for merged/.test(e.message));
  const viaCli = await cli(["claim", waits, "--project", "demo", "--as", "opencode/glm-5.3"], { ATELIER_JSON: "1" });
  assert.notEqual(viaCli.code, 0);
  const refusal = JSON.parse(viaCli.stderr.trim().split("\n").at(-1));
  assert.equal(refusal.code, "blocked_by");
  assert.match(refusal.next, /atelier wait --all/);
  // The runner reads that answer as a wait, keeping no refusal of the task.
  const line = `atelier: blocked_by: ${refusal.detail}`;
  assert.match(claimRefusedLine(line), /^claim held, waiting:/);
  assert.equal(lostToHold({ claimRefused: true, reason: line }), true);

  // Once the blocker merges, the runner is offered it and the claim goes through.
  await merge(first);
  assert.deepEqual((await poll()).map((q) => q.item.id), [waits]);
  assert.match((await cli(["show", waits, "--project", "demo"])).stdout, /Blocked by: t\d+ \(merged\); every one is merged/);
  const claimed = await L().claim(waits, "opencode/glm-5.3", { runner: "home:studio", kind: "home" });
  assert.equal(claimed.item.state, "claimed");
});

test("the lander refuses to accept a claimed task that a later edit made wait on an unmerged task", async () => {
  const blocker = await task("Late blocker");
  const id = await task("Claimed first");
  const claim = await L().claim(id, AGENT);
  await L().recordToken(id, AGENT, claim.generation, null, null);
  await L().observePush(id, sha("f"), null);
  await observed(id, sha("f"));
  await L().submit(id, AGENT, "done");
  assert.equal((await cli(["edit", id, "--blocked-by", blocker, "--project", "demo"])).code, 0);
  await assert.rejects(L().accept(id, "owner"), (e) => /^409\|blocked_by\|.*before it is accepted/.test(e.message));
  // Clearing the list lets it through.
  assert.equal((await cli(["edit", id, "--blocked-by", "", "--project", "demo"])).code, 0);
  assert.equal((await L().accept(id, "owner")).state, "accepted");
});

test("an abandoned blocker leaves the task blocked and listed, never released; the claim names the developer's command", async () => {
  const gone = await task("Will be abandoned");
  const id = await task("Waits on the abandoned");
  assert.equal((await cli(["edit", id, "--blocked-by", gone, "--project", "demo"])).code, 0);
  await L().abandon(gone, "owner", "dropped");
  const s = JSON.parse((await cli(["situation", "--project", "demo", "--json"])).stdout);
  assert.deepEqual(s.tasks.find((t) => t.id === id).blockedBy, [{ id: gone, state: "abandoned" }]);
  const hold = s.holds.find((h) => h.task === id && h.kind === "blocked-by");
  assert.deepEqual(hold.blockers.map((b) => [b.id, b.state]), [[gone, "abandoned"]]);
  assert.match((await cli(["situation", "--project", "demo"])).stdout, new RegExp(`${id} waits on ${gone} \\(abandoned\\) to merge`));
  assert.equal((await L().item(id)).blockedBy[0], gone, "the list stays as the developer set it");
  await assert.rejects(L().claim(id, AGENT), (e) => /blocked_by/.test(e.message) && /will never merge/.test(e.message) && /only the developer can: atelier edit t\d+ --blocked-by ''/.test(e.message));
  // A wait on it ends at once with exit 4, naming it.
  const w = await cli(["wait", "--all", `${gone},${id}`, "--for", "merged", "--project", "demo", "--interval", "0.1"]);
  assert.equal(w.code, 4, w.stdout + w.stderr);
  assert.match(w.stdout, new RegExp(`^${gone} is abandoned`));
});

test("a cycle is refused at edit time, through any chain, and nothing changes", async () => {
  const a = await task("Cycle A"), b = await task("Cycle B"), c = await task("Cycle C");
  assert.equal((await cli(["edit", a, "--blocked-by", b, "--project", "demo"])).code, 0);
  assert.equal((await cli(["edit", b, "--blocked-by", c, "--project", "demo"])).code, 0);
  const loop = await cli(["edit", c, "--blocked-by", a, "--project", "demo"], { ATELIER_JSON: "1" });
  assert.notEqual(loop.code, 0);
  const r = JSON.parse(loop.stderr.trim().split("\n").at(-1));
  assert.equal(r.code, "blocked_by_cycle");
  assert.match(r.detail, new RegExp(`${c} waits on ${a} waits on ${b} waits on ${c}`));
  assert.ok(r.next);
  assert.equal((await L().item(c)).blockedBy, undefined, "nothing was changed");
  const self = await cli(["edit", a, "--blocked-by", a, "--project", "demo"]);
  assert.notEqual(self.code, 0);
  assert.match(self.stderr, /blocked_by_cycle: t\d+ cannot wait on itself/);
  assert.match(self.stderr, /next: /);
  const unknown = await cli(["edit", a, "--blocked-by", "t999", "--project", "demo"]);
  assert.match(unknown.stderr, /no_item/);
});

test("wait --all returns 0 once every task merges, at once when they already have, and 3 at its timeout", async () => {
  const a = await task("Wait A"), b = await task("Wait B");
  const w = waiting(["--all", `${a},${b}`, "--for", "merged"]);
  await pause(400);
  assert.equal(w.ended(), false);
  await merge(a);
  await pause(400);
  assert.equal(w.ended(), false, "one of two is not all");
  await merge(b);
  const done = await w.done;
  assert.equal(done.code, 0, done.out);
  assert.equal(done.out, `${a}, ${b} merged`);
  // Already met: at once.
  const t0 = Date.now();
  const again = await cli(["wait", "--all", `${a},${b}`, "--project", "demo"]);
  assert.equal(again.code, 0, again.stderr);
  assert.ok(Date.now() - t0 < 10_000);
  const c = await task("Never merges");
  const slow = await cli(["wait", "--any", c, "--for", "merged", "--timeout", "0.5", "--interval", "0.1", "--project", "demo"]);
  assert.equal(slow.code, 3, slow.stdout + slow.stderr);
  assert.match(slow.stdout, new RegExp(`${c} is open \\(filed\\); gave up waiting`));
});

test("wait --any returns when one task reaches a stage; a stage target reads the recorded stage", async () => {
  const a = await task("Any A"), b = await task("Any B");
  const w = waiting(["--any", `${a},${b}`, "--for", "built"]);
  await pause(300);
  const claim = await L().claim(b, AGENT);
  await L().recordToken(b, AGENT, claim.generation, null, null);
  assert.equal(w.ended(), false, "building is short of built");
  await L().observePush(b, sha("1"), null);
  const done = await w.done;
  assert.equal(done.code, 0, done.out);
  assert.equal(done.out, `${b} reached built`);
  const one = await cli(["wait", b, "--for", "building", "--project", "demo"]);
  assert.equal(one.code, 0, "a later stage counts");
});

test("wait survives a server restart, reading again once it is back; two waits on one task do not interfere and hold no lock", async () => {
  const id = await task("Across a restart");
  const w1 = waiting(["--all", id, "--for", "merged"]);
  const w2 = waiting([id]);
  await pause(400);
  await server.close();
  await pause(800);
  assert.equal(w1.ended() || w2.ended(), false, "a server away is no outcome");
  await start();
  // Writes go through while two waits read the same task.
  await merge(id);
  const [d1, d2] = await Promise.all([w1.done, w2.done]);
  assert.equal(d1.code, 0, d1.out);
  assert.equal(d2.code, 0, d2.out);
  assert.equal(d2.out.split("\n").at(-1), `${id} merged`, "the retries say so on stderr, the outcome is the last line");
});

test("wait --for answered returns once the task's review request is answered, at once when none is open", async () => {
  const id = await task("Review asked");
  const claim = await L().claim(id, AGENT);
  await L().recordToken(id, AGENT, claim.generation, null, null);
  await L().observePush(id, sha("2"), null);
  await observed(id, sha("2"));
  await L().submit(id, AGENT, "done");
  const opus = { id: "opus-5.5", harness: "claude-code", where: "cloud", provider: "subscription", aliases: [], family: "anthropic", note: "", addedBy: "owner", addedAt: new Date().toISOString() };
  await L().requestReview(id, "owner", OTHER, [opus], true);
  const w = waiting([id, "--for", "answered"]);
  await pause(400);
  assert.equal(w.ended(), false, "an open request is not answered");
  const claimed = await L().claimReview(id, OTHER, { runner: "home:a", kind: "home" }, true);
  await L().addReview({ itemId: id, by: OTHER, head: sha("2"), approve: true, criteria: (await L().detail(id)).criteria, note: "Fine", at: new Date().toISOString(), request: claimed.request }, undefined, true);
  const done = await w.done;
  assert.equal(done.code, 0, done.out);
  assert.equal(done.out, `the review requests of ${id} are answered`);
  const none = await cli(["wait", id, "--for", "answered", "--project", "demo"]);
  assert.equal(none.code, 0);
});

test("wait --runner --silent returns when the runner's last poll is that old, or it never polled", async () => {
  const index = server.namespace.get(server.namespace.idFromName("__index"));
  await index.putRunnerOffer({ runner: "home:quiet", kind: "home", jobs: ["build"], agents: [], projects: ["demo"] }, new Date(Date.now() - 12 * 60_000).toISOString());
  const quiet = await cli(["wait", "--runner", "home:quiet", "--silent", "10", "--project", "demo"]);
  assert.equal(quiet.code, 0, quiet.stderr);
  assert.match(quiet.stdout, /home:quiet has been silent 12 minutes/);
  await index.putRunnerOffer({ runner: "home:busy", kind: "home", jobs: ["build"], agents: [], projects: ["demo"] }, new Date().toISOString());
  const busy = await cli(["wait", "--runner", "home:busy", "--silent", "10", "--timeout", "0.5", "--interval", "0.1", "--project", "demo"]);
  assert.equal(busy.code, 3);
  await api("POST", "/tokens", { runner: "home:fresh", projects: ["demo"] });
  assert.match((await cli(["wait", "--runner", "home:fresh", "--silent", "1", "--project", "demo"])).stdout, /never polled/);
  assert.equal((await cli(["wait", "--runner", "home:nobody", "--silent", "1", "--project", "demo"])).code, 1);
});

test("waitUntil judges on an injected clock: a server away is retried, a refusal is not", async () => {
  let t = 0;
  const clock = { now: () => t, sleep: async (ms) => { t += ms; } };
  const s = (state) => ({ project: "demo", tasks: [{ id: "t1", state, stage: state === "merged" ? "landed" : "building" }], reviewRequests: [], runners: [] });
  const down = Object.assign(new Error("server request failed"), { code: 4 });
  const reads = [s("claimed"), down, down, s("merged")];
  const r = await waitUntil({ kind: "tasks", mode: "all", ids: ["t1"], target: "merged" }, async () => { const x = reads.shift(); if (x instanceof Error) throw x; return x; }, { ...clock, intervalMs: 1000 });
  assert.deepEqual([r.code, r.text], [0, "t1 merged"]);
  assert.equal(judgeCondition({ kind: "tasks", mode: "all", ids: ["t1"], target: "merged" }, s("blocked")).ok, false);
  assert.equal(judgeCondition({ kind: "tasks", mode: "all", ids: ["t2"], target: "merged" }, s("open")).ok, false);
});

test("the orchestrator guide says to use wait, and nothing shipped polls with sleep for a task state", () => {
  assert.match(ROLE_PROMPTS.orchestrate, /atelier wait/);
  assert.match(ROLE_PROMPTS.orchestrate, /never a `?sleep`? loop/i);
  assert.match(readFileSync("docs/orchestrating.md", "utf8"), /atelier wait --all/);
  const files = execFileSync("git", ["ls-files", "scripts", "bin", "hooks", "docs", "*.md", "cli"], { encoding: "utf8" }).split("\n")
    .filter((f) => f && !/\.test\.|\.spec\./.test(f) && /\.(sh|md|mjs|js|ts)$/.test(f) || /^(hooks|bin)\/[^.]+$/.test(f));
  const offenders = [];
  for (const f of files) {
    let text;
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (!/\bsleep\s+\d/.test(line)) return;
      const window = lines.slice(Math.max(0, i - 8), i + 9).join("\n");
      if (/atelier\s+(show|status|ls|situation|events|queue|stuck)\b/.test(window)) offenders.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], "a shell sleep loop reading a task's state; use atelier wait");
});

test("a blocker added after acceptance keeps the acceptance but blocks the landing: no merge begins and no landing grant is issued", async () => {
  const blocker = await task("Blocks after acceptance");
  const id = await task("Accepted, then made to wait");
  const head = sha("7");
  const claim = await L().claim(id, AGENT);
  await L().recordToken(id, AGENT, claim.generation, null, null);
  await L().observePush(id, head, null);
  await observed(id, head);
  await L().submit(id, AGENT, "done");
  await L().accept(id, "owner");
  const set = await cli(["edit", id, "--blocked-by", blocker, "--project", "demo"]);
  assert.equal(set.code, 0, set.stderr);
  assert.equal((await L().item(id)).state, "accepted", "the acceptance stands");
  await assert.rejects(L().beginLanding(id, "owner", head), (e) => /^409\|blocked_by\|.*before it is merged/.test(e.message) && /atelier wait --all/.test(e.message));
  await L().beginProjectLanding(id, "owner");
  const grant = await api("POST", "/projects/demo/git-token", { kind: "landing", item: id, head });
  assert.equal(grant.status, 409, JSON.stringify(grant.body));
  assert.equal(grant.body.error, "blocked_by");
  assert.match(grant.body.next, /atelier wait --all/);
  await L().cancelProjectLanding(id, "owner");
  // Once the blocker merges, the landing goes through.
  await merge(blocker, sha("8"));
  await L().beginLanding(id, "owner", head);
  assert.equal((await L().merged(id, "owner", sha("6"), true)).state, "merged");
});

test("--any --for answered keeps its quantifier: one of the tasks answered is enough, all needs every one", () => {
  const s = { project: "demo", tasks: [{ id: "t1", state: "submitted" }, { id: "t2", state: "submitted" }], reviewRequests: [{ task: "t1", id: 1 }], runners: [] };
  const first = { ...s, reviewRequests: [{ task: "t1", id: 1 }, { task: "t2", id: 2 }] };
  const any = judgeCondition({ kind: "answered", mode: "any", ids: ["t1", "t2"] }, s, first);
  assert.deepEqual([any.ok, any.text], [true, "the review requests of t2 are answered"]);
  assert.equal(judgeCondition({ kind: "answered", mode: "all", ids: ["t1", "t2"] }, s, first), null);
});

test("wait --any --for answered through the CLI returns when one of two review requests is answered", async () => {
  const opus = { id: "opus-5.5", harness: "claude-code", where: "cloud", provider: "subscription", aliases: [], family: "anthropic", note: "", addedBy: "owner", addedAt: new Date().toISOString() };
  const ids = [];
  for (const [n, c] of [["One of two", "3"], ["Two of two", "4"]]) {
    const id = await task(n);
    const claim = await L().claim(id, AGENT);
    await L().recordToken(id, AGENT, claim.generation, null, null);
    await L().observePush(id, sha(c), null);
    await observed(id, sha(c));
    await L().submit(id, AGENT, "done");
    await L().requestReview(id, "owner", OTHER, [opus], true);
    ids.push(id);
  }
  const all = await cli(["wait", "--all", ids.join(","), "--for", "answered", "--timeout", "0.5", "--interval", "0.1", "--project", "demo"]);
  assert.equal(all.code, 3, "neither is answered");
  const w = waiting(["--any", ids.join(","), "--for", "answered"]);
  await pause(300);
  const claimed = await L().claimReview(ids[1], OTHER, { runner: "home:a", kind: "home" }, true);
  await L().addReview({ itemId: ids[1], by: OTHER, head: sha("4"), approve: true, criteria: (await L().detail(ids[1])).criteria, note: "Fine", at: new Date().toISOString(), request: claimed.request }, undefined, true);
  const done = await w.done;
  assert.equal(done.code, 0, done.out);
  assert.equal(done.out.split("\n").at(-1), `the review requests of ${ids[1]} are answered`);
  const still = await cli(["wait", "--all", ids.join(","), "--for", "answered", "--timeout", "0.5", "--interval", "0.1", "--project", "demo"]);
  assert.equal(still.code, 3, "one is still open");
});

test("under --json a wait that is not met prints {code, detail, next} with the same exit status: timeout, abandonment, unreadable", async () => {
  // The whole of stderr is the one object: no retry or other prose beside it.
  const lastJson = (r) => JSON.parse(r.stderr);
  const open = await task("Json: never merges");
  const slow = await cli(["wait", open, "--timeout", "0.3", "--interval", "0.1", "--project", "demo", "--json"]);
  assert.equal(slow.code, 3);
  assert.deepEqual(Object.keys(lastJson(slow)).sort(), ["code", "detail", "next"]);
  assert.equal(lastJson(slow).code, "timed_out");
  assert.ok(lastJson(slow).next);
  const gone = await task("Json: abandoned");
  await L().abandon(gone, "owner", "dropped");
  const dead = await cli(["wait", "--all", `${gone},${open}`, "--project", "demo"], { ATELIER_JSON: "1" });
  assert.equal(dead.code, 4);
  assert.equal(lastJson(dead).code, "abandoned");
  assert.match(lastJson(dead).detail, new RegExp(`^${gone} is abandoned`));
  assert.match(lastJson(dead).next, new RegExp(`atelier show ${gone}`));
  const away = await cli(["wait", open, "--project", "demo", "--json", "--for", "checked", "--interval", "0.05"], { ATELIER_SERVER: "http://127.0.0.1:9", ATELIER_RETRY_MS: "0,0" });
  assert.equal(away.code, 5, away.stderr);
  assert.equal(lastJson(away).code, "unreadable");
  const met = await cli(["wait", "--any", `${gone},${open}`, "--for", "filed", "--project", "demo", "--json"]);
  assert.equal(met.code, 0);
  assert.equal(JSON.parse(met.stdout).code, "met");
});

test("the default single-task wait rides a server down from the start and exits 5 with the JSON object", async () => {
  for (const extra of [{}, { ATELIER_JSON: "1" }]) {
    const argv = ["wait", "t1", "--project", "demo", "--interval", "0.05", ...(extra.ATELIER_JSON ? [] : ["--json"])];
    const one = await cli(argv, { ATELIER_SERVER: "http://127.0.0.1:9", ATELIER_RETRY_MS: "0,0", ...extra });
    assert.equal(one.code, 5, one.stderr);
    assert.equal(JSON.parse(one.stderr).code, "unreadable", "the whole of stderr is one object");
  }
  const away = await cli(["wait", "t1", "--project", "demo", "--json", "--interval", "0.05"], { ATELIER_SERVER: "http://127.0.0.1:9", ATELIER_RETRY_MS: "0,0" });
  assert.equal(away.code, 5, away.stderr);
  const r = JSON.parse(away.stderr);
  assert.deepEqual([r.code, Object.keys(r).sort()], ["unreadable", ["code", "detail", "next"]]);
});
