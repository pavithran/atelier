import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { ceilingRefusal, fillTemplate, insertSection, isLink, leftovers, linkedPart, pasteScript, section, TEMPLATE } from "../cli/adopt.mjs";

const cli = resolve("cli/atelier.mjs");
const template = readFileSync(TEMPLATE, "utf8");
const actor = "zcode/glm-5.3";

// Everything under a directory, with content hashes and link targets, so a
// test can prove nothing there changed — and that nothing was written through
// a symlink into it.
function tree(root) {
  const out = [];
  const walk = (at, prefix) => {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name === ".git") continue;
      const path = join(at, entry.name), name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) out.push(`${name} -> ${readlinkSync(path)}`);
      else if (stat.isDirectory()) walk(path, name);
      else out.push(`${name} ${stat.mode.toString(8)} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
    }
  };
  walk(root, "");
  return out;
}

// ── the entry point that replaces bin/control-plane ────────────────────────

// The commands the real atelier understands. The stub fails for anything else,
// the way the real one does, so a mapping that names a command the real
// atelier has not got cannot pass a test.
const COMMANDS = ["unwrap", "wrap", "login", "init", "sync", "publish", "notes-remote", "new", "ls", "show", "owners", "inbox", "status", "open",
  "start", "claim", "finish", "push", "update", "check", "report", "submit", "handoff", "release", "diff", "review",
  "accept", "merge", "abandon", "done", "models", "dispatch", "undispatch", "queue", "projects", "adopt", "gc", "runner", "ops", "guide", "help"];

function entryPoint(t, project = "weblog", script = template) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-entry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const entry = join(dir, "control-plane"), argvFile = join(dir, "argv"), atelier = join(dir, "atelier");
  writeFileSync(entry, fillTemplate(script, project), { mode: 0o755 });
  // A stub `atelier` on PATH records the arguments it was given, and, like the
  // real one, fails for a command it has not got.
  writeFileSync(atelier, `#!/bin/sh
printf '%s\\n' "$@" > "${argvFile}"
case "$1" in
  ${COMMANDS.join("|")}) exit 0 ;;
  *) echo "atelier: unknown command \\"$1\\"; try atelier help" >&2; exit 1 ;;
esac
`, { mode: 0o755 });
  const run = (...argv) => {
    const r = spawnSync(entry, argv, { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    const recorded = existsSync(argvFile) ? readFileSync(argvFile, "utf8").split("\n").filter(Boolean) : null;
    rmSync(argvFile, { force: true });
    return { ...r, argv: recorded };
  };
  run.atelier = atelier;
  return run;
}

test("the entry point runs the Atelier command each ControlPlane command became", (t) => {
  const run = entryPoint(t);
  const ops = ["audit", "context-budget", "ship-check", "observe", "observatory-bundle", "observatory-run", "backup-status", "validate-backup"];
  const cases = [
    [["pickup-card"], ["unwrap", "--project", "weblog"]],
    [["wrap"], ["wrap", "--project", "weblog"]],
    [["session-receipt", "the day's work"], ["wrap", "the day's work", "--project", "weblog"]],
    [["report", "the build is green"], ["new", "the build is green", "--project", "weblog"]],
    ...ops.map((c) => [[c, "--json"], ["ops", c, "--json"]]),
  ];
  for (const [argv, expected] of cases) {
    const r = run(...argv);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.argv, expected, argv.join(" "));
    // One line to stderr naming the Atelier command, then that command.
    assert.equal(r.stderr.trim().split("\n").length, 1, r.stderr);
    assert.match(r.stderr, new RegExp(`atelier ${expected.join(" ")}`));
  }
});

test("a mapping to a command the real atelier has not got fails loudly", (t) => {
  const broken = template.replace("run unwrap --project", "run statuss --project");
  assert.notEqual(broken, template, "the mapping was renamed");
  const run = entryPoint(t, "weblog", broken);
  const r = run("pickup-card");
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /unknown command "statuss"/);

  // The stub itself is strict, like the real command it stands in for.
  const known = spawnSync(run.atelier, ["status"], { encoding: "utf8" });
  assert.equal(known.status, 0, known.stderr);
  const unknown = spawnSync(run.atelier, ["frobnicate"], { encoding: "utf8" });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown command "frobnicate"/);
});

test("help, and no command, list the mappings without running atelier", (t) => {
  const run = entryPoint(t);
  for (const argv of [["help"], []]) {
    const r = run(...argv);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.argv, null, "help must not run atelier");
    for (const text of ["works through Atelier", "pickup-card", "atelier unwrap --project weblog",
      "session-receipt", "atelier wrap", "report TEXT", "atelier new TEXT --project weblog", "audit", "atelier ops"]) {
      assert.ok(r.stdout.includes(text), text);
    }
  }
});

test("any other command says the project moved into Atelier and exits 2", (t) => {
  const run = entryPoint(t);
  const r = run("frobnicate");
  assert.equal(r.status, 2, r.stdout);
  assert.equal(r.argv, null);
  assert.match(r.stderr, /frobnicate moved into Atelier/);
  assert.match(r.stderr, /atelier help/);
  assert.match(r.stderr, /atelier ops help/);
});

// The paste stub answers as the relay rule does: no command renders a paste,
// the agent writes the envelope, and a handoff is no relay. Pinned word for
// word, with its exit status, so the text cannot drift from the rule.
test("the paste stub says no command renders a paste, that a handoff is no relay, and exits 2", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-paste-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stub = join(dir, "control-plane-paste");
  writeFileSync(stub, pasteScript("weblog"), { mode: 0o755 });
  assert.ok(pasteScript("weblog").startsWith("#!/bin/sh\n"));
  for (const argv of [[], ["t1"], ["--to", "codex/gpt-6-astra"]]) {
    const r = spawnSync(stub, argv, { encoding: "utf8" });
    assert.equal(r.status, 2, argv.join(" "));
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, `control-plane-paste: no command renders a paste any more; this project works through Atelier.
Write the relay envelope yourself, as the relay rule in AGENTS.md says: one complete fenced
block with a language tag (bash for a command the owner runs, text for prose, a brief or an
envelope), and save a copy under ~/Documents/ai-project-data/weblog/, never the portfolio root.
\`atelier handoff\` transfers ownership of a task to another agent. It is not a relay and is
never part of a paste request.
`);
  }
  // The name goes into a quoted heredoc, so shell syntax in it is text.
  const odd = join(dir, "odd");
  writeFileSync(odd, pasteScript("a$&b `c` 'd'"), { mode: 0o755 });
  assert.match(spawnSync(odd, [], { encoding: "utf8" }).stderr, /ai-project-data\/a\$&b `c` 'd'\//);
});

