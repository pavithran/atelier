import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { judge, waitFor } from "../cli/wait.mjs";
import { formatProcesses, liveProcesses, parseLsof, parsePs } from "../cli/procs.mjs";

const detail = (state, over = {}, reviews = []) => ({ item: { id: "t5", state, head: "a".repeat(40), owner: "codex/gpt-6", ...over }, reviews });
const review = (by, approve, head = "a".repeat(40)) => ({ by, approve, head, at: "2026-10-09T10:00:00Z" });

test("merged: reached on merge, failed on abandoned or blocked, otherwise waiting", () => {
  assert.deepEqual(judge("merged", detail("merged")), { ok: true, text: "t5 merged" });
  assert.equal(judge("merged", detail("abandoned")).ok, false);
  assert.match(judge("merged", detail("blocked")).text, /blocked; it will not merge/);
  for (const s of ["open", "claimed", "submitted", "accepted", "integrated"]) assert.equal(judge("merged", detail(s)), null, s);
});

test("submitted: a task already past submission counts; a dead task fails", () => {
  assert.equal(judge("submitted", detail("claimed")), null);
  for (const s of ["submitted", "accepted", "integrated", "merged"]) assert.equal(judge("submitted", detail(s)).ok, true, s);
  assert.equal(judge("submitted", detail("abandoned")).ok, false);
});

test("reviewed: an approval at the head is reached, a rejection fails, another head's review does not count", () => {
  assert.equal(judge("reviewed", detail("submitted")), null);
  assert.equal(judge("reviewed", detail("submitted", {}, [review("claude-code/fable-5.1", true, "b".repeat(40))])), null);
  const ok = judge("reviewed", detail("submitted", {}, [review("claude-code/fable-5.1", true)]));
  assert.equal(ok.ok, true);
  assert.match(ok.text, /approved by claude-code\/fable-5\.1/);
  const no = judge("reviewed", detail("submitted", {}, [review("claude-code/fable-5.1", false)]));
  assert.equal(no.ok, false);
  assert.match(no.text, /rejected by/);
  assert.equal(judge("reviewed", detail("accepted")).ok, true, "past review with no review recorded here");
  assert.equal(judge("reviewed", detail("abandoned")).ok, false);
});

test("any-change: nothing until state, head, owner or a review differs from the first read", () => {
  const first = detail("claimed");
  assert.equal(judge("any-change", detail("claimed"), first), null);
  assert.match(judge("any-change", detail("submitted"), first).text, /claimed -> submitted/);
  assert.equal(judge("any-change", detail("claimed", { head: "c".repeat(40) }), first).ok, true);
  assert.equal(judge("any-change", detail("claimed", { owner: null }), first).ok, true);
  assert.equal(judge("any-change", detail("claimed", {}, [review("x/y", true)]), first).ok, true);
  assert.equal(judge("any-change", detail("abandoned"), first).ok, true, "a death is a change");
});

// A clock the sleeps advance, so no test waits.
const clock = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms; } }; };

test("waitFor polls until the task gets there, with exit code 0", async () => {
  const reads = [detail("claimed"), detail("claimed"), detail("merged")];
  const r = await waitFor("merged", async () => reads.shift(), { ...clock() });
  assert.deepEqual([r.ok, r.code, r.text], [true, 0, "t5 merged"]);
  assert.equal(reads.length, 0);
});

test("waitFor fails with code 1 when the task is abandoned mid-wait", async () => {
  const reads = [detail("claimed"), detail("abandoned")];
  const r = await waitFor("merged", async () => reads.shift(), { ...clock() });
  assert.deepEqual([r.ok, r.code], [false, 1]);
});

test("waitFor gives up at the timeout with code 3", async () => {
  const r = await waitFor("merged", async () => detail("claimed"), { ...clock(), intervalMs: 1000, timeoutMs: 3000 });
  assert.deepEqual([r.ok, r.code], [false, 3]);
  assert.match(r.text, /still claimed; gave up waiting for merged/);
});

