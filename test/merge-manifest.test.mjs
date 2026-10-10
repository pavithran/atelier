import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { MANIFEST_PATH, parseManifest } from "../cli/merge-driver.mjs";
import { mergeConfigProblems, mergeThrough, previewMerge } from "../cli/merge-pipeline.mjs";
import { runGroup } from "../cli/group.mjs";
import { commandFiles, handlerIndex, specIndex } from "../cli/regenerate.mjs";

// t463 on this repository's own declarations: bin/merge-manifest.json names
// node cli/regenerate.mjs as the generator of the command indexes and the
// CLI fixtures, and cli/commands and src/usage/commands as registries, so
// two tasks that each add a command merge without a conflict a person must
// resolve. The fixture is a fresh repository holding a copy of the CLI, its
// declarations and this repository's manifest and .gitattributes.

const root = resolve(".");
const SPECS = "src/usage/commands", HANDLERS = "cli/commands";
const OUTPUTS = ["cli/commands/index.mjs", "src/usage/commands/index.ts", "test/fixtures/cli/guide.txt", "test/fixtures/cli/help.txt", "test/fixtures/cli/usage.json"];

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

test("this repository declares node cli/regenerate.mjs with every output it writes, routed to the generated driver, and the command folders as registries", () => {
  const manifest = parseManifest(readFileSync(join(root, MANIFEST_PATH), "utf8"));
  const regenerate = manifest.generators.find((g) => g.command.join(" ") === "node cli/regenerate.mjs");
  assert.ok(regenerate, "node cli/regenerate.mjs is declared");
  assert.deepEqual([...regenerate.outputs].sort(), OUTPUTS);
  assert.deepEqual(regenerate.inputs, ["cli/**", "src/**"]);
  assert.deepEqual(manifest.generators.flatMap((g) => g.outputs).sort(), OUTPUTS, "no other generator claims an output");
  const attrs = git(root, "check-attr", "merge", "--", ...OUTPUTS);
  for (const path of OUTPUTS) assert.match(attrs, new RegExp(`^${path.replace(/\./g, "\\.")}: merge: atelier-generated$`, "m"));
  const registries = Object.fromEntries(manifest.registries.map((r) => [r.dir, r]));
  assert.deepEqual(Object.keys(registries).sort(), [HANDLERS, SPECS]);
  // Every module names its own command as its key; the indexes are not entries.
  for (const [dir, ext] of [[HANDLERS, ".mjs"], [SPECS, ".ts"]]) {
    assert.deepEqual(registries[dir].exclude, [`index${ext}`]);
    const names = commandFiles(root, dir, ext);
    assert.ok(names.length > 60);
    for (const name of names) assert.equal(registries[dir].pattern.exec(readFileSync(join(root, dir, `${name}${ext}`), "utf8"))?.[1], name, `${dir}/${name}${ext}`);
  }
});