test("the project name is filled in as one shell word", () => {
  assert.ok(fillTemplate(template, "weblog").includes("atelier_project='weblog'"));
  assert.ok(!fillTemplate(template, "weblog").includes("__ATELIER_PROJECT__"));
  assert.ok(fillTemplate(template, "it's").includes(`atelier_project='it'\\''s'`));
  assert.throws(() => fillTemplate("nothing to fill", "weblog"), /no project name to fill in/);
  assert.throws(() => fillTemplate(template, "two\nlines"), /cannot be written into a shell script/);

  // A replacement string would read `$$`, `$&` and `` $` `` in the name as
  // replacement syntax; a callback writes the name as it is.
  const line = (name) => fillTemplate(template, name).split("\n").find((l) => l.startsWith("atelier_project="));
  assert.equal(line("we$blog"), "atelier_project='we$blog'");
  assert.equal(line("$&"), "atelier_project='$&'");
  assert.equal(line("a$$b"), "atelier_project='a$$b'");
  assert.equal(line("$`quoted`'"), "atelier_project='$`quoted`'\\'''");
});

test("a name full of shell and replacement syntax arrives as one argument", (t) => {
  const run = entryPoint(t, "a$&b `c` 'd'");
  const r = run("pickup-card");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.argv, ["unwrap", "--project", "a$&b `c` 'd'"]);
});

// ── the Atelier section in AGENTS.md ───────────────────────────────────────

test("the section replaces an existing one, and a file with no heading gets it at the top", () => {
  const text = section("## Working through Atelier\n\n1. Claim the task.\n");
  assert.ok(text.startsWith("## This project works through Atelier\n"));
  const adopt = (markdown) => insertSection(markdown, text);

  const agents = "# weblog\n\nRun bin/control-plane pickup-card.\n\n## Notes\n\nKeep the changelog current.\n";
  const once = adopt(agents);
  assert.ok(once.startsWith("# weblog\n\n## This project works through Atelier\n"), once.slice(0, 80));
  assert.ok(once.endsWith("\n\n## Notes\n\nKeep the changelog current.\n"));
  // Adopting again over its own output changes nothing, and never stacks a
  // second section.
  assert.equal(once.split("## This project works through Atelier").length - 1, 1);
  assert.equal(adopt(once), once);
  // A section an older guide wrote is replaced where it stands.
  const older = insertSection(agents, section("## Working through Atelier\n\n1. An older step.\n"));
  const newer = adopt(older);
  assert.ok(!newer.includes("An older step."));
  assert.equal(newer.split("## This project works through Atelier").length - 1, 1);
  assert.ok(newer.endsWith("\n\n## Notes\n\nKeep the changelog current.\n"));

  // No heading at all: the section goes at the top, and nothing is lost.
  const flat = "Note to agents: finish with bin/control-plane audit record.\n\nSecond paragraph.\n";
  const topped = adopt(flat);
  assert.ok(topped.startsWith("## This project works through Atelier\n"));
  assert.ok(topped.endsWith(flat));
  assert.equal(adopt(topped), topped);
});