test("waitFor rides through a server that is briefly unreachable, then gives up with code 4", async () => {
  const down = Object.assign(new Error("server request failed"), { code: 4 });
  const reads = [down, down, detail("merged")];
  const r = await waitFor("merged", async () => { const x = reads.shift(); if (x instanceof Error) throw x; return x; }, { ...clock() });
  assert.equal(r.code, 0);
  const dead = await waitFor("merged", async () => { throw down; }, { ...clock(), retries: 2 });
  assert.deepEqual([dead.ok, dead.code], [false, 4]);
  const refused = Object.assign(new Error("not_found: no such task"), { code: 1 });
  let calls = 0;
  const gone = await waitFor("merged", async () => { calls++; throw refused; }, { ...clock() });
  assert.deepEqual([gone.code, calls], [4, 1], "a refusal is not retried");
});

// The process table, as ps and lsof print it.
const PS = [
  "  100     1 02:03:04 /usr/bin/node /x/cli/atelier.mjs runner --name home:mac --config /secret/cfg.json",
  "  101   100       05:10 /bin/sh -c claude -p SECRETPROMPT",
  "  102   101       05:09 claude -p SECRETPROMPT",
  "  200     1    3-04:00:00 /usr/bin/node /x/cli/atelier.mjs runner",
  "  300     1       00:07 codex exec the brief",
  "  400     1       00:01 pgrep -f atelier.mjs runner",
  "  500     1       10:00 /usr/bin/vim notes.txt",
].join("\n");
const LSOF = [
  "p102", "cclaude", "n/cache/work/demo/t7/src",
  "p300", "ccodex", "n/cache/work/demo/t9",
  "p400", "cpgrep", "n/cache/work/demo/t7",
  "p500", "cvim", "n/home/pavi",
  "p100", "cnode", "n/cache/work/demo/t7",
].join("\n");

test("liveProcesses names runners and agents by task and keeps command lines out", () => {
  const live = liveProcesses({ ps: parsePs(PS), lsof: parseLsof(LSOF), work: "/cache/work", skip: [400] });
  assert.deepEqual(live.runners, [
    { pid: 100, name: "home:mac", age: "2h3m", tasks: ["t7"] },
    { pid: 200, name: "runner", age: "3d4h", tasks: [] },
  ]);
  assert.deepEqual(live.agents.map((a) => [a.pid, a.command, a.project, a.id]), [[102, "claude", "demo", "t7"], [300, "codex", "demo", "t9"]]);
  const text = formatProcesses(live);
  assert.match(text, /runner home:mac {2}pid 100 {2}up 2h3m {2}working on t7/);
  assert.match(text, /runner runner {2}pid 200 {2}up 3d4h {2}idle/);
  assert.match(text, /demo\/t7 {2}claude pid 102/);
  for (const secret of ["SECRETPROMPT", "/secret/cfg.json", "--config", "-p "]) assert.ok(!text.includes(secret), `${secret} is not printed`);
  assert.ok(!text.includes("pgrep") && !text.includes("vim"), "the asker and unrelated processes are left out");
});

test("liveProcesses can be limited to one project, and says so when nothing runs", () => {
  const live = liveProcesses({ ps: parsePs(PS), lsof: parseLsof(LSOF), work: "/cache/work", skip: [400], project: "other" });
  assert.deepEqual(live.agents, []);
  assert.match(formatProcesses({ runners: [], agents: [] }), /no runner process\n {2}no agent process in a task workspace/);
});

test("a review workspace tID-review-UUID is the task's agent", () => {
  const ps = parsePs("  10     1 01:00 /usr/bin/node /x/cli/atelier.mjs runner --name r\n  11    10 00:30 claude -p x");
  const lsof = parseLsof("p11\ncclaude\nn/cache/work/demo/t7-review-0a1b-22");
  const live = liveProcesses({ ps, lsof, work: "/cache/work" });
  assert.deepEqual(live.agents.map((a) => [a.pid, a.project, a.id]), [[11, "demo", "t7"]]);
  assert.deepEqual(live.runners[0].tasks, ["t7"]);
});

test("a command that merely mentions atelier runner is not a runner", () => {
  const ps = parsePs("  400     1 00:01 pgrep -f atelier.mjs runner\n  401     1 00:01 grep atelier runner");
  assert.deepEqual(liveProcesses({ ps, lsof: new Map(), work: "/cache/work" }).runners, []);
});

test("waitFor reads that keep failing still honour the timeout, code 3", async () => {
  const down = Object.assign(new Error("server request failed"), { code: 4 });
  const r = await waitFor("merged", async () => { throw down; }, { ...clock(), intervalMs: 5000, timeoutMs: 1000 });
  assert.deepEqual([r.ok, r.code], [false, 3]);
});

