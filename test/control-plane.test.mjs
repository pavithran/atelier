import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { SERVER_CAPABILITIES } from "../src/route-level.ts";

// ControlPlane is retired. These tests keep ControlPlane files in the checkout
// to show that merge, sync and init neither read nor write them; the policy
// merge compares is Atelier's own, as the ledger stores it.
function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-control-plane-"));
  const cp = join(dir, "docs/control-plane");
  mkdirSync(cp, { recursive: true });
  const write = (name, data) => writeFileSync(join(cp, `${name}.v1.json`), JSON.stringify(data));
  return Promise.resolve().then(() => run({ dir, write })).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const before = { protected: ["AGENTS.md"], eligible: ["claude"], refuseOverlap: false, approval: "Owner approved the copy", checks: ["npm test"] };
const IDENTITY = { name: "Project Owner", email: "123+owner@users.noreply.github.com", agentEmails: ["agents@atelier.example"] };

// A string as one single-quoted word in a /bin/sh script.
const shq = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

// `now` is the project's stored policy over the default, and `accepted` the
// policy snapshot the ledger recorded at acceptance (absent: protected paths
// alone, as an older acceptance recorded them).
function commandFixture(run, { now = {}, accepted = null } = {}) {
  return fixture(async ({ dir, write }) => {
    write("agent-policy", { agents: { codex: { available: true } } });
    write("execution-policy", { protected_path_patterns: ["src/**"] });
    write("project-adapter", { protected_surfaces: [{ pattern: "secrets/**" }] });
    const head = "a".repeat(40), base = "b".repeat(40);
    const log = join(dir, "calls.jsonl"), gitLog = join(dir, "git.jsonl"), gitDir = join(dir, "git-state");
    mkdirSync(gitDir);
    writeFileSync(log, "");
    writeFileSync(gitLog, "");
    writeFileSync(join(dir, "config.json"), JSON.stringify({ projects: { example: { path: dir, branch: "main" } } }));
    // A /bin/sh script, not a node one: a landing makes dozens of git calls,
    // and a node start (about 80 ms) cost several seconds a test (t771).
    // Settings are kept one file per key under git-settings, so the merge
    // configuration the merge installs (cli/merge-pipeline.mjs) reads back as
    // written.
    const settings = join(dir, "git-settings");
    mkdirSync(settings);
    writeFileSync(join(dir, "git"), String.raw`#!/bin/sh
# Each call is logged as one JSON array of its arguments.
printf '[' >> ${shq(gitLog)}
sep=''
for arg in "$@"; do
  case $arg in
    *[\\\"]*) arg=$(printf '%s' "$arg" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g') ;;
  esac
  printf '%s"%s"' "$sep" "$arg" >> ${shq(gitLog)}
  sep=','
done
printf ']\n' >> ${shq(gitLog)}
has() { needle=$1; shift; for arg in "$@"; do [ "$arg" = "$needle" ] && return 0; done; return 1; }
for last in "$@"; do :; done
prev=''; before=''
for arg in "$@"; do before=$prev; prev=$arg; done
if [ "$1" = config ] && has --get "$@"; then
  [ -f ${shq(settings)}/"$last" ] || exit 1
  printf '%s\n' "$(cat ${shq(settings)}/"$last")"
elif [ "$1" = config ] && [ "$2" = --local ]; then printf '%s' "$last" > ${shq(settings)}/"$before"
elif has --git-common-dir "$@"; then echo ${shq(gitDir)}
elif has --show-toplevel "$@"; then echo ${shq(dir)}
elif has status "$@" && [ -n "$TEST_DIRTY" ]; then echo ' M file'
elif has --absolute-git-dir "$@"; then echo ${shq(gitDir)}
elif has --abbrev-ref "$@"; then echo main
elif has rev-parse "$@"; then echo ${shq(head)}
# The fork point the baseline and the accepted revision share: none unless
# the test names one, as after atelier update moved the revision past its base.
elif [ "$1" = merge-base ] && ! has --is-ancestor "$@"; then echo "$TEST_FORK_POINT"
# Diffed from the recorded base, the revision shows a path the baseline
# changed since the fork; from its real fork point, only its own.
elif has diff "$@" && [ -n "$TEST_DIFF" ]; then printf '%b' "$TEST_DIFF"
elif has diff "$@"; then if has ${shq(base)} "$@"; then printf 'src/secret.ts\0'; else printf 'docs/own.md\0'; fi
# The commits a landing checks for their identity (t451): none unless the
# test names some, as a printf %b string, since the environment cannot carry a NUL.
elif [ "$1" = log ] && has '--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x1e' "$@"; then printf '%b' "$TEST_IDENTITY_LOG"
elif has merge "$@"; then echo 'merge reached' >&2; exit 1
elif [ "$1" = merge-base ] && [ "$last" != HEAD ]; then exit 1
fi
`, { mode: 0o755 });
    const storage = join(dir, "server.json");
    writeFileSync(storage, JSON.stringify({ policy: { ...before, commitIdentity: IDENTITY, ...now }, state: "accepted", acceptanceProtected: accepted?.protected ?? before.protected, acceptancePolicy: accepted }));
    const preload = join(dir, "fetch.mjs");
    writeFileSync(preload, `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const storage = ${JSON.stringify(storage)};
let { policy, state, acceptanceProtected, acceptancePolicy } = JSON.parse(readFileSync(storage, 'utf8'));
// A project from before t451, whose policy names no commit identity.
if (process.env.TEST_NO_IDENTITY) delete policy.commitIdentity;
// The acceptance on record was made before every field was recorded.
acceptancePolicy ??= { protected: acceptanceProtected };
if (process.env.TEST_SUBMITTED) state = 'submitted';
globalThis.fetch = async (url, options) => {
  // The capability check before merge and init (t458) reads the version.
  if (new URL(url).pathname === '/api/version') return Response.json({ capabilities: ${JSON.stringify(SERVER_CAPABILITIES)} });
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ url, method: options.method, body: options.body }) + '\\n');
  if (options.method === 'PUT') policy = { ...policy, ...JSON.parse(options.body) };
  if (options.method === 'PUT' && process.env.TEST_PUT_FAIL) return new Response('unavailable', { status: 500 });
  // As the Ledger records an acceptance: the policy it is made under.
  if (url.endsWith('/accept')) { state = 'accepted'; acceptanceProtected = policy.protected; acceptancePolicy = { protected: policy.protected, eligible: policy.eligible ?? [], refuseOverlap: policy.refuseOverlap ?? false, checks: policy.checks }; }
  writeFileSync(storage, JSON.stringify({ policy, state, acceptanceProtected, acceptancePolicy }));
  if (url.endsWith('/accept')) return Response.json({ state, acceptedHead: '${head}' });
  // A plan's refresh, which puts an accepted plan back to building.
  if (url.endsWith('/plan/refresh')) {
    if (process.env.TEST_REFRESH_REFUSED) return Response.json({ error: 'job_in_flight', detail: 'a refresh from main at cccccccc is queued' }, { status: 409 });
    state = 'open';
    writeFileSync(storage, JSON.stringify({ policy, state, acceptanceProtected, acceptancePolicy }));
    return Response.json({ item: { id: 't1', state }, refresh: { main: '${"c".repeat(40)}', last: { mainHead: '${"c".repeat(40)}', state: 'dispatched' } }, reopened: { from: 'accepted', acceptedHead: '${head}' } });
  }
  if (url.endsWith('/api/projects/example')) return Response.json({ project: { policy }, items: JSON.parse(process.env.TEST_ITEMS ?? '[]'), baseline: { token: 'test-token', remote: 'https://git.test/example' } });
  if (url.endsWith('/items/t1')) return Response.json({
    item: { id: 't1', state, head: '${head}', acceptedHead: '${head}', base: '${base}', scope: JSON.parse(process.env.TEST_SCOPE ?? '[]'), ...(process.env.TEST_KIND ? { kind: process.env.TEST_KIND } : {}) },
    policy, acceptanceProtected, acceptancePolicy, events: JSON.parse(process.env.TEST_EVENTS ?? '[]'), evidence: [], reviews: [],
  });
  return Response.json({ remote: 'https://git.test/example', token: 'test-token' });
};
`);
    const command = (args, extra = {}) => spawnSync(process.execPath, ["--import", preload, resolve("cli/atelier.mjs"), ...args, "--project", "example"], {
      cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ATELIER_CONFIG_DIR: dir, ATELIER_TOKEN: "test-token", ATELIER_SERVER: "https://atelier.test", ...extra },
    });
    const records = (file) => readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    await run({ command, dir, write, calls: () => records(log), gitCalls: () => records(gitLog) });
  });
}

