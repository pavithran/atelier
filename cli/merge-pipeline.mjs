// The one merge pipeline (t463). Every merge Atelier makes — a landing's
// merge of main into the workspace and the owner's merge onto the baseline,
// atelier update's rebase, a runner's merge-main, integrate and refresh
// merges, and the speculative merge atelier check --merged checks — goes
// through here, so generated outputs and record files merge the same way
// wherever the merge runs:
//
//   1. The clone's merge configuration is installed (installMergeConfig):
//      the drivers .gitattributes routes declared paths to are defined in
//      the clone's own config, so Git never falls back silently to a text
//      merge of a generated output or a record file.
//   2. Git merges the sources, without committing. Record files merge by
//      key through the records driver; generated outputs are left in
//      conflict by theirs, with no markers.
//   3. The result is checked against the declarations in the merged tree
//      (cli/merge-driver.mjs, bin/merge-manifest.json): every declared path
//      routed to its driver, records well formed with unique keys, registry
//      keys unique. A source conflict, a record conflict or a duplicate key
//      stops here, before anything is generated, so no output is written
//      from sources that did not merge.
//   4. Each generator whose inputs or outputs both sides changed runs, twice:
//      a failing command, a declared output it did not leave, a write
//      outside its outputs, or a second run that changes anything stops the
//      merge and aborts it. Output identical to either side is valid.
//   5. The merge is committed with its provenance: which generators ran,
//      what each output now matches, and the hash of each generator's log,
//      kept under the clone's Git directory.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkEnv } from "./check-env.mjs";
import { runGroup } from "./group.mjs";
import { GENERATED_DRIVER, MANIFEST_PATH, RECORDS_DRIVER, parseManifest, readRecords } from "./merge-driver.mjs";
import { globToRegExp } from "../src/rules.ts";

export { MANIFEST_PATH, GENERATED_DRIVER, RECORDS_DRIVER };
const DRIVER_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "merge-driver.mjs");
const GENERATOR_TIMEOUT_MS = Number(process.env.ATELIER_GENERATOR_TIMEOUT ?? 20 * 60_000);

