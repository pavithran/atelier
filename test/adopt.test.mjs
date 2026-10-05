import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { fillTemplate, leftovers, TEMPLATE } from "../cli/adopt.mjs";

const cli = resolve("cli/atelier.mjs");
const template = readFileSync(TEMPLATE, "utf8");
const actor = "zcode/glm-5.3";

// ── the entry point that replaces bin/control-plane ────────────────────────

function entryPoint(t, project = "weblog") {
  const dir = mkdtempSync(join(tmpdir(), "atelier-entry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const entry = join(dir, "control-plane"), argvFile = join(dir, "argv");
  writeFileSync(entry, fillTemplate(template, project), { mode: 0o755 });
  // A stub `atelier` on PATH records the arguments it was given and does nothing else.
  writeFileSync(join(dir, "atelier"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\n`, { mode: 0o755 });
  return (...argv) => {
    const r = spawnSync(entry, argv, { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    const recorded = existsSync(argvFile) ? readFileSync(argvFile, "utf8").split("\n").filter(Boolean) : null;
    rmSync(argvFile, { force: true });
    return { ...r, argv: recorded };
  };
}

test("the entry point runs the Atelier command each ControlPlane command became", (t) => {
  const run = entryPoint(t);
  const ops = ["audit", "context-budget", "ship-check", "observe", "observatory-bundle", "observatory-run", "backup-status", "validate-backup"];
  const cases = [
    [["pickup-card"], ["status", "--project", "weblog"]],
    [["wrap"], ["done"]],
    [["session-receipt", "the day's work"], ["done", "the day's work"]],
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

test("help, and no command, list the mappings without running atelier", (t) => {
  const run = entryPoint(t);
  for (const argv of [["help"], []]) {
    const r = run(...argv);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.argv, null, "help must not run atelier");
    for (const text of ["works through Atelier", "pickup-card", "atelier status --project weblog",
      "session-receipt", "atelier done", "report TEXT", "atelier new TEXT --project weblog", "audit", "atelier ops"]) {
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

test("the project name is filled in as one shell word", () => {
  assert.ok(fillTemplate(template, "weblog").includes("atelier_project='weblog'"));
  assert.ok(!fillTemplate(template, "weblog").includes("__ATELIER_PROJECT__"));
  assert.ok(fillTemplate(template, "it's").includes(`atelier_project='it'\\''s'`));
  assert.throws(() => fillTemplate("nothing to fill", "weblog"), /no project name to fill in/);
  assert.throws(() => fillTemplate(template, "two\nlines"), /cannot be written into a shell script/);
});

// ── a project with ControlPlane habits ─────────────────────────────────────

const AGENTS = `# weblog

Run bin/control-plane pickup-card to pick up your card, then finish with
bin/control-plane audit record.

## Notes

Keep the changelog current.
`;

// The checkout as ControlPlane leaves it: a launcher, a paste helper, a work
// item still active, an adapter naming a tool the project no longer has, a
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
    ],
  }, null, 2) + "\n");
  write("tools/control-plane/pickup.py", "# ControlPlane's own copy of its tools.\n");
  return { root, dir };
}

test("the leftovers are what ControlPlane still holds in the checkout", (t) => {
  const { dir } = checkout(t);
  assert.deepEqual(leftovers(dir), [
    "docs/control-plane/work-item.v1.json: plan plan-2026-09 is active, owned by pavi",
    'docs/control-plane/project-adapter.v1.json: capability "paste" runs tools/control-plane/paste.py, which does not exist',
    "tools/control-plane/: a vendored copy of ControlPlane's tools, which Atelier does not run",
    "AGENTS.md:3 still names pickup-card",
    "AGENTS.md:4 still names audit record",
    "CLAUDE.md:3 still names control-plane-paste",
    "GLM.md:3 still names session-receipt",
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

async function fixture(t, { registered = true, paste = true } = {}) {
  const { root, dir } = checkout(t, { paste });
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test Owner");
  git("config", "user.email", "owner@example.test");
  git("add", "-A");
  git("commit", "-q", "-m", "The project as ControlPlane leaves it");
  const head = git("rev-parse", "HEAD");
  const item = { id: "t1", title: "Move weblog from ControlPlane to Atelier", scope: [], state: "claimed", owner: actor, head, fork: "weblog--t1", base: head, acceptedHead: null };
  const posts = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    posts.push({ url: req.url, method: req.method, as: req.headers["x-atelier-actor"], body: raw ? JSON.parse(raw) : null });
    const data = req.url.endsWith("/claim")
      ? { item, workspace: { remote: dir, token: "fake", expiresAt: "tomorrow", defaultBranch: "main" } }
      : req.url.endsWith("/items") ? item : {};
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
  const workspace = join(cache, "work", "weblog", "t1");
  return {
    root, dir, git, head, posts, run, workspace,
    read: (path) => readFileSync(join(workspace, path), "utf8"),
    workspaceGit: (...args) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim(),
  };
}

test("adopt makes the move: one task, claimed as the current actor, three files committed, nothing pushed", async (t) => {
  const f = await fixture(t);
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
  assert.equal(f.read("bin/control-plane-paste").trimEnd().split("\n").length, 2);
  const agents = f.read("AGENTS.md");
  assert.ok(agents.startsWith(`# weblog\n\n## This project works through Atelier\n\n`), agents.slice(0, 120));
  assert.ok(agents.includes("`atelier done \"summary\"`"));
  assert.ok(agents.includes("`bin/control-plane` now forwards to Atelier"));
  assert.ok(agents.endsWith("\n\n## Notes\n\nKeep the changelog current.\n"), agents.slice(-80));
  assert.equal(f.workspaceGit("status", "--porcelain"), "");
  assert.equal(f.workspaceGit("rev-parse", "origin/main"), f.head, "the move is not pushed");

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