// A full-history project's sync checks first that main holds the baseline's
// main (t644), with a read token and Git commands that only read. Since t149
// it then reads no ControlPlane file and sends no policy: a baseline already
// at main is left as it is (t242).
test("sync checks the baseline, then finds a full-history project already current and sends no policy", () => commandFixture(({ command, calls, gitCalls }) => {
  const result = command(["sync"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /example: the baseline already holds main/);
  assert.deepEqual(calls().map((c) => [c.method, new URL(c.url).pathname]), [["POST", "/api/projects/example/baseline-token"]]);
  assert.deepEqual(JSON.parse(calls()[0].body), { scope: "read" });
  assert.deepEqual([...new Set(gitCalls().map((args) => args.find((a) => !a.startsWith("-"))))].sort(), ["config", "fetch", "rev-parse"]);
}));

test("merge pins the registered checkout's git identity to the project's before it commits, once (t755)", () => commandFixture(({ command, dir, gitCalls }) => {
  // Finding: llm-basics, 2026-10-17, a commit in the registered checkout took
  // the global address and the baseline push was refused.
  rmSync(join(dir, "docs/control-plane"), { recursive: true });
  const first = command(["merge", "t1"]);
  assert.match(first.stdout, /Set this checkout's git identity to Project Owner <123\+owner@users\.noreply\.github\.com>/);
  const sets = () => gitCalls().filter((a) => a[0] === "config" && a[1] === "--local" && /^user\./.test(a.at(-2))).map((a) => a.slice(-2));
  assert.deepEqual(sets(), [["user.name", "Project Owner"], ["user.email", "123+owner@users.noreply.github.com"]]);
  const pinned = gitCalls().findIndex((a) => a.at(-2) === "user.email");
  assert.ok(pinned < gitCalls().findIndex((a) => a.includes("merge") && a.includes("--no-ff")), "pinned before the merge");
  const second = command(["merge", "t1"]);
  assert.doesNotMatch(second.stdout, /git identity/);
  assert.equal(sets().length, 2, "a matching identity is not written again");
}));

test("merge without ControlPlane files makes no project policy requests", () => commandFixture(({ command, dir, calls, gitCalls }) => {
  rmSync(join(dir, "docs/control-plane"), { recursive: true });
  const result = command(["merge", "t1"]);
  assert.doesNotMatch(result.stderr, /ControlPlane|newly protected/);
  assert.ok(!calls().some((c) => c.url.endsWith("/api/projects/example")));
  assert.ok(gitCalls().some((args) => args.includes("merge") && args.includes("--no-ff")));
}));

test("merge in a project with no commit identity refuses before Git merge, naming the init that sets one", () => commandFixture(({ command, dir, gitCalls }) => {
  rmSync(join(dir, "docs/control-plane"), { recursive: true });
  const result = command(["merge", "t1"], { TEST_NO_IDENTITY: "1" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /example has no commit identity in its policy; the developer sets one with atelier init --commit-name NAME --commit-email EMAIL .*\. Nothing was merged\./);
  assert.ok(!gitCalls().some((args) => args.includes("merge") && args.includes("--no-ff")));
}));

test("merge refuses an accepted revision whose new commits the policy refuses, naming each commit and field", () => commandFixture(({ command, dir, gitCalls }) => {
  rmSync(join(dir, "docs/control-plane"), { recursive: true });
  const c = "c".repeat(40), d = "d".repeat(40);
  const record = (...fields) => `${fields.join("\x00")}\x1e\n`;
  const log = record(c, "codex", "agents@atelier.example", "Project Owner", "123+owner@users.noreply.github.com") + record(d, "Pavi", "pavi@studio.local", "Pavi", "pavi@personal.example");
  const printable = log.replaceAll("\x00", "\\0000").replaceAll("\x1e", "\\0036").replaceAll("\n", "\\n");
  const result = command(["merge", "t1"], { TEST_IDENTITY_LOG: printable });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /t1's accepted revision holds commits whose identity the project's policy refuses:\n {2}commit dddddddddddd: the author email pavi@studio\.local is one Git guesses from the machine's user and host names\n {2}commit dddddddddddd: the committer email pavi@personal\.example is neither the project's commit address \(123\+owner@users\.noreply\.github\.com\) nor an agent address the policy allows \(agentEmails\)\nNothing was merged\./);
  assert.doesNotMatch(result.stderr, /cccccccc/, "the agent's allowed commit is not named");
  // Only the commits the baseline lacks are read.
  assert.ok(gitCalls().some((args) => args[0] === "log" && args.at(-1) === `${"a".repeat(40)}..${"a".repeat(40)}`));
  assert.ok(!gitCalls().some((args) => args.includes("merge") && args.includes("--no-ff")));
}));

test("a plan whose merge conflicts with main is put back to building through plan refresh, which withdraws its acceptance", () => commandFixture(({ command, calls, gitCalls }) => {
  const result = command(["merge", "t1", "--policy-changed-ok"], { TEST_KIND: "plan" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /merge conflicts: t1's branch does not merge with main, so nothing was merged\. Its acceptance at aaaaaaaa is withdrawn and the plan is building again: a refresh from main at cccccccc is queued for atelier\/integrator/);
  assert.match(result.stderr, /atelier merge t1 --head H/);
  assert.ok(gitCalls().some((args) => args.includes("merge") && args.includes("--abort")), "the interrupted merge is aborted");
  const refresh = calls().filter((c) => c.url.endsWith("/items/t1/plan/refresh"));
  assert.equal(refresh.length, 1);
  assert.deepEqual(JSON.parse(refresh[0].body), {});
  // The plan is building now, so a merge run again stops before Git.
  assert.match(command(["merge", "t1", "--policy-changed-ok"], { TEST_KIND: "plan" }).stderr, /t1 is open; accept the reviewed revision first/);
}));

test("a plan whose merge conflicts stays accepted, saying why, when the server refuses to put it back to building", () => commandFixture(({ command }) => {
  const result = command(["merge", "t1", "--policy-changed-ok"], { TEST_KIND: "plan", TEST_REFRESH_REFUSED: "1" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /t1 stays accepted at aaaaaaaa: putting it back to building was refused: .*a refresh from main at cccccccc is queued/);
  assert.match(result.stderr, /atelier plan refresh t1/);
}));

// Before t149 a file that was not valid JSON (or not an object, or empty)
// made sync warn and stop, and stopped merge and init naming the file.
// ControlPlane files are not read now: none of these commands names them,
// and merge goes on to Git (its policy refresh is disabled until slice 2).
for (const content of ["{", "", "{}", "null"]) {
  test(`policy file ${JSON.stringify(content)} is not read: sync, merge, init and cancel never name it`, () => commandFixture(({ command, dir, calls, gitCalls }) => {
    writeFileSync(join(dir, "docs/control-plane/agent-policy.v1.json"), content);
    const sync = command(["sync"]);
    assert.doesNotMatch(sync.stdout + sync.stderr, /ControlPlane|could not be read/);
    const merge = command(["merge", "t1"]);
    assert.doesNotMatch(merge.stderr, /ControlPlane|could not be read|newly protected/);
    assert.ok(gitCalls().some((args) => args.includes("merge") && args.includes("--no-ff")), "the merge reached Git");
    const init = command(["init", "--approval", "Owner approved"]);
    assert.equal(init.status, 0, init.stderr);
    assert.doesNotMatch(init.stdout + init.stderr, /ControlPlane|SyntaxError/);
    const cancel = command(["merge", "t1", "--cancel"], { TEST_PUT_FAIL: "1" });
    assert.equal(cancel.status, 0, cancel.stderr);
    assert.ok(!calls().some((c) => c.method === "GET" && c.url.endsWith("/api/projects/example")), "no project policy was read");
    const put = JSON.parse(calls().find((c) => c.method === "PUT").body);
    assert.equal(put.agents, undefined);
    assert.equal(put.execution, undefined);
  }));
}

test("init --protect extras stay local and later inits send no ControlPlane path with them", () => commandFixture(({ command, dir, write, calls }) => {
  const init = command(["init", "--protect", "owner/**", "--approval", "Owner approved"]);
  assert.equal(init.status, 0, init.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "config.json"))).projects.example.protect, ["owner/**"]);
  write("execution-policy", { protected_path_patterns: ["new/**"] });
  assert.equal(command(["init", "--protect", "owner/**", "--approval", "Owner approved"]).status, 0);
  const body = JSON.parse(calls().filter((c) => c.method === "PUT").at(-1).body);
  assert.ok(body.protected.includes("owner/**"));
  assert.ok(!body.protected.includes("new/**") && !body.protected.includes("src/**"));
}));

// ── merge's acceptance-policy comparison, against Atelier's own policy ───────
// Slice 1 (t149) deleted the nine merge tests that reached the comparison
// through ControlPlane files. They are back here, with the project's stored
// policy now (`now`) and the snapshot the acceptance recorded (`accepted`) as
// the only inputs. The finding they would have caught: with the refresh gone,
// merge's comparison had no test at all (ctx-t149.md), so a regression could
// have let an accepted revision land on a rule it was never accepted under.
const NEW_PROTECT = { now: { protected: ["AGENTS.md", "src/**"] } };
const calledProject = (calls) => calls.filter((c) => new URL(c.url).pathname === "/api/projects/example");

test("merge compares the stored policy with the acceptance's and refuses before Git merge, writing nothing to the project", () => commandFixture(({ command, calls, gitCalls }) => {
  const result = command(["merge", "t1"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Warning: the project's policy changed since acceptance: protected: /);
  assert.match(result.stderr, /newly protected paths: src\/secret.ts/);
  assert.match(result.stderr, /https:\/\/atelier.test\/p\/example\/t1/);
  assert.deepEqual(calledProject(calls()), [], "the policy is read from the item's detail; nothing is read from or put to the project");
  assert.ok(!gitCalls().some((args) => args.includes("merge")));
  assert.ok(gitCalls().some((args) => args.includes("diff") && args.includes("--no-renames") && args.includes("-z")));
}, NEW_PROTECT));

test("merge override proceeds to Git merge while retaining the warning", () => commandFixture(({ command, gitCalls }) => {
  const result = command(["merge", "t1", "--policy-changed-ok"]);
  assert.match(result.stderr, /Warning: the project's policy changed/);
  assert.doesNotMatch(result.stderr, /newly protected paths/);
  assert.ok(gitCalls().some((args) => args.includes("merge") && args.includes("--no-ff")));
}, NEW_PROTECT));

test("acceptance during merge is read under the stored policy before review and acceptance", () => commandFixture(({ command, calls, gitCalls }) => {
  const result = command(["merge", "t1", "--head", "a".repeat(40), "--approve"], { TEST_SUBMITTED: "1" });
  assert.doesNotMatch(result.stderr, /policy changed since acceptance|newly protected/);
  assert.deepEqual(calls().slice(0, 3).map((c) => [c.method, c.url.split("/").at(-1)]), [["GET", "t1"], ["POST", "review"], ["POST", "accept"]]);
  assert.ok(!calls().some((c) => c.method === "PUT"));
  assert.ok(gitCalls().some((args) => args.includes("merge") && args.includes("--no-ff")));
}, NEW_PROTECT));

for (const first of ["merge", "dirty"]) {
  test(`${first} followed by repeated merges keeps refusing the acceptance`, () => commandFixture(({ command, gitCalls }) => {
    const initial = command(["merge", "t1"], first === "dirty" ? { TEST_DIRTY: "1" } : {});
    assert.equal(initial.status, 1);
    for (let i = 0; i < 2; i++) assert.match(command(["merge", "t1"]).stderr, /newly protected paths: src\/secret.ts/);
    assert.ok(!gitCalls().some((args) => args.includes("merge")));
  }, NEW_PROTECT));
}

test("re-acceptance after refusal records the stored policy, and merge stops refusing", () => commandFixture(({ command, gitCalls }) => {
  assert.match(command(["merge", "t1"]).stderr, /newly protected paths/);
  const accepted = command(["accept", "t1"]);
  assert.equal(accepted.status, 0, accepted.stderr);
  for (let i = 0; i < 2; i++) {
    const result = command(["merge", "t1"]);
    assert.doesNotMatch(result.stderr, /newly protected paths|policy changed since acceptance/);
    assert.match(result.stderr, /merge conflicts/);
  }
  assert.ok(gitCalls().some((args) => args.includes("--no-ff")));
}, NEW_PROTECT));

test("override still reaches Git after repeated refusals", () => commandFixture(({ command }) => {
  for (let i = 0; i < 2; i++) assert.match(command(["merge", "t1"]).stderr, /newly protected paths/);
  for (let i = 0; i < 2; i++) assert.match(command(["merge", "t1", "--policy-changed-ok"]).stderr, /merge conflicts/);
}, NEW_PROTECT));

test("merge honours --policy-changed-ok=true, and --policy-changed-ok=false leaves the refusal", () => commandFixture(({ command, gitCalls }) => {
  const on = command(["merge", "t1", "--policy-changed-ok=true"]);
  assert.match(on.stderr, /Warning: the project's policy changed/);
  assert.doesNotMatch(on.stderr, /newly protected paths/);
  assert.ok(gitCalls().some((args) => args.includes("merge") && args.includes("--no-ff")));
  assert.match(command(["merge", "t1", "--policy-changed-ok=false"]).stderr, /newly protected paths/);
}, NEW_PROTECT));

test("merge diffs the accepted revision from its real fork point, so the baseline's changes since the fork are not charged to it", () => commandFixture(({ command, gitCalls }) => {
  // After atelier update the accepted revision sits on a newer baseline commit.
  // Diffed from the recorded base it would carry every path the baseline
  // changed since, here the newly protected src/secret.ts; from the fork
  // point it carries its own docs/own.md, and the merge goes ahead.
  const forkPoint = "f".repeat(40);
  const result = command(["merge", "t1"], { TEST_FORK_POINT: forkPoint });
  assert.match(result.stderr, /Warning: the project's policy changed/);
  assert.doesNotMatch(result.stderr, /newly protected paths/);
  assert.match(result.stderr, /merge conflicts/);
  assert.ok(gitCalls().some((args) => args[0] === "merge-base" && args.includes("a".repeat(40))));
  assert.ok(gitCalls().some((args) => args.includes("diff") && args.includes(forkPoint) && !args.includes("b".repeat(40))));
}, NEW_PROTECT));

const FULL = { protected: ["AGENTS.md"], eligible: ["claude"], refuseOverlap: false, checks: ["npm test"] };

test("merge refuses when a contributor is no longer eligible under the stored policy", () => commandFixture(({ command, gitCalls }) => {
  // Eligible when accepted: claude. The stored policy now names codex.
  const events = JSON.stringify([{ actor: "claude-code/opus-5.5", kind: "item.claimed", data: {}, at: "2026-10-06T00:00:00.000Z" }]);
  const result = command(["merge", "t1"], { TEST_EVENTS: events, TEST_FORK_POINT: "f".repeat(40) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /its contributors are no longer eligible here: claude-code\/opus-5.5 \(eligible: codex\)\. Review the task again on its page and accept again/);
  assert.ok(!gitCalls().some((args) => args.includes("merge")));
  assert.match(command(["merge", "t1", "--policy-changed-ok"], { TEST_EVENTS: events, TEST_FORK_POINT: "f".repeat(40) }).stderr, /merge conflicts/);
}, { now: { eligible: ["codex"] }, accepted: FULL }));

test("merge refuses when overlapping claims are newly refused and a live item overlaps the task's scope", () => commandFixture(({ command, calls, gitCalls }) => {
  const env = { TEST_FORK_POINT: "f".repeat(40), TEST_SCOPE: JSON.stringify(["src/ui/**"]), TEST_ITEMS: JSON.stringify([
    { id: "t2", state: "claimed", owner: "codex/gpt-6-astra", scope: ["src/**"] },
    { id: "t3", state: "claimed", owner: "codex/gpt-6-astra", scope: ["docs/**"] },
  ]) };
  const result = command(["merge", "t1"], env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /overlapping claims are now refused, and its scope overlaps live t2 \(codex\/gpt-6-astra\)\. Review the task/);
  assert.doesNotMatch(result.stderr, /t3/);
  assert.ok(!gitCalls().some((args) => args.includes("merge")));
  assert.deepEqual(calledProject(calls()).map((c) => c.method), ["GET"], "the live items are read, and only for this change");
  // With no live overlap the change is a warning, and the merge goes ahead.
  const alone = command(["merge", "t1"], { ...env, TEST_ITEMS: JSON.stringify([{ id: "t3", state: "claimed", owner: "codex/gpt-6-astra", scope: ["docs/**"] }]) });
  assert.doesNotMatch(alone.stderr, /overlapping claims are now refused/);
  assert.match(alone.stderr, /merge conflicts/);
}, { now: { refuseOverlap: true }, accepted: FULL }));

test("merge refuses a check required now that was not observed passing at the accepted revision", () => commandFixture(({ command, gitCalls }) => {
  const result = command(["merge", "t1"], { TEST_FORK_POINT: "f".repeat(40) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Warning: the required checks changed since acceptance: checks: /);
  assert.match(result.stderr, /checks required now were not observed passing at the accepted revision: `npm run lint`/);
  assert.ok(!gitCalls().some((args) => args.includes("merge")));
}, { now: { checks: ["npm test", "npm run lint"] }, accepted: FULL }));

// The finding (gpt-6-astra, t150 round 2): the ledger omits shipRuns from an
// acceptance made with no ship order, and filling the missing field from the
// stored policy hid a ship command added since, so a revision that rewrote the
// deploy script landed with no warning and no refusal.
test("merge refuses a revision that touches a ship command added since an acceptance made with none", () => commandFixture(({ command, gitCalls }) => {
  const env = { TEST_FORK_POINT: "f".repeat(40), TEST_DIFF: "bin/deploy.sh\\0000" };
  const result = command(["merge", "t1"], env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Warning: the project's policy changed since acceptance: ship commands: \[\] -> \["bin\/deploy\.sh"\]/);
  assert.match(result.stderr, /newly protected paths: bin\/deploy\.sh/);
  assert.ok(!gitCalls().some((args) => args.includes("merge")));
  assert.match(command(["merge", "t1", "--policy-changed-ok"], env).stderr, /merge conflicts/);
  // A revision that leaves the script alone is not charged with it.
  assert.doesNotMatch(command(["merge", "t1"], { TEST_FORK_POINT: "f".repeat(40) }).stderr, /newly protected/);
}, { now: { shipRuns: ["bin/deploy.sh"] }, accepted: FULL }));