// ── a project with ControlPlane habits ─────────────────────────────────────

const AGENTS = `# weblog

Run bin/control-plane pickup-card to pick up your card, then finish with
bin/control-plane audit record.

## Notes

Keep the changelog current.
`;

// The checkout as ControlPlane leaves it: a launcher, a paste helper, a work
// item still active, an adapter naming tools the project no longer has, a
// vendored tools directory, and agent files that still name the old commands.
function checkout(t, { paste = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "atelier-adopt-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "weblog");
  const write = (path, text, mode = 0o644) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text, { mode });
  };
  write("AGENTS.md", AGENTS);
  write("CLAUDE.md", "# weblog\n\nUse bin/control-plane-paste when you take over a session.\n");
  write("GLM.md", "# weblog\n\nClose the day with a session-receipt.\n");
  write("bin/control-plane", "#!/usr/bin/env python3\n# ControlPlane's launcher, kept elsewhere.\n", 0o755);
  if (paste) write("bin/control-plane-paste", "#!/bin/sh\n# ControlPlane's paste.\n", 0o755);
  write("docs/control-plane/work-item.v1.json", JSON.stringify({
    schema_version: 1, kind: "control-plane.work-item", plan_id: "plan-2026-09", state: "active", owner: "pavi",
  }, null, 2) + "\n");
  write("docs/control-plane/project-adapter.v1.json", JSON.stringify({
    schema_version: 1,
    capabilities: [
      { name: "pickup-card", command: "bin/control-plane pickup-card" },
      { name: "paste", command: ["tools/control-plane/paste.py"] },
      { name: "status", command: "git status" },
      // A dead command through an interpreter, with a variable set for it,
      // and one through bash with an option.
      { name: "ship", command: "python3 tools/ship.py" },
      { name: "report-card", command: "node x.mjs" },
      { name: "sweep", command: ["bash", "-e", "bin/sweep.sh"] },
      { name: "handoff", command: "CONTROL_PLANE_HOME=/tmp tools/handoff.py" },
      // A path with a space, quoted: one word, and it is there.
      { name: "tidy", command: '"tools/has space.sh"' },
    ],
  }, null, 2) + "\n");
  write("tools/control-plane/pickup.py", "# ControlPlane's own copy of its tools.\n");
  write("tools/has space.sh", "# A capability whose path has a space, and is there.\n");
  return { root, dir };
}

test("the leftovers are what ControlPlane still holds in the checkout", (t) => {
  const { dir } = checkout(t);
  assert.deepEqual(leftovers(dir), [
    "docs/control-plane/work-item.v1.json: plan plan-2026-09 is active, owned by pavi",
    'docs/control-plane/project-adapter.v1.json: capability "paste" runs tools/control-plane/paste.py, which does not exist',
    'docs/control-plane/project-adapter.v1.json: capability "ship" runs tools/ship.py, which does not exist',
    'docs/control-plane/project-adapter.v1.json: capability "report-card" runs x.mjs, which does not exist',
    'docs/control-plane/project-adapter.v1.json: capability "sweep" runs bin/sweep.sh, which does not exist',
    'docs/control-plane/project-adapter.v1.json: capability "handoff" runs tools/handoff.py, which does not exist',
    "tools/control-plane/: a vendored copy of ControlPlane's tools, which Atelier does not run",
    "AGENTS.md:3 still names pickup-card",
    "AGENTS.md:4 still names audit record",
    "CLAUDE.md:3 still names control-plane-paste",
    "GLM.md:3 still names session-receipt",
  ]);
});