// Git as the pipeline runs it by default: local commands only, never a
// prompt. Callers pass their own (the CLI's, with its hooks and identity
// handling); either answers the result with allowFail, else the output.
export function localGit(args, opts = {}) {
  const r = spawnSync("git", args, { cwd: opts.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env }, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (opts.allowFail) return r;
  if (r.error || r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || r.error?.message || "").trim()}`);
  return opts.raw ? r.stdout : r.stdout.trim();
}

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Where a clone keeps its copy of the driver and the generators' logs: under
// its common Git directory, which no merge writes to and every worktree of
// it shares.
export function atelierGitDir(dir, git = localGit) {
  return join(git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir }), "atelier");
}

// The settings a clone needs for the declared drivers, with the driver
// copied to `driver`.
function mergeSettings(driver, node) {
  const run = (kind) => `${quote(node)} ${quote(driver)} ${kind} %O %A %B %P`;
  return [
    [`merge.${GENERATED_DRIVER}.name`, "Atelier generated output: regenerated after the sources merge, never merged as text"],
    [`merge.${GENERATED_DRIVER}.driver`, run("generated")],
    [`merge.${RECORDS_DRIVER}.name`, "Atelier records: united by unique key; conflicting keys, edits and deletions stay in conflict"],
    [`merge.${RECORDS_DRIVER}.driver`, run("records")],
  ];
}

// What the clone at `dir` lacks of its merge configuration: each missing or
// different setting, and the driver copy when it is absent or stale.
export function mergeConfigProblems(dir, { git = localGit, node = process.execPath } = {}) {
  const home = atelierGitDir(dir, git), driver = join(home, "merge-driver.mjs");
  const problems = [];
  if (!existsSync(driver) || !readFileSync(driver).equals(readFileSync(DRIVER_SOURCE))) problems.push(`the merge driver copy ${driver}`);
  for (const [key, value] of mergeSettings(driver, node)) {
    const r = git(["config", "--local", "--get", key], { cwd: dir, allowFail: true });
    if (r.status !== 0 || r.stdout.replace(/\n$/, "") !== value) problems.push(key);
  }
  return problems;
}

// Installs the merge configuration in the clone at `dir`: the driver copied
// into its Git directory and the settings naming it. Idempotent; answers
// what it changed, which is nothing for a clone already set up.
export function installMergeConfig(dir, { git = localGit, node = process.execPath } = {}) {
  const missing = mergeConfigProblems(dir, { git, node });
  if (!missing.length) return [];
  const home = atelierGitDir(dir, git), driver = join(home, "merge-driver.mjs");
  mkdirSync(home, { recursive: true });
  copyFileSync(DRIVER_SOURCE, driver);
  for (const [key, value] of mergeSettings(driver, node)) git(["config", "--local", key, value], { cwd: dir });
  const left = mergeConfigProblems(dir, { git, node });
  if (left.length) throw new Error(`the merge configuration could not be installed in ${dir}: ${left.join(", ")}`);
  return missing;
}

// The declarations a tree holds: the work tree's (`rev` undefined) or a
// revision's. null where the project declares none.
export function readManifest(dir, { git = localGit, rev } = {}) {
  let text;
  if (rev === undefined) {
    const file = join(dir, MANIFEST_PATH);
    if (!existsSync(file)) return null;
    text = readFileSync(file, "utf8");
  } else {
    const r = git(["show", `${rev}:${MANIFEST_PATH}`], { cwd: dir, allowFail: true });
    if (r.status !== 0) return null;
    text = r.stdout;
  }
  return parseManifest(text);
}

const outputsOf = (manifest) => new Set(manifest?.generators.flatMap((g) => g.outputs) ?? []);
const recordPaths = (manifest) => new Set(manifest?.records.map((r) => r.path) ?? []);

// Conflicted paths sorted into the regenerable outputs, the record files
// and the sources a person must resolve.
export function classify(paths, manifest) {
  const outputs = outputsOf(manifest), records = recordPaths(manifest);
  return {
    generated: paths.filter((p) => outputs.has(p)),
    records: paths.filter((p) => records.has(p)),
    source: paths.filter((p) => !outputs.has(p) && !records.has(p)),
  };
}

// Each declared path not routed to its driver in .gitattributes, read as
// Git reads it in `dir`: a path routed elsewhere would be merged as text.
function routingProblems(dir, manifest, git) {
  const want = [...outputsOf(manifest)].map((p) => [p, GENERATED_DRIVER]).concat([...recordPaths(manifest)].map((p) => [p, RECORDS_DRIVER]));
  if (!want.length) return [];
  const r = git(["check-attr", "-z", "merge", "--", ...want.map(([p]) => p)], { cwd: dir, raw: true });
  const parts = r.split("\0"), got = new Map();
  for (let i = 0; i + 2 < parts.length; i += 3) got.set(parts[i], parts[i + 2]);
  return want.filter(([p, driver]) => got.get(p) !== driver).map(([p, driver]) => `${p} is declared in ${MANIFEST_PATH} but .gitattributes routes it to merge=${got.get(p) ?? "unspecified"}, not merge=${driver}`);
}

// The record and registry problems of a tree, read through `read(path)`
// (null for a missing file) and `list(dir)` (the file names in a folder).
// Each is a sentence naming the path.
function declarationProblems(manifest, read, list, skip = new Set()) {
  const problems = [];
  for (const record of manifest?.records ?? []) {
    if (skip.has(record.path)) continue;
    const text = read(record.path);
    if (text === null) continue;
    for (const p of readRecords(text, record.pattern).problems) problems.push(`${record.path}: ${p}`);
  }
  for (const registry of manifest?.registries ?? []) {
    const match = registry.files ? globToRegExp(registry.files) : null;
    const seen = new Map();
    for (const name of list(registry.dir).filter((n) => !match || match.test(n)).sort()) {
      const path = `${registry.dir}/${name}`;
      const key = registry.pattern.exec(read(path) ?? "")?.[1];
      if (!key) problems.push(`${path} names no key for the ${registry.name} registry`);
      else if (seen.has(key)) problems.push(`the ${registry.name} registry key ${key} is declared by both ${seen.get(key)} and ${path}`);
      else seen.set(key, path);
    }
  }
  return problems;
}

const workTreeReader = (dir) => ({
  read: (path) => { try { return readFileSync(join(dir, path), "utf8"); } catch { return null; } },
  list: (folder) => { try { return readdirSync(join(dir, folder), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name); } catch { return []; } },
});

const treeReader = (dir, tree, git) => ({
  read: (path) => { const r = git(["show", `${tree}:${path}`], { cwd: dir, allowFail: true }); return r.status === 0 ? r.stdout : null; },
  list: (folder) => {
    const r = git(["ls-tree", "-z", `${tree}:${folder}`], { cwd: dir, allowFail: true });
    return r.status !== 0 ? [] : r.stdout.split("\0").filter(Boolean).map((line) => line.split("\t")).filter(([meta]) => / blob /.test(meta)).map(([, name]) => name);
  },
});

const changedBetween = (dir, git, from, to) => git(["diff", "--no-renames", "--name-only", "-z", from, to], { cwd: dir, raw: true }).split("\0").filter(Boolean);

// The generators a merge of `ours` and `theirs` must run: those whose
// inputs or outputs both sides changed since their merge base, so the
// merged tree holds a combination neither side generated.
export function generatorsToRun(dir, manifest, ours, theirs, { git = localGit, conflicted = [] } = {}) {
  if (!manifest?.generators.length) return [];
  const base = git(["merge-base", ours, theirs], { cwd: dir, allowFail: true });
  const mb = base.status === 0 ? base.stdout.trim() : null;
  const a = mb ? changedBetween(dir, git, mb, ours) : [], b = mb ? changedBetween(dir, git, mb, theirs) : [];
  return manifest.generators.filter((g) => {
    const inputs = g.inputs.map(globToRegExp);
    const touches = (path) => g.outputs.includes(path) || inputs.some((re) => re.test(path));
    return g.outputs.some((o) => conflicted.includes(o)) || !mb || (a.some(touches) && b.some(touches));
  });
}

// A merge preview: what merging `theirs` into `ours` would leave, without
// touching the index or the work tree. Regenerable outputs are kept apart
// from the source conflicts a person must resolve.
export function previewMerge(dir, ours, theirs, { git = localGit } = {}) {
  installMergeConfig(dir, { git });
  const r = git(["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", ours, theirs], { cwd: dir, allowFail: true });
  if (r.status !== 0 && r.status !== 1) return { error: (r.stderr || r.stdout || "").trim() || `git merge-tree exited ${r.status}` };
  const parts = r.stdout.split("\0"), tree = parts[0], conflicted = [];
  for (const p of parts.slice(1)) { if (!p) break; conflicted.push(p); }
  let manifest = null, problems = [];
  try { manifest = readManifest(dir, { git, rev: tree }); } catch (error) { if (!conflicted.includes(MANIFEST_PATH)) problems.push(error.message); }
  const sorted = classify(conflicted, manifest);
  const reader = treeReader(dir, tree, git);
  problems = problems.concat(declarationProblems(manifest, reader.read, reader.list, new Set(conflicted)));
  const regenerate = generatorsToRun(dir, manifest, ours, theirs, { git, conflicted }).map((g) => g.name);
  return { clean: !sorted.source.length && !sorted.records.length && !problems.length, tree, ...sorted, problems, regenerate };
}

// The text a message shows for a stopped merge or preview: source
// conflicts, record conflicts and declaration problems to resolve, then the
// outputs that will be regenerated once they are.
export function describeConflicts({ source = [], records = [], generated = [], problems = [] }, manifest = null) {
  const lines = [];
  if (source.length) lines.push(`Source conflicts to resolve:\n${source.map((p) => `  ${p}`).join("\n")}`);
  if (records.length) lines.push(`Record files with conflicting keys, edits or deletions:\n${records.map((p) => `  ${p}`).join("\n")}`);
  if (problems.length) lines.push(`Declaration problems:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  if (generated.length) {
    const by = (path) => manifest?.generators.find((g) => g.outputs.includes(path));
    lines.push(`Regenerable outputs, not to be edited by hand (regenerate them once the sources merge):\n${generated.map((p) => `  ${p}${by(p) ? ` (${by(p).command.join(" ")})` : ""}`).join("\n")}`);
  }
  return lines.join("\n");
}

