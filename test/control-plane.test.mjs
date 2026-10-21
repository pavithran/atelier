import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { controlPlaneChanges, mergePolicyDecision, refreshControlPlane } from "../cli/atelier.mjs";
import { acceptancePolicy, mergeContext } from "../src/control-plane.ts";
import { SERVER_CAPABILITIES } from "../src/route-level.ts";

const agents = { codex: { available: true, eligible_roles: ["executor"], preferred_roles: ["planner"] }, claude: { available: false, eligible_roles: ["assessor"] } };
const execution = { allowed_classes: ["direct", "protected"], direct: { enabled: true, allowed_path_patterns: ["docs/**"] }, protected_path_patterns: ["src/security/**"] };

function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-control-plane-"));
  const cp = join(dir, "docs/control-plane");
  mkdirSync(cp, { recursive: true });
  const write = (name, data) => writeFileSync(join(cp, `${name}.v1.json`), JSON.stringify(data));
  return Promise.resolve().then(() => run({ dir, write })).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const before = { protected: ["AGENTS.md"], eligible: ["claude"], refuseOverlap: false, approval: "Owner approved the copy", checks: ["npm test"] };
const IDENTITY = { name: "Project Owner", email: "123+owner@users.noreply.github.com", agentEmails: ["agents@atelier.example"] };

// ControlPlane is retired (t149). Before it, a valid file made this send the
// policy it named, and a malformed one made it answer `skipped` and stop merge
// and sync. Now no file of any kind is read: nothing is requested or printed.
test("refresh reads no ControlPlane file: valid, empty, malformed or absent, it requests and prints nothing", () => {
  const kinds = {
    valid: [["agent-policy", { agents }], ["execution-policy", execution], ["project-adapter", { protected_surfaces: [{ pattern: "secrets/**" }] }]],
    empty: [["agent-policy", {}], ["execution-policy", {}], ["project-adapter", {}]],
    absent: [],
  };
  return Promise.all([...Object.entries(kinds).map(([kind, files]) => fixture(async ({ dir, write }) => {
    for (const [name, data] of files) write(name, data);
    assert.equal(await refreshControlPlane(dir, "example", assert.fail, assert.fail), null, kind);
  })), fixture(async ({ dir }) => {
    writeFileSync(join(dir, "docs/control-plane/agent-policy.v1.json"), "{");
    assert.equal(await refreshControlPlane(dir, "example", assert.fail, assert.fail), null, "malformed");
  })]);
});

test("comparison treats lists as sets and absent optional fields as defaults", () => {
  assert.deepEqual(controlPlaneChanges({ protected: ["b", "a", "a"] }, { protected: ["a", "b"], eligible: [], refuseOverlap: false }), []);
});

test("merge warns and refuses newly protected touched paths unless overridden", () => {
  const after = { ...before, protected: ["AGENTS.md", "src/**"] };
  const decision = mergePolicyDecision(before, after, ["src/secret.ts"]);
  assert.match(decision.warning, /policy changed since acceptance.*protected:/);
  assert.match(decision.refusal, /src\/secret.ts.*Review the task again on its page and accept again/);
  assert.match(decision.refusal, /--policy-changed-ok/);
  const allowed = mergePolicyDecision(before, after, ["src/secret.ts"], true);
  assert.equal(allowed.warning, decision.warning);
  assert.equal(allowed.refusal, null);
  assert.equal(mergePolicyDecision(before, after, ["AGENTS.md"]).refusal, null);
  assert.deepEqual(mergePolicyDecision(before, before, ["AGENTS.md"]), { warning: null, refusal: null });
});

test("a script the ship order runs is newly protected when the order changed since acceptance", () => {
  // The acceptance recorded no ship order; the checkout now deploys through
  // bin/deploy.sh, so an accepted item touching that script is refused as
  // newly protected, exactly as a newly protected ControlPlane path is.
  const after = { ...before, shipRuns: ["bin/deploy.sh"] };
  const decision = mergePolicyDecision(before, after, ["bin/deploy.sh"]);
  assert.match(decision.warning, /ship commands: \[\] -> \["bin\/deploy\.sh"\]/);
  assert.match(decision.refusal, /newly protected paths: bin\/deploy\.sh/);
  assert.equal(mergePolicyDecision(before, after, ["src/a.ts"]).refusal, null);
  assert.equal(mergePolicyDecision(after, after, ["bin/deploy.sh"]).refusal, null, "the order the acceptance was made under refuses nothing new");
});