// A capability's command is judged on the program each command in it runs:
// a glob, a redirection and everything after the program are arguments, and
// a chain, a pipeline or a shell's `-c` command line is split first.
test("a capability's chains, pipelines, redirections and globs are judged on each command's program", (t) => {
  const { dir } = checkout(t);
  writeFileSync(join(dir, "docs/control-plane/work-item.v1.json"), JSON.stringify({ state: "reconciled" }));
  rmSync(join(dir, "tools/control-plane"), { recursive: true });
  for (const file of ["AGENTS.md", "CLAUDE.md", "GLM.md"]) writeFileSync(join(dir, file), "# weblog\n\nWork through Atelier.\n");
  writeFileSync(join(dir, "docs/control-plane/project-adapter.v1.json"), JSON.stringify({
    capabilities: {
      // agent-lens's launchd capability: a glob copied, two loops and a
      // pipeline, every program a bare word.
      "launchd-install": { command: ["/bin/bash", "-c", "cp deploy/com.pavi.agentlens-*.plist ~/Library/LaunchAgents/ && for p in ~/Library/LaunchAgents/com.pavi.agentlens*.plist; do plutil -lint \"$p\"; done && for p in ~/Library/LaunchAgents/com.pavi.agentlens*.plist; do launchctl load \"$p\" 2>/dev/null || true; done && launchctl list | grep -c com.pavi.agentlens"] },
      chain: "git status && deploy/ship.sh",
      "or-chain": "tools/ship.py || true",
      redirected: ">/dev/null tools/report.py",
      pipeline: "tools/report.py 2> logs/err.txt | gzip -c > logs/report.gz",
      filtered: "cat a.txt | tools/filter.py > out.txt",
      conditional: "if [ -f x ]; then tools/ship.py; fi",
      inline: "bash -lc 'tools/ship.py; python3 tools/count.py'",
      glob: "rm -f build/*.log",
      expanded: '"$HOME/tools/x.py" && ~/tools/y.py',
      present: 'git fetch && "tools/has space.sh"',
      // A `cd` moves the judge's working directory for the commands after it:
      // present ones stop being reported from the checkout's root, missing
      // ones are named where they are run from, and a `cd` through a variable
      // stops the judging rather than guess the root.
      "cd-present": 'cd tools && "./has space.sh"',
      "cd-missing": "cd docs && ./gen.sh",
      "cd-variable": "cd $D && ./x.sh",
      "cd-then": 'if [ -f x ]; then cd tools && "./has space.sh"; fi',
    },
  }));
  assert.deepEqual(leftovers(dir), [
    'docs/control-plane/project-adapter.v1.json: capability "chain" runs deploy/ship.sh, which does not exist',
    'docs/control-plane/project-adapter.v1.json: capability "or-chain" runs tools/ship.py, which does not exist',
    'docs/control-plane/project-adapter.v1.json: capability "redirected" runs tools/report.py, which does not exist',
    'docs/control-plane/project-adapter.v1.json: capability "pipeline" runs tools/report.py, which does not exist',
    'docs/control-plane/project-adapter.v1.json: capability "filtered" runs tools/filter.py, which does not exist',
    'docs/control-plane/project-adapter.v1.json: capability "conditional" runs tools/ship.py, which does not exist',
    'docs/control-plane/project-adapter.v1.json: capability "inline" runs tools/ship.py, which does not exist',
    'docs/control-plane/project-adapter.v1.json: capability "inline" runs tools/count.py, which does not exist',
    'docs/control-plane/project-adapter.v1.json: capability "cd-missing" runs docs/gen.sh, which does not exist',
  ]);
});

// A project that has moved on: nothing is left over, and adopt says so.
test("a settled project has no leftovers", (t) => {
  const { dir } = checkout(t);
  writeFileSync(join(dir, "docs/control-plane/work-item.v1.json"), JSON.stringify({ plan_id: "plan-2026-09", state: "reconciled" }));
  writeFileSync(join(dir, "docs/control-plane/project-adapter.v1.json"), JSON.stringify({ capabilities: [{ name: "pickup-card", command: "bin/control-plane pickup-card" }] }));
  rmSync(join(dir, "tools/control-plane"), { recursive: true });
  for (const file of ["AGENTS.md", "CLAUDE.md", "GLM.md"]) writeFileSync(join(dir, file), `# weblog\n\nWork through Atelier.\n`);
  assert.deepEqual(leftovers(dir), []);
});

// ── adopt itself ───────────────────────────────────────────────────────────