function hashPath(dir, path) {
  const full = join(dir, path);
  let stat;
  try { stat = lstatSync(full); } catch { return "gone"; }
  if (stat.isSymbolicLink()) return `link:${readlinkSync(full)}`;
  if (!stat.isFile()) return "other";
  return createHash("sha256").update(readFileSync(full)).digest("hex");
}

// Every path Git sees as changed or untracked in the work tree, with its
// status and content hash: two snapshots differ exactly where something
// wrote between them.
function snapshot(dir, git) {
  const entries = git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], { cwd: dir, raw: true }).split("\0").filter(Boolean);
  return new Map(entries.map((e) => [e.slice(3), `${e.slice(0, 2)}:${hashPath(dir, e.slice(3))}`]));
}

const differences = (before, after) => [...new Set([...before.keys(), ...after.keys()])].filter((p) => before.get(p) !== after.get(p)).sort();

async function defaultRun(argv, { cwd, env }) {
  return runGroup(argv, { cwd, env, timeoutMs: GENERATOR_TIMEOUT_MS });
}

// One generator, run twice in the merge's work tree. Answers its record,
// or { stop } with the reason the merge cannot go on.
async function regenerate(dir, generator, { git, run, logDir, stamp, ours, theirs }) {
  const before = snapshot(dir, git);
  const log = join(logDir, `${stamp}-${generator.name}.log`);
  const header = `generator: ${generator.name}\ncommand: ${JSON.stringify(generator.command)}\nours: ${ours}\ntheirs: ${theirs}\n`;
  const runs = [];
  let first;
  for (const pass of [1, 2]) {
    const r = await run(generator.command, { cwd: dir, env: checkEnv() });
    runs.push(`--- run ${pass}: ${r.error ? r.error.message : `exit ${r.status}`}\n${r.stdout ?? ""}${r.stderr ?? ""}`);
    writeFileSync(log, `${header}${runs.join("\n")}\n`);
    if (r.error || r.status !== 0) return { stop: `the generator ${generator.name} (${generator.command.join(" ")}) failed on run ${pass} (${r.error ? r.error.message : `exit ${r.status}`}); its log is ${log}`, log };
    const now = snapshot(dir, git);
    if (pass === 1) {
      const wrote = differences(before, now);
      const unexpected = wrote.filter((p) => !generator.outputs.includes(p));
      if (unexpected.length) return { stop: `the generator ${generator.name} wrote outside its declared outputs: ${unexpected.join(", ")}; its log is ${log}`, log };
      const missing = generator.outputs.filter((p) => !existsSync(join(dir, p)));
      if (missing.length) return { stop: `the generator ${generator.name} did not leave its declared outputs ${missing.join(", ")}; its log is ${log}`, log };
      first = now;
    } else {
      const drift = differences(first, now);
      if (drift.length) return { stop: `the generator ${generator.name} is not deterministic: run again on its own output it changed ${drift.join(", ")}; its log is ${log}`, log };
    }
  }
  git(["add", "--", ...generator.outputs], { cwd: dir });
  const blob = (rev, path) => { const r = git(["rev-parse", "--verify", "--quiet", `${rev}:${path}`], { cwd: dir, allowFail: true }); return r.status === 0 ? r.stdout.trim() : null; };
  const outputs = generator.outputs.map((path) => {
    const now = git(["hash-object", "--", path], { cwd: dir });
    return { path, matches: now === blob(ours, path) ? "ours" : now === blob(theirs, path) ? "theirs" : "neither side" };
  });
  const logSha = createHash("sha256").update(readFileSync(log)).digest("hex");
  return { name: generator.name, command: generator.command, outputs, log, logSha };
}