test("merge matches newly protected paths whatever their letter case or Unicode form", () => {
  const after = { ...before, protected: ["AGENTS.md", "src/**", "CLAUDE.md"] };
  for (const path of ["SRC/secret.ts", "claude.md", "Src/Secret.ts"]) {
    assert.ok(mergePolicyDecision(before, after, [path]).refusal?.includes(`newly protected paths: ${path}.`), path);
  }
  // A variant of a path protected at acceptance is not newly protected.
  assert.equal(mergePolicyDecision(before, after, ["agents.md", "AGENT\u017f.md"]).refusal, null);
});

test("merge warns on eligibility and overlap changes without refusing unrelated paths", () => {
  const result = mergePolicyDecision(before, { ...before, eligible: ["codex"], refuseOverlap: true }, ["src/a.ts"]);
  assert.match(result.warning, /eligible:.*refuseOverlap:/);
  assert.equal(result.refusal, null);
  assert.equal(mergePolicyDecision(before, { ...before, protected: ["AGENTS.md", "package.json"] }, ["package.json"]).refusal, null);
});

test("merge compares eligible agents, the overlap rule and checks with the acceptance, and refuses what the accepted item no longer satisfies", () => {
  const context = { contributors: ["codex/gpt-6-astra"], passed: ["npm test"], overlapping: ["t4 (claude-code/opus-5.5)"] };
  // A contributor eligible at acceptance and not now.
  let d = mergePolicyDecision({ ...before, eligible: ["codex"] }, { ...before, eligible: ["claude"] }, ["src/a.ts"], false, context);
  assert.match(d.warning, /eligible:/);
  assert.match(d.refusal, /its contributors are no longer eligible here: codex\/gpt-6-astra \(eligible: claude\)\. Review the task again on its page and accept again/);
  // An eligibility change that keeps every contributor: the warning alone.
  assert.equal(mergePolicyDecision({ ...before, eligible: [] }, { ...before, eligible: ["codex", "claude"] }, ["src/a.ts"], false, context).refusal, null);
  // A check required now that was not observed passing at the accepted revision.
  const lint = { ...before, checks: ["npm test", "npm run lint"] };
  d = mergePolicyDecision(before, lint, ["src/a.ts"], false, context);
  assert.match(d.warning, /^Warning: the required checks changed since acceptance: checks: \["npm test"\] -> \["npm run lint","npm test"\]$/);
  assert.ok(!d.warning.includes("ControlPlane"), "checks are not ControlPlane's to set, so the warning does not name it");
  assert.match(d.refusal, /checks required now were not observed passing at the accepted revision: `npm run lint`\. Review/);
  assert.equal(mergePolicyDecision(before, lint, ["src/a.ts"], false, { ...context, passed: ["npm test", "npm run lint"] }).refusal, null);
  // Checks are compared only when both sides carry them: the policy read from the files does not.
  assert.deepEqual(controlPlaneChanges(before, { protected: before.protected, eligible: before.eligible, refuseOverlap: false }), []);
  // Overlapping claims newly refused, with a live overlap.
  d = mergePolicyDecision(before, { ...before, refuseOverlap: true }, ["src/a.ts"], false, context);
  assert.match(d.refusal, /overlapping claims are now refused, and its scope overlaps live t4 \(claude-code\/opus-5.5\)\. Review/);
  assert.equal(mergePolicyDecision(before, { ...before, refuseOverlap: true }, ["src/a.ts"], false, { ...context, overlapping: [] }).refusal, null);
  // Every reason at once, and the override.
  const after = { ...lint, protected: ["AGENTS.md", "src/**"], eligible: ["claude"], refuseOverlap: true };
  d = mergePolicyDecision({ ...before, eligible: ["codex"] }, after, ["src/a.ts"], false, context);
  assert.match(d.warning, /^Warning: ControlPlane policy changed since acceptance: .+; the required checks changed since acceptance: checks: /);
  assert.match(d.refusal, /^the accepted revision touches newly protected paths: src\/a.ts; its contributors are no longer eligible here: [^;]+; checks required now [^;]+; overlapping claims are now refused, and its scope overlaps live t4 \(claude-code\/opus-5\.5\)\. Review/);
  assert.equal(mergePolicyDecision({ ...before, eligible: ["codex"] }, after, ["src/a.ts"], true, context).refusal, null);
});