// `outside` is a directory beside the checkout and the workspace, for files a
// symlink may point at: `files` writes them, `links` turns a checkout path
// into a symlink to one. `held` writes more files into the checkout itself,
// and `policy` is what the fake server records as the project's policy.
async function fixture(t, { registered = true, paste = true, agents = AGENTS, files = {}, links = {}, held = {}, policy = {} } = {}) {
  const { root, dir } = checkout(t, { paste });
  if (agents === null) rmSync(join(dir, "AGENTS.md"), { force: true });
  else if (agents !== AGENTS) writeFileSync(join(dir, "AGENTS.md"), agents);
  for (const [path, text] of Object.entries(held)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const outside = join(root, "outside");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(outside, path)), { recursive: true });
    writeFileSync(join(outside, path), text, { mode: 0o755 });
  }
  for (const [path, target] of Object.entries(links)) {
    rmSync(join(dir, path), { recursive: true, force: true });
    symlinkSync(join(outside, target), join(dir, path));
  }
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test Owner");
  git("config", "user.email", "owner@example.test");
  git("add", "-A");
  git("commit", "-q", "-m", "The project as ControlPlane leaves it");
  const head = git("rev-parse", "HEAD");
  const item = { id: "t1", title: "Move weblog from ControlPlane to Atelier", scope: [], state: "claimed", owner: actor, head, fork: "weblog--t1", base: head, acceptedHead: null };
  const posts = [];
  // Each adopt creates its own task, so the second one works in its own
  // workspace, cloned from the branch as it stands then.
  let minted = 0, latest = null;
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    posts.push({ url: req.url, method: req.method, as: req.headers["x-atelier-actor"], body: raw ? JSON.parse(raw) : null });
    let data = {};
    if (req.method === "GET" && req.url === "/api/projects/weblog") data = { project: { name: "weblog", policy }, items: [], events: [] };
    else if (req.url.endsWith("/items")) data = latest = { ...item, id: `t${++minted}` };
    else if (req.url.endsWith("/claim")) data = { item: latest, workspace: { remote: dir, token: "fake", expiresAt: "tomorrow", defaultBranch: "main" } };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  });
  t.after(() => server.close());
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const cache = join(root, "cache");
  writeFileSync(join(root, "config.json"), JSON.stringify({
    server: `http://127.0.0.1:${server.address().port}`, owner: "owner",
    projects: registered ? { weblog: { path: dir, branch: "main" } } : {},
  }));
  // Spawned asynchronously: the fake server runs in this process, so a
  // synchronous run would block the event loop that answers the CLI's requests.
  const run = async (argv) => {
    const child = spawn(process.execPath, [cli, ...argv], {
      cwd: dir, env: { ...process.env, ATELIER_CONFIG_DIR: root, ATELIER_CACHE: cache, ATELIER_TOKEN: "test", ATELIER_ACTOR: actor },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (s) => stdout += s);
    child.stderr.on("data", (s) => stderr += s);
    const status = await new Promise((done) => child.on("close", done));
    return { status, stdout, stderr, output: `${stdout}${stderr}` };
  };
  const workspaceFor = (id) => join(cache, "work", "weblog", id);
  const at = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  return {
    root, dir, outside, git, head, posts, run, workspaceFor,
    workspace: workspaceFor("t1"),
    read: (path) => readFileSync(join(workspaceFor("t1"), path), "utf8"),
    readIn: (id, path) => readFileSync(join(workspaceFor(id), path), "utf8"),
    workspaceGit: (...args) => at(workspaceFor("t1"), ...args),
    gitIn: at,
  };
}

test("adopt makes the move: one task, claimed as the current actor, three files committed, nothing pushed", async (t) => {
  const f = await fixture(t);
  const before = tree(f.dir);
  const r = await f.run(["adopt", "--project", "weblog"]);
  assert.equal(r.status, 0, r.output);

  const created = f.posts.find((p) => p.url === "/api/projects/weblog/items");
  assert.equal(created.body.title, "Move weblog from ControlPlane to Atelier");
  assert.deepEqual(created.body.scope, ["bin/control-plane", "bin/control-plane-paste", "AGENTS.md", "CLAUDE.md", "GLM.md",
    "docs/control-plane/work-item.v1.json", "docs/control-plane/project-adapter.v1.json", "tools/control-plane/**"]);
  const claim = f.posts.find((p) => p.url.endsWith("/claim"));
  assert.equal(claim.as, actor);

  // The three files, with the project's name filled in, in one commit.
  assert.equal(f.workspaceGit("log", "-1", "--format=%s"), "Move weblog from ControlPlane to Atelier");
  assert.deepEqual(f.workspaceGit("show", "--name-only", "--format=", "HEAD").split("\n").sort(),
    ["AGENTS.md", "bin/control-plane", "bin/control-plane-paste"]);
  assert.match(f.workspaceGit("ls-tree", "HEAD", "bin/control-plane"), /^100755/);
  assert.match(f.workspaceGit("ls-tree", "HEAD", "bin/control-plane-paste"), /^100755/);
  const entry = f.read("bin/control-plane");
  assert.ok(entry.startsWith("#!/bin/sh\n"));
  assert.ok(entry.includes("atelier_project='weblog'"));
  assert.ok(!entry.includes("__ATELIER_PROJECT__"));
  assert.equal(f.read("bin/control-plane-paste"), pasteScript("weblog"));
  const agents = f.read("AGENTS.md");
  assert.ok(agents.startsWith(`# weblog\n\n## This project works through Atelier\n\n`), agents.slice(0, 120));
  assert.ok(agents.includes("`atelier done \"summary\"`"));
  assert.ok(agents.includes("`bin/control-plane` now forwards to Atelier"));
  assert.ok(agents.endsWith("\n\n## Notes\n\nKeep the changelog current.\n"), agents.slice(-80));
  assert.equal(f.workspaceGit("status", "--porcelain"), "");
  assert.equal(f.workspaceGit("rev-parse", "origin/main"), f.head, "the move is not pushed");

  // The checkout it read is exactly as it was.
  assert.deepEqual(tree(f.dir), before, "the registered checkout is unchanged");

  // The leftovers are printed and recorded on the task as reported notes.
  for (const line of leftovers(f.dir)) {
    assert.ok(r.stdout.includes(line), line);
    assert.ok(f.posts.some((p) => p.url.endsWith("/evidence") && p.body.kind === "report" && p.body.claim === line), line);
  }
  assert.ok(f.posts.filter((p) => p.body?.kind === "report").every((p) => p.body.head === f.head));
  assert.match(r.stdout, /recorded on t1 as reported notes/);
});