test("a registry's exclude is a list of file names in its folder", () => {
  const registry = (exclude) => JSON.stringify({ version: 1, registries: [{ name: "r", dir: "d", key: "^(\\S+)", exclude }] });
  assert.deepEqual(parseManifest(registry(["index.mjs"])).registries[0].exclude, ["index.mjs"]);
  assert.throws(() => parseManifest(registry("index.mjs")), /registry r's exclude must be a list of file names in its folder/);
  assert.throws(() => parseManifest(registry(["sub/index.mjs"])), /registry r's exclude must be a list of file names/);
});

const declaration = (name) => `import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "${name}",
  forms: [{ group: "Local", line: 9, slot: 10, form: "${name}", about: "Says ${name}." }],
  flags: {},
  help: { example: "atelier ${name}" },
};

export default spec;
`;
const handler = (name, word = name) => `// atelier ${name}. Its forms and help are declared in src/usage/commands/${name}.ts.
export default function command() {
  console.log("${word}");
}
`;

// A fresh repository, with no merge configuration, at a base commit that
// holds a copy of the CLI and this repository's declarations.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-own-manifest-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const part of ["cli", "src", "test/fixtures/cli", "package.json", ".gitattributes", MANIFEST_PATH]) cpSync(join(root, part), join(dir, part), { recursive: true });
  if (existsSync(join(root, "node_modules"))) symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
  git(dir, "init", "-q", "-b", "main");
  appendFileSync(join(dir, ".git/info/exclude"), "node_modules\n");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

// One task's commit adding commands: their two modules each, and the
// indexes rewritten as cli/regenerate.mjs writes them (the fixtures, which
// the CLI prints, are left to the merge's regeneration).
function addCommands(dir, branch, commands, { indexes = true } = {}) {
  git(dir, "checkout", "-q", "-B", branch, "base");
  for (const [file, name, word] of commands) {
    writeFileSync(join(dir, SPECS, `${file}.ts`), declaration(name));
    writeFileSync(join(dir, HANDLERS, `${file}.mjs`), handler(name, word));
  }
  if (indexes) {
    writeFileSync(join(dir, SPECS, "index.ts"), specIndex(commandFiles(dir, SPECS, ".ts")));
    writeFileSync(join(dir, HANDLERS, "index.mjs"), handlerIndex(commandFiles(dir, HANDLERS, ".mjs")));
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `add ${commands.map((c) => c[1]).join(", ")}`);
}

function sides(dir, theirs, ours, opts) {
  git(dir, "tag", "base");
  addCommands(dir, "theirs", theirs, opts);
  addCommands(dir, "main", ours, opts);
}

// The generator as a merge runs it, with this test's node first on PATH.
const counting = () => {
  const calls = [];
  const run = (argv, { cwd, env }) => { calls.push(argv); return runGroup(argv, { cwd, env: { ...env, PATH: `${dirname(process.execPath)}:${env.PATH ?? ""}` } }); };
  return { run, calls };
};

test("two tasks each adding a command merge through the pipeline: the indexes and fixtures are regenerated, in a fresh clone that lacked the configuration", { timeout: 600_000 }, async (t) => {
  const dir = fixture(t);
  sides(dir, [["wave", "wave"]], [["hello", "hello"]]);
  assert.ok(mergeConfigProblems(dir).length >= 4, "a fresh clone has no merge configuration");
  // Git alone conflicts on both indexes; the preview calls them regenerable, not source conflicts.
  const preview = previewMerge(dir, "HEAD", "theirs");
  assert.deepEqual(preview.source, []);
  assert.deepEqual(preview.generated, ["cli/commands/index.mjs", "src/usage/commands/index.ts"]);
  assert.deepEqual(preview.regenerate, ["command-indexes"]);
  assert.equal(preview.clean, true);
  assert.deepEqual(mergeConfigProblems(dir), [], "the preview installed the configuration");
  const { run, calls } = counting();
  const r = await mergeThrough(dir, "theirs", { message: "Merge theirs\n\nAgent: test/model", run });
  assert.equal(r.state, "merged", JSON.stringify({ ...r, manifest: undefined }));
  assert.deepEqual(calls, [["node", "cli/regenerate.mjs"], ["node", "cli/regenerate.mjs"]]);
  assert.equal(git(dir, "status", "--porcelain"), "");
  const read = (path) => readFileSync(join(dir, path), "utf8");
  assert.match(read("cli/commands/index.mjs"), /\{ path: "cli\/commands\/hello\.mjs", run: command_hello \},\n  \{ path: "cli\/commands\/help\.mjs"[\s\S]*\{ path: "cli\/commands\/wave\.mjs", run: command_wave \}/);
  assert.match(read("src/usage/commands/index.ts"), /import command_hello from "\.\/hello\.ts";[\s\S]*import command_wave from "\.\/wave\.ts";/);
  assert.match(read("test/fixtures/cli/help.txt"), /hello · .*wave|hello[\s\S]*wave/);
  const usage = JSON.parse(read("test/fixtures/cli/usage.json"));
  assert.ok(usage.hello.startsWith("usage: atelier hello") && usage.wave.startsWith("usage: atelier wave"));
  // The guide is unchanged by two commands it does not name: identical to a side is valid.
  const outputs = Object.fromEntries(r.regenerated[0].outputs.map((o) => [o.path, o.matches]));
  assert.equal(outputs["test/fixtures/cli/guide.txt"], "ours");
  assert.equal(outputs["cli/commands/index.mjs"], "neither side");
  assert.match(git(dir, "log", "-1", "--format=%B"), /Atelier-Regenerated: command-indexes \(node cli\/regenerate\.mjs\): .*; log sha256 [0-9a-f]{64}\nAgent: test\/model$/);
  // Both commands run from the merged tree.
  const cli = (word) => spawnSync(process.execPath, ["cli/atelier.mjs", word], { cwd: dir, encoding: "utf8", env: { ...process.env, ATELIER_CONFIG_DIR: join(dir, ".git", "cfg") } }).stdout;
  assert.equal(cli("hello"), "hello\n");
  assert.equal(cli("wave"), "wave\n");
});

test("two command modules claiming one name stop the merge on the registry key before the generator runs", async (t) => {
  const dir = fixture(t);
  sides(dir, [["greet", "hello"]], [["hello", "hello"]], { indexes: false });
  const { run, calls } = counting();
  const r = await mergeThrough(dir, "theirs", { message: "m", run });
  assert.equal(r.state, "conflicts");
  assert.deepEqual(r.problems, [
    "the command-handlers registry key hello is declared by both cli/commands/greet.mjs and cli/commands/hello.mjs",
    "the command-declarations registry key hello is declared by both src/usage/commands/greet.ts and src/usage/commands/hello.ts",
  ]);
  assert.equal(calls.length, 0);
  assert.equal(previewMerge(dir, "HEAD", "theirs").clean, false);
  assert.equal(git(dir, "rev-parse", "HEAD"), git(dir, "rev-parse", "main"));
});

test("one command added differently on both sides is a source conflict: nothing is generated and the indexes stay regenerable", async (t) => {
  const dir = fixture(t);
  sides(dir, [["hello", "hello", "hi"]], [["hello", "hello", "hello"]]);
  const { run, calls } = counting();
  const r = await mergeThrough(dir, "theirs", { message: "m", run, leave: true });
  assert.equal(r.state, "conflicts");
  assert.deepEqual(r.source, ["cli/commands/hello.mjs"]);
  assert.deepEqual(r.generated, []);
  assert.equal(calls.length, 0);
  // Left for a person: the source in conflict, no output written from it.
  assert.match(readFileSync(join(dir, "cli/commands/hello.mjs"), "utf8"), /^<<<<<<< /m);
  git(dir, "merge", "--abort");
});