test("a blocked or abandoned task fails reviewed even with an approval at the head", () => {
  for (const state of ["blocked", "abandoned"]) {
    assert.equal(judge("reviewed", detail(state, {}, [review("codex/x", true)])).ok, false);
  }
});

test("a sleep is capped at the time left, and the deadline beats a late success", async () => {
  const c = clock(), slept = [];
  const reads = [detail("claimed"), detail("merged")];
  const r = await waitFor("merged", async () => reads.shift(), { now: c.now, sleep: async (ms) => { slept.push(ms); await c.sleep(ms); }, intervalMs: 60000, timeoutMs: 1000 });
  assert.deepEqual(slept, [1000]);
  assert.deepEqual([r.ok, r.code], [false, 3]);
  const d = clock(), down = Object.assign(new Error("down"), { code: 4 });
  const e = await waitFor("merged", async () => { throw down; }, { ...d, intervalMs: 60000, timeoutMs: 1000 });
  assert.equal(e.code, 3);
  assert.equal(d.now(), 1000);
});

test("reviewed: a rejection a later approval by the same reviewer superseded does not fail", () => {
  const rej = { ...review("codex/x", false), at: "2026-10-09T10:00:00Z" }, ok = { ...review("codex/x", true), at: "2026-10-09T11:00:00Z" };
  for (const s of ["submitted", "merged"]) assert.equal(judge("reviewed", detail(s, {}, [rej, ok])).ok, true, s);
  const later = { ...rej, at: "2026-10-09T12:00:00Z" };
  assert.equal(judge("reviewed", detail("submitted", {}, [ok, later])).ok, false);
});

test("a runner whose script path holds spaces is still a runner", () => {
  const path = "/Users/p/Library/Mobile Documents/com~apple~CloudDocs/cli/atelier.mjs";
  const ps = parsePs(`  10     1 01:00 /usr/bin/node ${path} runner --name icloud`);
  const live = liveProcesses({ ps, lsof: new Map(), work: "/cache/work" });
  assert.deepEqual(live.runners.map((r) => [r.pid, r.name]), [[10, "icloud"]]);
});

// `atelier wait` end to end against a stand-in server.
const cli = resolve("cli/atelier.mjs");
async function runWait(t, details, argv) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-wait-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const queue = [...details];
  const server = createServer((req, res) => {
    const ok = req.url === "/api/projects/demo/items/t5";
    const d = ok ? (queue.length > 1 ? queue.shift() : queue[0]) : { error: "not_found", detail: "no such task" };
    res.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(d));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  writeFileSync(join(dir, "config.json"), JSON.stringify({ server: "x", owner: "owner", projects: {} }));
  const child = spawn(process.execPath, [cli, "wait", ...argv], {
    cwd: dir, env: { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_CACHE: join(dir, "cache"), ATELIER_TOKEN: "test-token", ATELIER_ACTOR: "owner", ATELIER_SERVER: `http://127.0.0.1:${server.address().port}` },
  });
  let output = ""; child.stdout.on("data", (s) => output += s); child.stderr.on("data", (s) => output += s);
  const code = await new Promise((done) => child.on("close", done));
  return { code, output: output.trim() };
}

test("atelier wait prints the outcome and exits by it", async (t) => {
  const merged = await runWait(t, [detail("claimed"), detail("merged")], ["t5", "--project", "demo", "--interval", "0.05"]);
  assert.deepEqual([merged.code, merged.output], [0, "t5 merged"]);
  const dead = await runWait(t, [detail("abandoned")], ["t5", "--for", "submitted", "--project", "demo"]);
  assert.deepEqual([dead.code, dead.output], [1, "t5 is abandoned; it will not be submitted"]);
  const slow = await runWait(t, [detail("claimed")], ["t5", "--project", "demo", "--timeout", "0.2", "--interval", "0.05"]);
  assert.equal(slow.code, 3);
  const missing = await runWait(t, [], ["t6", "--project", "demo"]);
  assert.equal(missing.code, 4);
  const bad = await runWait(t, [], ["t5", "--for", "soon", "--project", "demo"]);
  assert.equal(bad.code, 1);
  assert.match(bad.output, /--for needs one of merged, submitted, reviewed, any-change/);
});