test("a project with no bin/control-plane-paste keeps it out of the move", async (t) => {
  const f = await fixture(t, { paste: false });
  const r = await f.run(["adopt", "--project", "weblog"]);
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(f.workspaceGit("show", "--name-only", "--format=", "HEAD").split("\n").sort(), ["AGENTS.md", "bin/control-plane"]);
  assert.ok(!existsSync(join(f.workspace, "bin", "control-plane-paste")));
});

test("adopting a moved project again keeps one Atelier section and changes nothing", async (t) => {
  const f = await fixture(t);
  const first = await f.run(["adopt", "--project", "weblog"]);
  assert.equal(first.status, 0, first.output);
  // The owner merges the move: what the task committed lands in the checkout.
  for (const path of ["AGENTS.md", "bin/control-plane", "bin/control-plane-paste"]) {
    copyFileSync(join(f.workspace, path), join(f.dir, path));
  }
  f.git("add", "-A");
  f.git("commit", "-q", "-m", "Merge the Atelier move");
  const before = tree(f.dir);

  const again = await f.run(["adopt", "--project", "weblog"]);
  assert.equal(again.status, 0, again.output);
  assert.match(again.stdout, /already in place/);
  const agents = f.readIn("t2", "AGENTS.md");
  assert.equal(agents.split("## This project works through Atelier").length - 1, 1);
  assert.equal(agents.split("## Notes").length - 1, 1);
  assert.ok(agents.endsWith("\n\n## Notes\n\nKeep the changelog current.\n"));
  assert.equal(f.gitIn(f.workspaceFor("t2"), "status", "--porcelain"), "");
  assert.deepEqual(tree(f.dir), before, "the registered checkout is unchanged");
});

// ── nothing is written through a symlink, and nothing outside the workspace ─

test("a symlinked bin/control-plane is replaced, not written through", async (t) => {
  const launcher = "#!/bin/sh\n# ControlPlane's launcher, kept outside.\n";
  const paste = "#!/bin/sh\n# ControlPlane's paste, kept outside.\n";
  const f = await fixture(t, {
    files: { launcher, paste },
    links: { "bin/control-plane": "launcher", "bin/control-plane-paste": "paste" },
  });
  const before = tree(f.dir);
  const r = await f.run(["adopt", "--project", "weblog"]);
  assert.equal(r.status, 0, r.output);

  for (const [name, held] of [["launcher", launcher], ["paste", paste]]) {
    assert.equal(readFileSync(join(f.outside, name), "utf8"), held, "the file the link pointed at is untouched");
  }
  for (const path of ["bin/control-plane", "bin/control-plane-paste"]) {
    const at = join(f.workspace, path);
    assert.ok(!lstatSync(at).isSymbolicLink(), `${path}: the link is replaced by a regular file`);
    assert.equal(readFileSync(at, "utf8"), f.read(path));
    assert.match(f.workspaceGit("ls-tree", "HEAD", path), /^100755/);
  }
  assert.deepEqual(tree(f.dir), before, "the registered checkout is unchanged");
});

