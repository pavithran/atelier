// Which runner runs which test file (t466). npm test (run.mjs) used to name
// its node --test files by glob, test/**, so a test file anywhere else, as
// under cli/, was never run by the checks. Discovery here walks the tree for
// every test file by name, whatever the runners' own patterns are, and
// assigns each to exactly one runner. A file no runner owns, or that several
// own, is rejected before anything runs, so no file is silently skipped or run
// twice. Atelier 2.0 (task 7) has one runner, node --test, which owns the
// *.test.* and *.spec.* files in .mjs and .ts; the Workers pool that ran the
// .spec files under Vitest is gone with Workers.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

// Every name that looks like a test file, so a misnamed one (x.test.js, say)
// is found and rejected rather than ignored.
const TEST_FILE = /\.(test|spec)\.(js|jsx|ts|tsx|mjs|mts|cjs|cts)$/;
const SKIPPED_DIRS = new Set(["node_modules"]);

export const NODE_RUNNER = { name: "node", owns: (file) => /\.(test|spec)\.(mjs|ts)$/.test(file) };

// No suite is collected or executed while assigning. A root reached through
// a symlink (macOS's /var, say) is resolved first, so the paths are the
// real tree's (t658).
export async function plan(root = ".") {
  root = realpathSync(resolve(root));
  return assign(discover(root), [NODE_RUNNER]);
}

// Every test file under root, as slash-separated paths relative to it, sorted.
// In a git work tree the list is git's own (tracked files, plus untracked ones
// not ignored, so a new file is found before it is committed), dot-directories
// included. Elsewhere the tree is walked. Either way only node_modules is excluded.
export function discover(root = ".") {
  const listed = spawnSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 1 << 28 });
  const inRepo = listed.status === 0 && existsSync(join(root, ".git"));
  const files = inRepo ? listed.stdout.split("\0").filter((f) => f && existsSync(join(root, f))) : walk(root, "");
  return files.filter((f) => !f.split("/").some((part) => SKIPPED_DIRS.has(part)) && TEST_FILE.test(f.slice(f.lastIndexOf("/") + 1))).sort();
}

function walk(root, rel) {
  const found = [];
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { if (entry.name !== ".git" && !SKIPPED_DIRS.has(entry.name)) found.push(...walk(root, path)); }
    else if (TEST_FILE.test(entry.name)) found.push(path);
  }
  return found;
}

// { byRunner: {name: [files]}, unassigned: [files], multiple: [{file, runners}] }
export function assign(files, runners) {
  const byRunner = Object.fromEntries(runners.map((r) => [r.name, []]));
  const unassigned = [], multiple = [];
  for (const file of files) {
    const owners = runners.filter((r) => r.owns(file));
    if (owners.length === 0) unassigned.push(file);
    else if (owners.length > 1) multiple.push({ file, runners: owners.map((r) => r.name) });
    else byRunner[owners[0].name].push(file);
  }
  return { byRunner, unassigned, multiple };
}

// The lines that name each rejected path; empty when every file has one runner.
export function rejections({ unassigned, multiple }) {
  return [
    ...unassigned.map((file) => `${file}: no runner runs this test file`),
    ...multiple.map(({ file, runners }) => `${file}: owned by more than one runner (${runners.join(", ")})`),
  ];
}

// The timing list (test/timings.txt, t771): one "path seconds" per line, how
// long a file's tests took in a run that measured it; blank lines and lines
// starting with # are notes. Only the slow files are listed, and nothing
// refreshes it: a file missing from it, or a line that does not parse, is
// simply an unlisted file.
export function parseTimings(text) {
  const timings = new Map();
  for (const line of String(text).split("\n")) {
    const m = /^(\S+)\s+(\d+(?:\.\d+)?)\s*$/.exec(line);
    if (m) timings.set(m[1], Number(m[2]));
  }
  return timings;
}

// Longest first, so the files that end a run start at once. Unlisted files
// come before the listed ones, in the order given: a new file may be slow,
// and the list does not know it yet. Files that tie keep their order.
export function longestFirst(files, timings) {
  const unlisted = files.filter((f) => !timings.has(f));
  const listed = files.filter((f) => timings.has(f)).sort((a, b) => timings.get(b) - timings.get(a));
  return [...unlisted, ...listed];
}