// The message with provenance lines added to its trailer block: before a
// closing Agent line, which stays last, or as a block of their own.
export function withProvenance(message, lines) {
  if (!lines.length) return message;
  const text = message.replace(/\n+$/, "");
  const all = text.split("\n");
  if (/^Agent: /.test(all.at(-1)) && all.length > 1) return [...all.slice(0, -1), ...lines, all.at(-1)].join("\n");
  return `${text}\n\n${lines.join("\n")}`;
}

// The provenance lines of a finished pipeline merge.
export function provenanceLines({ regenerated = [], records = [] }) {
  return [
    ...regenerated.map((g) => `Atelier-Regenerated: ${g.name} (${g.command.join(" ")}): ${g.outputs.map((o) => `${o.path} matches ${o.matches}`).join("; ")}; log sha256 ${g.logSha}`),
    ...records.map((path) => `Atelier-Records-Merged: ${path}, united by key`),
  ];
}

// Merges `target` into the clone at `dir` through the pipeline.
//   message   the merge commit's message; provenance lines are added to it
//   commit    false leaves the finished merge staged and uncommitted
//   leave     true leaves a merge stopped on conflicts in progress, for a
//             person to resolve; false aborts it
//   config    [key, value] settings for the merge and the commit (identity)
//   verify    false commits with --no-verify, as a throwaway merge does
//   generate  false stops a merge that would need a generator to run, as
//             the owner's merge onto the baseline does: outputs written
//             there would never have been checked or reviewed
//   run       how a generator runs (argv, { cwd, env }), as runGroup answers
//   log       a line for the caller's output
// Answers { state } with:
//   "held"       the clone already holds `target`
//   "merged"     merged, regenerated where needed and committed (or staged)
//   "conflicts"  sources, records or declarations need resolving; nothing
//                was generated. { source, records, generated, problems }
//   "stopped"    the merge could not go on (a generator failed, wrote
//                outside its outputs, left one out, was not deterministic;
//                a declaration is misrouted); the merge was aborted.
//   "failed"     Git could not start the merge; { reason }
export async function mergeThrough(dir, target, { git = localGit, message, commit = true, leave = false, verify = true, generate = true, config = [], run = defaultRun, log = () => {} } = {}) {
  installMergeConfig(dir, { git });
  const c = config.flatMap(([k, v]) => ["-c", `${k}=${v}`]);
  const ours = git(["rev-parse", "HEAD"], { cwd: dir });
  const theirs = git(["rev-parse", target], { cwd: dir });
  const r = git([...c, "merge", "--no-ff", "--no-commit", "--no-edit", target], { cwd: dir, allowFail: true });
  const gitDir = git(["rev-parse", "--absolute-git-dir"], { cwd: dir });
  // No merge in progress: Git found `target` already merged, or could not
  // start the merge at all.
  if (!existsSync(join(gitDir, "MERGE_HEAD"))) {
    if (r.status === 0) return { state: "held" };
    git(["merge", "--abort"], { cwd: dir, allowFail: true });
    return { state: "failed", reason: (r.stderr || r.stdout || "").trim() || `git merge exited ${r.status}` };
  }
  const abort = () => { if (git(["merge", "--abort"], { cwd: dir, allowFail: true }).status !== 0) git(["reset", "--hard", ours], { cwd: dir, allowFail: true }); };
  const conflicted = git(["diff", "--name-only", "--diff-filter=U", "-z"], { cwd: dir, raw: true }).split("\0").filter(Boolean);
  let manifest = null;
  const problems = [];
  try { manifest = readManifest(dir, { git }); }
  catch (error) { if (!conflicted.includes(MANIFEST_PATH)) problems.push(error.message); }
  const sorted = classify(conflicted, manifest);
  const routing = manifest ? routingProblems(dir, manifest, git) : [];
  if (routing.length) { abort(); return { state: "stopped", reason: routing.join("; "), ...sorted }; }
  const reader = workTreeReader(dir);
  problems.push(...declarationProblems(manifest, reader.read, reader.list, new Set(conflicted)));
  if (sorted.source.length || sorted.records.length || problems.length) {
    if (!leave) abort();
    return { state: "conflicts", ...sorted, problems, manifest };
  }
  // The sources merged: each conflicted output takes a side to start from
  // (ours, or theirs where ours deleted it), which its generator rewrites.
  for (const path of sorted.generated) {
    if (git(["checkout", "--ours", "--", path], { cwd: dir, allowFail: true }).status !== 0
      && git(["checkout", "--theirs", "--", path], { cwd: dir, allowFail: true }).status !== 0) git(["rm", "--quiet", "--cached", "--ignore-unmatch", "--", path], { cwd: dir });
    else git(["add", "--", path], { cwd: dir });
  }
  const regenerated = [];
  const generators = generatorsToRun(dir, manifest, ours, theirs, { git, conflicted });
  if (generators.length && !generate) {
    abort();
    return { state: "stopped", reason: `the merge needs ${generators.map((g) => g.name).join(", ")} to regenerate ${generators.flatMap((g) => g.outputs).join(", ")}, and this merge runs no generator`, ...sorted, regenerated };
  }
  if (generators.length) {
    const logDir = join(atelierGitDir(dir, git), "merge-logs");
    mkdirSync(logDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (const generator of generators) {
      log(`Regenerating ${generator.outputs.join(", ")} with ${generator.command.join(" ")} (${generator.name})…`);
      const done = await regenerate(dir, generator, { git, run, logDir, stamp, ours, theirs });
      if (done.stop) { abort(); return { state: "stopped", reason: done.stop, ...sorted, regenerated }; }
      regenerated.push(done);
    }
  }
  if (git(["diff", "--name-only", "--diff-filter=U"], { cwd: dir })) { abort(); return { state: "stopped", reason: "paths were still unmerged after regeneration", ...sorted, regenerated }; }
  // The record files both sides changed: those the records driver united.
  const based = git(["merge-base", ours, theirs], { cwd: dir, allowFail: true });
  const mb = based.status === 0 ? based.stdout.trim() : null;
  const a = mb ? changedBetween(dir, git, mb, ours) : [], b = mb ? changedBetween(dir, git, mb, theirs) : [];
  const records = (manifest?.records ?? []).map((rec) => rec.path).filter((path) => a.includes(path) && b.includes(path));
  const lines = provenanceLines({ regenerated, records });
  const result = { state: "merged", ours, theirs, regenerated, records, generated: sorted.generated, provenance: lines, manifest };
  if (!commit) return result;
  git([...c, "commit", "--quiet", ...(verify ? [] : ["--no-verify"]), "-m", withProvenance(message ?? `Merge ${theirs}`, lines)], { cwd: dir });
  return { ...result, head: git(["rev-parse", "HEAD"], { cwd: dir }) };
}