test("a dangling bin/control-plane-paste link is replaced too", async (t) => {
  // The link's target is never written, so it dangles in the checkout and in
  // the workspace alike.
  const f = await fixture(t, { links: { "bin/control-plane-paste": "gone/paste" } });
  const before = tree(f.dir);
  const r = await f.run(["adopt", "--project", "weblog"]);
  assert.equal(r.status, 0, r.output);
  const at = join(f.workspace, "bin", "control-plane-paste");
  assert.ok(!lstatSync(at).isSymbolicLink(), "the dangling link is replaced by a regular file");
  assert.equal(f.read("bin/control-plane-paste"), pasteScript("weblog"));
  assert.match(f.workspaceGit("ls-tree", "HEAD", "bin/control-plane-paste"), /^100755/);
  assert.ok(!existsSync(join(f.outside, "gone")), "nothing is created where the link pointed");
  assert.deepEqual(tree(f.dir), before, "the registered checkout is unchanged");
});

test("a written path is refused when any directory above it is a symlink", (t) => {
  const root = mkdtempSync(join(tmpdir(), "atelier-links-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "project");
  mkdirSync(join(root, "outside"), { recursive: true });
  mkdirSync(join(project, "src"), { recursive: true });
  symlinkSync(join(root, "outside"), join(project, "src", "vendor"));
  assert.equal(linkedPart(project, "src/vendor/x.py"), "src/vendor");
  assert.equal(linkedPart(project, "src/plain/x.py"), null, "an absent directory holds nothing");
  assert.equal(linkedPart(project, "src/vendor"), null, "the path's own directory is left to isLink");
  assert.ok(isLink(join(project, "src", "vendor")));
  assert.ok(!isLink(join(project, "src")));
  assert.ok(!isLink(join(project, "missing")));
});

test("a symlinked AGENTS.md is refused before the task exists", async (t) => {
  const outsideAgents = "Run bin/control-plane pickup-card.\n";
  const f = await fixture(t, { files: { AGENTS: outsideAgents }, links: { "AGENTS.md": "AGENTS" } });
  const before = tree(f.dir);
  const r = await f.run(["adopt", "--project", "weblog"]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /AGENTS\.md is a symbolic link/);
  assert.deepEqual(f.posts, [], "no task, no claim");
  assert.equal(readFileSync(join(f.outside, "AGENTS"), "utf8"), outsideAgents);
  assert.deepEqual(tree(f.dir), before);
  assert.ok(!existsSync(f.workspace), "no workspace was made");
});

test("a symlinked directory above a written path refuses the move before the task exists", async (t) => {
  const launcher = "#!/bin/sh\n# ControlPlane's launcher, kept outside.\n";
  const f = await fixture(t, { files: { "bin/control-plane": launcher }, links: { bin: "bin" } });
  const before = tree(f.dir);
  const r = await f.run(["adopt", "--project", "weblog"]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /bin is a symbolic link/);
  assert.deepEqual(f.posts, [], "no task, no claim");
  assert.equal(readFileSync(join(f.outside, "bin", "control-plane"), "utf8"), launcher);
  assert.deepEqual(tree(f.dir), before);
  assert.ok(!existsSync(f.workspace), "no workspace was made");
});

test("adopt refuses an unregistered project and a dirty checkout", async (t) => {
  const unregistered = await fixture(t, { registered: false });
  const r = await unregistered.run(["adopt", "--project", "weblog"]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /weblog is not registered on this Mac/);
  assert.deepEqual(unregistered.posts, []);

  const dirty = await fixture(t);
  writeFileSync(join(dirty.dir, "notes.md"), "still editing\n");
  const d = await dirty.run(["adopt", "--project", "weblog"]);
  assert.equal(d.status, 1, d.stdout);
  assert.match(d.stderr, /has uncommitted changes/);
  assert.deepEqual(dirty.posts, []);
});

// ── checks that refuse run before the task exists ──────────────────────────

test("an agent the project's policy does not admit is refused before the task exists", async (t) => {
  const f = await fixture(t, { policy: { eligible: ["claude"] } });
  const before = tree(f.dir);
  const r = await f.run(["adopt", "--project", "weblog"]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /zcode is not an eligible agent here \(eligible: claude\)/);
  assert.match(r.stderr, /The move was not started; run it as an eligible agent: atelier adopt --project weblog --as HARNESS\/MODEL/);
  assert.deepEqual(f.posts.map((p) => [p.method, p.url]), [["GET", "/api/projects/weblog"]], "the policy is read; no task, no claim");
  assert.ok(!existsSync(f.workspace), "no workspace was made");
  assert.deepEqual(tree(f.dir), before, "the registered checkout is unchanged");

  // The project owner is admitted whatever the list says, as at a claim.
  const owner = await f.run(["adopt", "--project", "weblog", "--as", "owner"]);
  assert.equal(owner.status, 0, owner.output);
  assert.equal(f.posts.find((p) => p.url.endsWith("/claim")).as, "owner");
});

test("an AGENTS.md that cannot be read refuses the move before the task exists", async (t) => {
  const f = await fixture(t, { agents: null });
  const r = await f.run(["adopt", "--project", "weblog"]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /AGENTS\.md cannot be read/);
  assert.deepEqual(f.posts, [], "no task, no claim");
  assert.ok(!existsSync(f.workspace), "no workspace was made");
});

test("an AGENTS.md with no heading gets the section at the top", async (t) => {
  const prose = "Notes for agents: pick up your card with bin/control-plane pickup-card.\n\nKeep the changelog current.\n";
  const f = await fixture(t, { agents: prose });
  const r = await f.run(["adopt", "--project", "weblog"]);
  assert.equal(r.status, 0, r.output);
  const agents = f.read("AGENTS.md");
  assert.ok(agents.startsWith("## This project works through Atelier\n"), agents.slice(0, 60));
  assert.ok(agents.endsWith(prose), "every line of the file is kept");
});

// ── the project's context ceiling ──────────────────────────────────────────

const BUDGET = "docs/control-plane/context-budget.v1.json";
const budget = (ceiling) => JSON.stringify({
  schema_version: 1, kind: "control-plane.context-budget", advisory: true, drift_multiple: 3,
  surfaces: [{ path: "AGENTS.md", baseline_lines: 1, required: true, ceiling_lines: ceiling }, { path: "docs/STATE.md", baseline_lines: 26, required: false }],
}, null, 2) + "\n";

test("the files the move writes are measured against the project's context ceiling", (t) => {
  const root = mkdtempSync(join(tmpdir(), "atelier-ceiling-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = [{ path: "bin/control-plane", text: "#!/bin/sh\n" }, { path: "AGENTS.md", text: "# weblog\n\n## This project works through Atelier\n\nLine.\n" }];
  assert.equal(ceilingRefusal(root, files), null, "no policy, no ceiling");
  mkdirSync(join(root, "docs/control-plane"), { recursive: true });
  writeFileSync(join(root, BUDGET), budget(5));
  assert.equal(ceilingRefusal(root, files), null, "five lines fit a ceiling of five");
  writeFileSync(join(root, BUDGET), budget(4));
  assert.equal(ceilingRefusal(root, files),
    `AGENTS.md would be 5 lines after the move, 1 over its ceiling of 4 in ${BUDGET}, and atelier wrap refuses a file over its ceiling. Shorten AGENTS.md in the checkout (move history to docs/history/), commit, then run atelier adopt again.`);
  // A surface with no ceiling sets none; a file the policy does not name is not measured.
  writeFileSync(join(root, BUDGET), budget(undefined));
  assert.equal(ceilingRefusal(root, files), null);
  writeFileSync(join(root, BUDGET), "{");
  assert.match(ceilingRefusal(root, files), /context-budget\.v1\.json is not a valid context budget policy .*run atelier adopt again/);
});

test("a move past the project's context ceiling is refused before the task exists", async (t) => {
  const f = await fixture(t, { held: { [BUDGET]: budget(20) } });
  const before = tree(f.dir);
  const r = await f.run(["adopt", "--project", "weblog"]);
  assert.equal(r.status, 1, r.stdout);
  const counted = /AGENTS\.md would be (\d+) lines after the move, (\d+) over its ceiling of 20 in docs\/control-plane\/context-budget\.v1\.json/.exec(r.stderr);
  assert.ok(counted, r.stderr);
  assert.ok(Number(counted[1]) > 20);
  assert.equal(Number(counted[1]) - 20, Number(counted[2]));
  assert.match(r.stderr, /Shorten AGENTS\.md in the checkout/);
  assert.deepEqual(f.posts, [], "no task, no claim");
  assert.ok(!existsSync(f.workspace), "no workspace was made");
  assert.deepEqual(tree(f.dir), before, "the registered checkout is unchanged");
});

test("a move under the ceiling goes ahead and leaves the policy as it is", async (t) => {
  const f = await fixture(t, { held: { [BUDGET]: budget(500) } });
  const r = await f.run(["adopt", "--project", "weblog"]);
  assert.equal(r.status, 0, r.output);
  assert.equal(f.read(BUDGET), budget(500));
  assert.deepEqual(f.workspaceGit("show", "--name-only", "--format=", "HEAD").split("\n").sort(), ["AGENTS.md", "bin/control-plane", "bin/control-plane-paste"]);
});

for (const typed of ["pickup-card", "unwrap"]) test(`${typed} refuses extra arguments with one line that names ${typed}`, (t) => {
  const run = entryPoint(t, "weblog");
  const r = run(typed, "extra");
  assert.equal(r.status, 2);
  assert.equal(r.argv, null, "atelier must not run");
  assert.equal(r.stderr, `control-plane: ${typed} takes no arguments.\n`);
});
