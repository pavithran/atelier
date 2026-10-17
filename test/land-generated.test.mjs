import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mergeMainAndRegenerate, StepError } from "../cli/land.mjs";

// t730: files the project declares generated (here out/index.txt, as
// test/fixtures/cli/* is in bin/merge-manifest.json) are regenerated when
// main moves under a task, never conflicted by hand; a conflict in any
// other file, or a generator that fails, stops the landing. The task's
// workspace and main's repository are local; the landing's own merge step,
// mergeMainAndRegenerate, runs against them.

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
const GENERATOR = `import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
if (process.env.FAIL_GENERATOR || readdirSync(".").includes("fail-generator")) { console.log("generator exploded: boom-marker"); process.exit(3); }
const names = readdirSync("cmds").sort().map((f) => /^name: (\\S+)/m.exec(readFileSync("cmds/" + f, "utf8"))[1]);
mkdirSync("out", { recursive: true });
writeFileSync("out/index.txt", names.map((n) => n + "\\n").join(""));
`;
const MANIFEST = { version: 1, generators: [{ name: "index", command: ["node", "gen.mjs"], inputs: ["cmds/**", "gen.mjs"], outputs: ["out/index.txt"] }] };

function write(dir, files) {
  for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); }
}
function commit(dir, files, message) {
  write(dir, files);
  if (!files["fail-generator"]) spawnSync("node", ["gen.mjs"], { cwd: dir });
  git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", message);
}

// `main` is a repository; the workspace clones it, then main and the task
// each add a command, so the generated index conflicts as text.
function setup(t, { main = {}, task = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "atelier-landgen-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "main"), dir = join(root, "ws");
  mkdirSync(remote); git(remote, "init", "-q", "-b", "main");
  commit(remote, { "gen.mjs": GENERATOR, "bin/merge-manifest.json": JSON.stringify(MANIFEST), ".gitattributes": "out/index.txt merge=atelier-generated\n", "cmds/help.txt": "name: help\n", "notes.txt": "base\n" }, "base");
  git(root, "clone", "-q", remote, dir);
  commit(remote, { "cmds/land.txt": "name: land\n", ...main }, "main work");
  commit(dir, { "cmds/push.txt": "name: push\n", ...task }, "task work");
  const lines = [];
  const io = {
    request: async () => { throw new Error("no request expected"); },
    git: (args, opts = {}) => { const r = spawnSync("git", args, { encoding: "utf8", cwd: opts.cwd, env }); if (opts.allowFail) return r; if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`); return r.stdout.trim(); },
    print: (m) => lines.push(m), redact: (s) => s, secrets: () => [],
  };
  const merge = () => mergeMainAndRegenerate(io, { dir, id: "t1", name: "proj", regenerate: "node gen.mjs", record: async () => {}, guard: () => {}, d0: {}, base: { remote, defaultBranch: "main", token: "x" } });
  return { dir, remote, merge, lines };
}

test("a conflict confined to a declared generated file is regenerated and committed with no manual step", async (t) => {
  const f = setup(t);
  const r = await f.merge();
  assert.equal(r.mergedIn, true);
  assert.equal(git(f.dir, "status", "--porcelain"), "");
  assert.equal(git(f.dir, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").length, 3, "a merge commit");
  // The regenerated file equals a fresh run of the command on the merged tree.
  const merged = readFileSync(join(f.dir, "out/index.txt"), "utf8");
  assert.equal(merged, "help\nland\npush\n");
  assert.equal(spawnSync("node", ["gen.mjs"], { cwd: f.dir }).status, 0);
  assert.equal(readFileSync(join(f.dir, "out/index.txt"), "utf8"), merged);
  assert.equal(git(f.dir, "status", "--porcelain"), "");
});

test("a conflict that also touches a source file stops the landing and names it", async (t) => {
  const f = setup(t, { main: { "notes.txt": "main\n" }, task: { "notes.txt": "task\n" } });
  await assert.rejects(f.merge(), (e) => e instanceof StepError && /notes\.txt/.test(e.message) && /stops on conflicts/.test(e.message));
});

test("a failed regenerate command stops the landing with its output", async (t) => {
  const f = setup(t, { task: { "fail-generator": "" } });
  await assert.rejects(f.merge(), (e) => e instanceof StepError && /generator index/.test(e.message) && /failed on run 1 \(exit 3\)/.test(e.message) && /boom-marker/.test(e.message));
  assert.ok(!existsSync(join(f.dir, ".git", "MERGE_HEAD")), "the merge is aborted");
});
