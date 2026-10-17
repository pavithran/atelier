import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { judge, waitFor } from "../cli/wait.mjs";
import { duplicateRunners, formatProcesses, liveProcesses, parseLsof, parsePs, startRefusal } from "../cli/procs.mjs";

import { criteriaOf } from "../src/criteria.ts";

const detail = (state, over = {}, reviews = []) => ({ item: { id: "t5", state, head: "a".repeat(40), owner: "codex/gpt-6", ...over }, reviews });
const review = (by, approve, head = "a".repeat(40)) => ({ by, approve, head, criteria: criteriaOf({}), at: "2026-10-09T10:00:00Z" });

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
async function runWait(t, details, argv, { command = "wait", handle, setup = () => ({}), boundMs } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-test-wait-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const queue = [...details];
  const server = createServer((req, res) => {
    if (handle) return handle(req, res);
    const ok = req.url === "/api/projects/demo/items/t5";
    const d = ok ? (queue.length > 1 ? queue.shift() : queue[0]) : { error: "not_found", detail: "no such task" };
    res.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(d));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ server: "x", owner: "owner", projects: {} }));
  const child = spawn(process.execPath, [cli, command, ...argv], {
    cwd: dir, env: { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_CACHE: join(dir, "cache"), ATELIER_TOKEN: "test-token", ATELIER_ACTOR: "owner", ATELIER_SERVER: `http://127.0.0.1:${server.address().port}`, ...setup(dir) },
  });
  t.after(() => child.kill("SIGKILL"));
  let output = "", bounded = false; child.stdout.on("data", (s) => output += s); child.stderr.on("data", (s) => output += s);
  // A run past boundMs is killed and reported as bounded, so a test of a
  // deadline fails rather than hangs when the deadline never fires.
  const bound = boundMs && setTimeout(() => { bounded = true; child.kill("SIGKILL"); }, boundMs);
  const code = await new Promise((done) => child.on("close", done));
  clearTimeout(bound);
  return { code, output: output.trim(), bounded };
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


test("reviewed ignores withdrawn, unbound and stale-criteria verdicts", () => {
  for (const r of [
    { ...review("a/b", false), withdrawn: { at: "now", reason: "obsolete" } },
    { ...review("a/b", true), criteria: undefined },
    { ...review("a/b", false), criteria: criteriaOf({ accept: ["old requirement"] }) },
  ]) assert.equal(judge("reviewed", detail("submitted", {}, [r])), null);
});

test("processes absent from the current table disappear, and root ancestry terminates", () => {
  const ps = parsePs(PS + "\n  0 0 01:00 kernel_task\n  1 0 01:00 launchd");
  const live = liveProcesses({ ps, lsof: parseLsof(LSOF), work: "/cache/work" });
  assert.equal(live.runners.length, 2);
  const dead = liveProcesses({ ps: ps.filter((p) => ![100, 102, 300].includes(p.pid)), lsof: parseLsof(LSOF), work: "/cache/work", skip: [400] });
  assert.deepEqual(dead.agents, []);
  assert.deepEqual(dead.runners.map((r) => r.pid), [200]);
});

test("wait CLI covers submission, both review verdicts, blocking and any-change", async (t) => {
  for (const [target, reads, code, text] of [
    ["submitted", [detail("claimed"), detail("submitted")], 0, /is submitted/],
    ["reviewed", [detail("submitted"), detail("submitted", {}, [review("a/b", true)])], 0, /approved by a\/b/],
    ["reviewed", [detail("submitted", {}, [review("a/b", false)])], 1, /rejected by a\/b/],
    ["merged", [detail("blocked")], 1, /is blocked/],
    ["any-change", [detail("claimed"), detail("claimed", { owner: "a/b" })], 0, /changed/],
  ]) {
    const r = await runWait(t, reads, ["t5", "--project", "demo", "--for", target, "--interval", "0.01"]);
    assert.equal(r.code, code, r.output);
    assert.match(r.output, text);
  }
});


