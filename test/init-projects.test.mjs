import { projectKey } from "../cli/private-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { SERVER_CAPABILITIES } from "../src/route-level.ts";

const cli = resolve("cli/atelier.mjs");

function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-init-test-"));
  const config = join(dir, "config.json"), log = join(dir, "calls.jsonl");
  const initial = { server: "https://atelier.test", owner: "owner", projects: { weblog: { path: dir, branch: "main", notesRemote: "origin" } } };
  writeFileSync(config, JSON.stringify(initial));
  writeFileSync(log, "");
  // A /bin/sh script, not a node one: each node start cost about 80 ms of
  // every git call a command makes (t771).
  writeFileSync(join(dir, "git"), `#!/bin/sh
has() { needle=$1; shift; for arg in "$@"; do [ "$arg" = "$needle" ] && return 0; done; return 1; }
if has --show-toplevel "$@"; then pwd
elif has --abbrev-ref "$@"; then echo main
elif has symbolic-ref "$@"; then echo refs/heads/main
elif has --is-shallow-repository "$@"; then echo false
elif has rev-parse "$@"; then echo ${"a".repeat(40)}
elif has config "$@"; then exit 1
elif ! has push "$@"; then exit 2
fi
`, { mode: 0o755 });
  const preload = join(dir, "fetch.mjs");
  writeFileSync(preload, `import { appendFileSync } from 'node:fs';
let policy = { checks: [], protected: ['manual/**'] };
globalThis.fetch = async (url, options) => {
  // The capability check before init (t458) reads the version; it is not a call the tests read.
  if (new URL(url).pathname === '/api/version') return Response.json({ capabilities: ${JSON.stringify(SERVER_CAPABILITIES)} });
  appendFileSync(process.env.TEST_CALLS, JSON.stringify({ url, ...options }) + '\\n');
  if (process.env.TEST_REFUSE) return Response.json({ error: 'live_work', detail: 'live work' }, { status: 409 });
  const renamed = /\\/projects\\/([^/]+)\\/rename$/.exec(url);
  if (renamed) {
    const from = decodeURIComponent(renamed[1]), { to, releaseName } = JSON.parse(options.body);
    // A server from before t774 ignores releaseName.
    const released = releaseName && !process.env.TEST_OLD_SERVER ? { released: from, rescoped: 2 } : {};
    return Response.json({ from, to, key: from, names: releaseName && !process.env.TEST_OLD_SERVER ? [to] : [from, to], ...released, project: { name: to, repo: from, policy: { checks: [], protected: [] } } });
  }
  if (options.method === 'PUT') policy = { ...policy, ...JSON.parse(options.body) };
  return Response.json(options.method === 'DELETE' ? { removed: true } : {
    project: { repo: 'weblog', policy: { ...policy, ...(process.env.TEST_APPROVED ? { approval: process.env.TEST_APPROVED } : {}) } },
    item: { state: 'open', owner: null, dispatch: null },
    remote: 'https://git.test/weblog', token: 'test-token',
    baseline: { remote: 'https://git.test/weblog', token: 'test-token' }
  });
};
`);
  const command = (args, extra = {}) => spawnSync(process.execPath, ["--import", preload, cli, ...args], {
    cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ATELIER_CONFIG_DIR: dir, ATELIER_TOKEN: "test-token", ATELIER_SERVER: initial.server, ATELIER_ACTOR: "owner", TEST_CALLS: log, ...extra },
  });
  try {
    run({ command, initial, config: () => JSON.parse(readFileSync(config, "utf8")), calls: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("CLI init sends a title update under the registered name", () => fixture(({ command, config, calls }) => {
  const result = command(["init", "--title", "Ikon weblog"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls()[0].url, "https://atelier.test/api/projects/weblog");
  assert.equal(JSON.parse(calls()[0].body).title, "Ikon weblog");
  assert.deepEqual(Object.keys(config().projects), ["weblog"]);
}));

test("CLI init records the ship order's commands and approval kinds with the policy", () => fixture(({ command, initial, calls }) => {
  mkdirSync(join(initial.projects.weblog.path, "docs", "atelier"), { recursive: true });
  writeFileSync(join(initial.projects.weblog.path, "docs", "atelier", "ship.json"), JSON.stringify({
    schema_version: 1, kind: "atelier.ship", class: "web",
    deploy: { run: ["bin/deploy.sh"] },
    "verify-deploy": { request: "https://demo.test", status: 200 },
  }));
  const result = command(["init"]);
  assert.equal(result.status, 0, result.stderr);
  const put = JSON.parse(calls().find((c) => c.method === "PUT").body);
  assert.deepEqual(put.shipRuns, ["bin/deploy.sh"], "the command the deploy step runs, and not the URL the verify step requests");
  assert.deepEqual(put.shipKinds, ["deploy"], "push needs an approval only with --push, so it is not a kind the order needs");
}));

test("CLI init lists check input files among the protected paths", () => fixture(({ command }) => {
  const result = command(["init", "--protect", "src/rules.ts", "--check", "npm test"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Protected:.*package\.json/m);
  assert.match(result.stdout, /^Protected:.*src\/rules\.ts/m);
}));

test("CLI init sends the core files given with --core, clears them with --core \"\" or --reset, and keeps them otherwise", () => fixture(({ command, calls }) => {
  const put = () => JSON.parse(calls().filter((c) => c.method === "PUT").at(-1).body);
  const given = command(["init", "--core", "src/ledger.ts", "--core", " cli/runner.mjs "]);
  assert.equal(given.status, 0, given.stderr);
  assert.deepEqual(put().coreFiles, ["src/ledger.ts", "cli/runner.mjs"]);
  assert.equal(command(["init", "--title", "T"]).status, 0);
  assert.equal("coreFiles" in put(), false, "a re-init without --core keeps the recorded core files");
  assert.equal(command(["init", "--core", ""]).status, 0);
  assert.deepEqual(put().coreFiles, []);
  assert.equal(command(["init", "--reset"]).status, 0);
  assert.deepEqual(put().coreFiles, []);
  const bare = command(["init", "--core"]);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /--core needs a glob: atelier init --core "GLOB", once per entry, or --core "" alone to clear them/);
  const blank = command(["init", "--core", "src/**", "--core", " "]);
  assert.equal(blank.status, 1);
  assert.match(blank.stderr, /--core needs a glob/);
}));

// t756: init had no flag for the riskReviews t631 added to the route, so a
// developer could not turn review by risk on from the CLI.
test("CLI init sends --risk-reviews JSON, sends null for off, keeps them otherwise and refuses a bad value before any request", () => fixture(({ command, calls }) => {
  const put = () => JSON.parse(calls().filter((c) => c.method === "PUT").at(-1).body);
  const risk = { core: ["src/rules.ts"], reviews: { "docs-or-tests": 0, other: 1, core: 2 } };
  const given = command(["init", "--risk-reviews", JSON.stringify({ ...risk, core: [" src/rules.ts "] })]);
  assert.equal(given.status, 0, given.stderr);
  assert.deepEqual(put().riskReviews, risk);
  assert.match(given.stdout, /^Risk reviews: 0 for docs or tests, 1 for other changes, 2 for core/m);
  assert.equal(command(["init", "--title", "T"]).status, 0);
  assert.equal("riskReviews" in put(), false, "a re-init without the flag keeps the recorded reviews");
  assert.equal(command(["init", "--risk-reviews", "off"]).status, 0);
  assert.equal(put().riskReviews, null);
  const before = calls().length;
  for (const bad of ["{not json", JSON.stringify({ core: [], reviews: { "docs-or-tests": 0, other: 1, core: 9 } }), "[]"]) {
    const r = command(["init", "--risk-reviews", bad]);
    assert.equal(r.status, 1, bad);
    assert.match(r.stderr, /--risk-reviews/);
    assert.match(r.stderr, /Nothing was sent/);
  }
  assert.match(command(["init", "--risk-reviews", "{not json"]).stderr, /not valid JSON/);
  assert.match(command(["init", "--risk-reviews", "[]"]).stderr, /core must be a list of globs/);
  const bare = command(["init", "--risk-reviews"]);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /--risk-reviews needs JSON or off/);
  assert.equal(calls().length, before, "no request went out for a refused value");
}));

test("CLI dispatch sends the owner's overlap override only with --overlap-ok", () => fixture(({ command, calls }) => {
  const posts = () => calls().filter((c) => c.method === "POST" && c.url.endsWith("/dispatch")).map((c) => JSON.parse(c.body));
  command(["dispatch", "t3", "--project", "weblog"]);
  command(["dispatch", "t3", "--overlap-ok", "--project", "weblog"]);
  assert.deepEqual(posts().map((b) => b.overlapOk), [undefined, true]);
}));

test("CLI rename refuses a different name unless it changes only local config", () => fixture(({ command, initial, config, calls }) => {
  const refused = command(["init", "--name", "ikon"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /registered as weblog/);
  assert.deepEqual(config(), initial);
  const renamed = command(["init", "--name", "ikon", "--rename-local"]);
  assert.equal(renamed.status, 0, renamed.stderr);
  // The old name stays with the entry, for workspaces made before (t645).
  assert.deepEqual(config().projects, { ikon: { ...initial.projects.weblog, formerNames: ["weblog"] } });
  assert.deepEqual(calls(), []);
}));

test("CLI rename asks the server, then moves the local config entry to the new name", () => fixture(({ command, initial, config, calls }) => {
  const renamed = command(["projects", "rename", "weblog", "ikon"]);
  assert.equal(renamed.status, 0, renamed.stderr);
  assert.equal(calls().length, 1);
  assert.equal(calls()[0].url, "https://atelier.test/api/projects/weblog/rename");
  assert.equal(calls()[0].method, "POST");
  assert.deepEqual(JSON.parse(calls()[0].body), { to: "ikon" });
  // The old name stays with the entry, for workspaces made before (t645).
  assert.deepEqual(config().projects, { ikon: { ...initial.projects.weblog, formerNames: ["weblog"] } });
  assert.match(renamed.stdout, /weblog is now ikon on https:\/\/atelier\.test\. Its Ledger, baseline weblog and every fork stay where they are\. The local config entry weblog is now ikon\./);
  assert.match(renamed.stdout, /weblog still works/);
}));

// Task t774: the old atelier project gives up its name for the rewritten one.
test("CLI rename --release-name asks the server to release the name, and says what that did", () => fixture(({ command, initial, config, calls }) => {
  const renamed = command(["projects", "rename", "weblog", "ikon", "--release-name"]);
  assert.equal(renamed.status, 0, renamed.stderr);
  assert.deepEqual(JSON.parse(calls()[0].body), { to: "ikon", releaseName: true });
  assert.deepEqual(config().projects, { ikon: { ...initial.projects.weblog, formerNames: ["weblog"] } });
  assert.match(renamed.stdout, /weblog is now ikon on https:\/\/atelier\.test\./);
  assert.match(renamed.stdout, /weblog is released: it no longer reaches ikon, and a project created under it is stored apart.*Tokens limited to weblog are limited to ikon now \(2 changed\)/);
  assert.doesNotMatch(renamed.stdout, /weblog still works/);
}));

test("CLI rename --release-name against a server that ignores it says the name is not released and exits 1", () => fixture(({ command, calls }) => {
  const renamed = command(["projects", "rename", "weblog", "ikon", "--release-name"], { TEST_OLD_SERVER: "1" });
  assert.equal(renamed.status, 1);
  assert.deepEqual(JSON.parse(calls()[0].body), { to: "ikon", releaseName: true });
  assert.match(renamed.stderr, /weblog was renamed, but this server did not release the name \(it predates --release-name\), so weblog still reaches the project/);
  assert.doesNotMatch(renamed.stdout, /is released/);
}));

test("CLI rename leaves local config alone when the server refuses, or when no entry has the old name", () => fixture(({ command, initial, config, calls }) => {
  const refused = command(["projects", "rename", "weblog", "ikon"], { TEST_REFUSE: "1" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /live_work/);
  assert.deepEqual(config(), initial);
  const elsewhere = command(["projects", "rename", "elsewhere", "other"]);
  assert.equal(elsewhere.status, 0, elsewhere.stderr);
  assert.deepEqual(config(), initial);
  assert.match(elsewhere.stdout, /No local config entry was called elsewhere\./);
  assert.equal(calls().length, 2);
}));

test("CLI rename keeps an entry already under the new name and says what the dropped one held", () => fixture(({ command, initial, config }) => {
  const prepared = command(["init", "--name", "ikon", "--rename-local"]);
  assert.equal(prepared.status, 0, prepared.stderr);
  const both = { ...config(), projects: { ikon: config().projects.ikon, weblog: { path: "/elsewhere", branch: "old", notesRemote: "origin" } } };
  writeFileSync(join(initial.projects.weblog.path, "config.json"), JSON.stringify(both));
  const renamed = command(["projects", "rename", "weblog", "ikon"]);
  assert.equal(renamed.status, 0, renamed.stderr);
  assert.deepEqual(config().projects, { ikon: { ...initial.projects.weblog, formerNames: ["weblog"] } });
  assert.match(renamed.stdout, /already had an entry ikon, which is kept; the entry weblog was dropped \(it held: path \/elsewhere, branch old, notesRemote origin\)/);
}));

// Task t108: a rename the server finishes while answering with the new
// name as both names (a retry that named the new name) dropped the local
// entry under that name.
test("CLI rename leaves the local config alone when the server answers the same name for both", () => fixture(({ command, initial, config }) => {
  const prepared = command(["init", "--name", "ikon", "--rename-local"]);
  assert.equal(prepared.status, 0, prepared.stderr);
  const finished = command(["projects", "rename", "ikon", "ikon"]);
  assert.equal(finished.status, 0, finished.stderr);
  assert.deepEqual(config().projects, { ikon: { ...initial.projects.weblog, formerNames: ["weblog"] } });
  assert.equal(finished.stdout, "ikon is the project's name on https://atelier.test, and the rename that gave it that name is complete. The local config is unchanged.\n");
}));

test("CLI rename needs both names and contacts no server without them", () => fixture(({ command, initial, config, calls }) => {
  for (const argv of [["projects", "rename"], ["projects", "rename", "weblog"], ["projects", "rename", "weblog", "ikon", "extra"]]) {
    const r = command(argv);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /usage: atelier projects rename OLD NEW\n       atelier projects remove NAME \[--force\]/);
  }
  assert.deepEqual(config(), initial);
  assert.deepEqual(calls(), []);
}));

test("CLI removal keeps local config on refusal and removes it on success", () => fixture(({ command, initial, config, calls }) => {
  assert.equal(command(["projects", "remove", "weblog"], { TEST_REFUSE: "1" }).status, 1);
  assert.deepEqual(config(), initial);
  const removed = command(["projects", "remove", "weblog", "--force"]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(config().projects, {});
  assert.equal(calls()[1].method, "DELETE");
  assert.deepEqual(JSON.parse(calls()[1].body), { force: true });
  assert.match(removed.stdout, /Artifacts repository and project Ledger data are retained/);
}));

test("CLI removal says which local settings were dropped, including notesRemote", () => fixture(({ command, initial }) => {
  const removed = command(["projects", "remove", "weblog", "--force"]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /Local settings dropped: path .+, branch main, notesRemote origin\./);
  assert.ok(removed.stdout.includes(`path ${initial.projects.weblog.path}`));
}));

test("CLI removal of a project with no local entry names no dropped settings", () => fixture(({ command }) => {
  const removed = command(["projects", "remove", "elsewhere"]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.doesNotMatch(removed.stdout, /Local settings dropped/);
}));

test("CLI init sends ControlPlane role and class policy", () => fixture(({ command, initial, calls }) => {
  const dir = join(initial.projects.weblog.path, "docs/control-plane");
  mkdirSync(dir, { recursive: true });
  const agents = { codex: { available: true, eligible_roles: ["executor"], preferred_roles: ["planner"] } };
  const execution = { allowed_classes: ["coordinated", "protected"], direct: { enabled: false, allowed_path_patterns: [] }, protected_path_patterns: ["security/**"] };
  writeFileSync(join(dir, "agent-policy.v1.json"), JSON.stringify({ agents }));
  writeFileSync(join(dir, "execution-policy.v1.json"), JSON.stringify(execution));
  const result = command(["init", "--approval", "Owner approved this fixture"]);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(calls()[0].body);
  assert.deepEqual(body.agents, agents);
  assert.deepEqual(body.execution, execution);
}));

test("CLI init keeps the approval recorded on a ControlPlane project unless the baseline is replaced", () => fixture(({ command, initial, calls }) => {
  const dir = join(initial.projects.weblog.path, "docs/control-plane");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent-policy.v1.json"), JSON.stringify({ agents: { codex: { available: true, eligible_roles: ["executor"] } } }));
  const approval = "PAVI, 2026-10-01: approved the copy";
  // Nothing recorded yet: the approval is asked for, after one read and no write.
  const asked = command(["init", "--title", "Weblog"]);
  assert.equal(asked.status, 1, asked.stdout);
  assert.match(asked.stderr, /Record the developer's approval/);
  assert.deepEqual(calls().map((c) => c.method), ["GET"]);
  // Recorded: a change to the title or the checks keeps it and sends none.
  const kept = command(["init", "--title", "Weblog", "--check", "npm test"], { TEST_APPROVED: approval });
  assert.equal(kept.status, 0, kept.stderr);
  const put = calls().filter((c) => c.method === "PUT").at(-1);
  assert.equal(JSON.parse(put.body).approval, undefined);
  assert.deepEqual(JSON.parse(put.body).checks, ["npm test"]);
  assert.ok(kept.stdout.includes(`Approval:   ${approval}`), kept.stdout);
  // Given, it is sent as before, with no read first.
  const given = command(["init", "--approval", "PAVI, 2026-10-02: approved again"], { TEST_APPROVED: approval });
  assert.equal(given.status, 0, given.stderr);
  assert.deepEqual(calls().slice(-1).map((c) => [c.method, JSON.parse(c.body).approval]), [["PUT", "PAVI, 2026-10-02: approved again"]]);
  // --reset drops the recorded policy and --history-since replaces the baseline: asked again, and told why.
  for (const [flag, why] of [[["--reset"], /--reset starts the policy over/], [["--history-since", "2026-01-01"], /--history-since replaces the baseline/]]) {
    const again = command(["init", ...flag], { TEST_APPROVED: approval });
    assert.equal(again.status, 1, again.stdout);
    assert.match(again.stderr, why);
    assert.match(again.stderr, /Record the developer's approval/);
  }
  assert.equal(calls().filter((c) => c.method === "PUT").length, 2);
}));

test("CLI sync refreshes ControlPlane policy even when the baseline already matches", () => fixture(({ command, initial, calls }) => {
  const top = initial.projects.weblog.path;
  initial.projects.weblog.fresh = true;
  // Paths the owner added with init --protect are kept from the local registration.
  initial.projects.weblog.protect = ["manual/**"];
  writeFileSync(join(top, "config.json"), JSON.stringify(initial));
  const gitDir = join(top, "fake-git"), dir = join(top, "docs/control-plane");
  mkdirSync(gitDir);
  mkdirSync(dir, { recursive: true });
  const head = "a".repeat(40);
  writeFileSync(join(gitDir, "atelier-baseline-map.json"), JSON.stringify({ weblog: { [head]: head } }));
  writeFileSync(join(top, "git"), `#!/bin/sh
has() { needle=$1; shift; for arg in "$@"; do [ "$arg" = "$needle" ] && return 0; done; return 1; }
if has --show-toplevel "$@"; then pwd
elif has --absolute-git-dir "$@"; then echo "$(pwd)/fake-git"
elif has --abbrev-ref "$@"; then echo main
elif has symbolic-ref "$@"; then echo refs/heads/main
elif has --is-shallow-repository "$@"; then echo false
elif has rev-parse "$@"; then echo ${"a".repeat(40)}
elif has config "$@"; then exit 1
elif ! has status "$@" && ! has fetch "$@"; then exit 2
fi
`, { mode: 0o755 });
  const agents = { codex: { available: true, eligible_roles: ["executor"] } };
  const execution = { allowed_classes: ["protected"], direct: { enabled: false, allowed_path_patterns: [] }, protected_path_patterns: ["security/**"] };
  writeFileSync(join(dir, "agent-policy.v1.json"), JSON.stringify({ agents }));
  writeFileSync(join(dir, "execution-policy.v1.json"), JSON.stringify(execution));
  const result = command(["sync"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /baseline already matches/);
  const body = JSON.parse(calls().find((c) => c.method === "PUT").body);
  assert.deepEqual(body.agents, agents);
  assert.deepEqual(body.execution, execution);
  assert.ok(body.protected.includes("manual/**"));
  assert.ok(body.protected.includes("security/**"));
}));

// Astra's seventh review of t645: init --rename-local moved the entry
// without its old name, and projects rename into an existing entry dropped
// the source's private settings. Both go through moveProjectEntry.
test("init --rename-local keeps the old name, so a workspace still named it stays guarded", () => fixture(({ command, config }) => {
  const renamed = command(["init", "--name", "ikon", "--rename-local"]);
  assert.equal(renamed.status, 0, renamed.stderr);
  const projects = config().projects;
  assert.equal(projectKey(projects, "weblog"), "ikon");
}));

test("projects rename into an existing entry keeps every private setting of both", () => fixture(({ command, initial, config, calls }) => {
  const prepared = command(["init", "--name", "ikon", "--rename-local"]);
  assert.equal(prepared.status, 0, prepared.stderr);
  const file = join(initial.projects.weblog.path, "config.json");
  const both = { ...config(), projects: {
    ikon: { ...config().projects.ikon, private: ["a.md"], privateFromList: ["b.md"] },
    weblog: { path: "/elsewhere", branch: "old", private: ["PROJECT.md"], privateFromList: ["notes.md"], privateHome: "/keep/weblog", formerNames: ["older"] },
  } };
  writeFileSync(file, JSON.stringify(both));
  const renamed = command(["projects", "rename", "weblog", "ikon"]);
  assert.equal(renamed.status, 0, renamed.stderr);
  const ikon = config().projects.ikon;
  assert.equal(config().projects.weblog, undefined);
  assert.deepEqual(ikon.private, ["a.md", "PROJECT.md"]);
  assert.deepEqual(ikon.privateFromList, ["b.md", "notes.md"]);
  assert.equal(ikon.privateHome, "/keep/weblog");
  assert.deepEqual(ikon.formerNames.sort(), ["older", "weblog"]);
  // Two different folders are not guessed between: refused, nothing changed.
  const clash = { ...config(), projects: { ikon: { ...ikon, privateHome: "/keep/ikon" }, weblog: { path: "/elsewhere", branch: "old", privateHome: "/keep/weblog" } } };
  writeFileSync(file, JSON.stringify(clash));
  const asked = calls().length;
  const refused = command(["projects", "rename", "weblog", "ikon"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /weblog was not renamed: .*name different folders for their private files \(\/keep\/weblog and \/keep\/ikon\); nothing was renamed and nothing in the local config was changed/);
  assert.deepEqual(config(), clash);
  // Checked before the server was asked (Astra's eighth review of t645).
  assert.equal(calls().length, asked, "nothing was renamed on the server");
}));