test("the acceptance's policy is its snapshot over the server's policy before the refresh, with the current policy for the rest", () => {
  const current = { ...before, protected: ["AGENTS.md", "src/**"], eligible: ["claude"], refuseOverlap: true, checks: ["npm test", "npm run lint"] };
  const server = { ...before, eligible: ["codex"], checks: ["npm test"] };
  // A full snapshot stands over the server's earlier policy.
  const full = { protected: ["AGENTS.md"], eligible: ["gemini"], refuseOverlap: false, checks: ["npm test"] };
  assert.deepEqual(acceptancePolicy({ policy: current, acceptanceProtected: ["AGENTS.md"], acceptancePolicy: full }, server), { ...current, ...full });
  // An acceptance that recorded protected paths alone: those, and the server's earlier values for the rest.
  assert.deepEqual(acceptancePolicy({ policy: current, acceptanceProtected: ["AGENTS.md"], acceptancePolicy: { protected: ["AGENTS.md"] } }, server),
    { ...current, protected: ["AGENTS.md"], eligible: ["codex"], refuseOverlap: false, checks: ["npm test"] });
  // The oldest acceptances recorded nothing: no protected paths.
  assert.deepEqual(acceptancePolicy({ policy: current, acceptanceProtected: null, acceptancePolicy: null }, server).protected, []);
});

test("the merge context names the item's contributors, the checks observed passing at the accepted revision and the live items its scope overlaps", () => {
  const head = "a".repeat(40), at = "2026-10-06T00:00:00.000Z";
  const detail = {
    item: { id: "t1", scope: ["src/**"], acceptedHead: head },
    policy: { ...before, checks: ["npm test", "npm run lint"] },
    evidence: [
      { itemId: "t1", claim: "npm test", grade: "observed", head, passed: true, by: "codex/gpt-6-astra", at, where: "sandbox" },
      { itemId: "t1", claim: "npm run lint", grade: "observed", head, passed: false, by: "codex/gpt-6-astra", at, where: "sandbox" },
    ],
    events: [
      { actor: "codex/gpt-6-astra", kind: "item.claimed", data: {} },
      { actor: "owner", kind: "item.handoff", data: { from: "codex/gpt-6-astra", to: "claude-code/opus-5.5" } },
    ],
  };
  const items = [
    { id: "t1", state: "accepted", owner: "claude-code/opus-5.5", scope: ["src/**"] },
    { id: "t2", state: "claimed", owner: "zcode/glm-5.3", scope: ["src/ui/**"] },
    { id: "t3", state: "submitted", owner: "zcode/glm-5.3", scope: ["docs/**"] },
    { id: "t4", state: "merged", owner: null, scope: [] },
  ];
  assert.deepEqual(mergeContext(detail, items), { contributors: ["codex/gpt-6-astra", "claude-code/opus-5.5"], passed: ["npm test"], overlapping: ["t2 (zcode/glm-5.3)"] });
  assert.deepEqual(mergeContext(detail).overlapping, []);
});

// A string as one single-quoted word in a /bin/sh script.
const shq = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

function commandFixture(run) {
  return fixture(async ({ dir, write }) => {
    write("agent-policy", { agents: { codex: { available: true } } });
    write("execution-policy", { protected_path_patterns: ["src/**"] });
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
elif has diff "$@"; then if has ${shq(base)} "$@"; then printf 'src/secret.ts\0'; else printf 'docs/own.md\0'; fi
# The commits a landing checks for their identity (t451): none unless the
# test names some, as a printf %b string, since the environment cannot carry a NUL.
elif [ "$1" = log ] && has '--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x1e' "$@"; then printf '%b' "$TEST_IDENTITY_LOG"
elif has merge "$@"; then echo 'merge reached' >&2; exit 1
elif [ "$1" = merge-base ] && [ "$last" != HEAD ]; then exit 1
fi
`, { mode: 0o755 });
    const storage = join(dir, "server.json");
    writeFileSync(storage, JSON.stringify({ policy: { ...before, commitIdentity: IDENTITY }, state: "accepted", acceptanceProtected: before.protected }));
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
// it then reads no ControlPlane file and sends no policy: it names atelier
// init, which pushes new commits to a whole-history baseline.
test("sync checks the baseline, then names atelier init for a full-history project and sends no policy", () => commandFixture(({ command, calls, gitCalls }) => {
  const result = command(["sync"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /example's baseline holds its whole history; atelier init pushes new commits to it/);
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