// The deadline is the CLI's own --timeout; the test waits on the process and
// the server's close events, not on a wall-clock limit of its own, which a
// loaded host (two CLI startups in a landing's full run) can exceed (t568).
// BOUND_MS, far past any host's startup time, only ends a CLI whose deadline
// never fires, and the test then fails.
test("wait deadline aborts stalled headers and stalled response bodies", async (t) => {
  const BOUND_MS = 60_000;
  for (const body of [false, true]) {
    let closed;
    const disconnected = new Promise((resolve) => { closed = resolve; });
    let reads = 0;
    const result = await runWait(t, [], ["t5", "--project", "demo", "--timeout", "0.15"], {
      boundMs: BOUND_MS,
      handle(req, res) {
        reads++;
        res.on("close", closed);
        if (body) {
          res.writeHead(200, { "content-type": "application/json" });
          res.write('{"item":');
        }
      },
    });
    assert.equal(result.bounded, false, `the CLI was still waiting after ${BOUND_MS} ms: its deadline did not abort the ${body ? "stalled body" : "stalled headers"}`);
    assert.equal(result.code, 3, result.output);
    assert.match(result.output, /gave up waiting for merged/);
    await disconnected;
    assert.equal(reads, 1, "deadline cancellation must not retry");
  }
});

test("wait deadline cancels a later read and rejects a late success", async () => {
  let calls = 0, signal;
  const result = await waitFor("merged", async (s) => {
    if (++calls === 1) return detail("claimed");
    signal = s;
    return new Promise(() => {});
  }, { timeoutMs: 50, intervalMs: 1 });
  assert.equal(result.code, 3);
  assert.equal(signal.aborted, true);
  const c = clock();
  const late = await waitFor("merged", async () => {
    await c.sleep(100);
    return detail("merged");
  }, { ...c, timeoutMs: 50 });
  assert.equal(late.code, 3);
});

test("plain status prints this machine's runners and agents by task without command lines", async (t) => {
  const result = await runWait(t, [], [], {
    command: "status",
    handle(req, res) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
    },
    setup(dir) {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      for (const [name, output] of [["ps", PS], ["lsof", LSOF.replaceAll("/cache/work", join(dir, "cache/work"))]]) {
        const script = name === "ps"
          ? `import { spawnSync } from "node:child_process";
// Any other listing goes to the real ps unbuffered: its output (with every
// process's environment) passed Node's 1 MB buffer on a busy host (t551).
if (process.argv.includes("pid=,ppid=,etime=,args=")) process.stdout.write(${JSON.stringify(output)});
else process.exitCode = spawnSync("/bin/ps", process.argv.slice(2), { stdio: "inherit" }).status ?? 1;`
          : `process.stdout.write(${JSON.stringify(output)});`;
        writeFileSync(join(bin, name), `#!${process.execPath}\n${script}\n`, { mode: 0o755 });
      }
      return { PATH: `${bin}:${process.env.PATH}` };
    },
  });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Live on this Mac:/);
  assert.match(result.output, /runner home:mac  pid 100  up 2h3m  working on t7/);
  assert.match(result.output, /demo\/t7  claude pid 102/);
  assert.match(result.output, /demo\/t9  codex pid 300/);
  for (const secret of ["SECRETPROMPT", "/secret/cfg.json", "--config", "the brief"]) {
    assert.ok(!result.output.includes(secret), result.output);
  }
});

// t581: fifteen runners named home:mbp ran on one Mac for 13 hours.
const twins = [
  { pid: 11, name: "home:mbp", age: "1h", tasks: [] },
  { pid: 12, name: "HOME:MBP", age: "2h", tasks: ["t7"] },
  { pid: 13, name: "home:mbp-int", age: "2h", tasks: [] },
];

test("a start is refused, naming the pid, while a runner of that name lives (t581)", () => {
  assert.match(startRefusal(twins, "home:mbp"), /already running on this Mac \(pid 11, 12\).*--replace/);
  assert.match(startRefusal(twins, "Home:MBP-int"), /pid 13/);
  assert.equal(startRefusal(twins, "home:other"), null);
  assert.equal(startRefusal([], "home:mbp"), null);
});

test("status flags a runner name that two processes share (t581)", () => {
  assert.deepEqual(duplicateRunners(twins), [{ name: "home:mbp", pids: [11, 12] }]);
  assert.match(formatProcesses({ runners: twins, agents: [] }), /duplicate runner name home:mbp: pids 11, 12/);
  assert.doesNotMatch(formatProcesses({ runners: twins.slice(1), agents: [] }), /duplicate/);
});
