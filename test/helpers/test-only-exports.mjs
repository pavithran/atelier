// The static check for logic only tests call (t534). PAVI, 2026-11-07: of 65
// blocking findings in astra's rejections of t512-t528, 18 were functions
// that exist but no production code calls (t521's dispatchBuilder, io.wake
// and io.readItem, t524's guardLanding and revertOnMain, t513's wake
// predicate). Each cost a review round. This finds every function exported
// from src/ or cli/ whose only references are in test files.
//
// It reads names, not types: a name counts as referenced when it appears as
// an identifier, outside comments and outside its own declaration, in any
// non-test file under src/, cli/ or bin/. A call, a re-export, an entry in an
// object of handlers and an import all show up that way. A different
// function of the same name elsewhere hides an offender, so the check errs
// toward passing; it never fails a function production code uses.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { discover } from "../suites.mjs";

const SOURCE_DIRS = ["src", "cli", "bin"];
const EXPORTING = /\.(mjs|js|ts|mts|cjs|cts|tsx|jsx)$/;
const TEST_FILE = /\.(test|spec)\.(js|jsx|ts|tsx|mjs|mts|cjs|cts)$/;
const MAX_BYTES = 2_000_000;

function sourceFiles(root, rel) {
  const found = [];
  let entries;
  try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    const path = `${rel}/${entry.name}`;
    if (entry.isDirectory()) { if (entry.name !== "node_modules" && entry.name !== ".git") found.push(...sourceFiles(root, path)); }
    else if (entry.isFile() && !TEST_FILE.test(entry.name)) found.push(path);
  }
  return found;
}

const read = (root, file) => {
  try { return statSync(join(root, file)).size > MAX_BYTES ? "" : readFileSync(join(root, file), "utf8"); } catch { return ""; }
};

// Block and line comments out; a // after a colon is left, as in a URL.
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\'"`])\/\/[^\n]*/g, "$1");

const IDENT = /[A-Za-z_$][\w$]*/g;
const countIdents = (text) => {
  const counts = new Map();
  for (const [name] of text.matchAll(IDENT)) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
};

// The functions a file exports, each with how many times its own text names
// it in declaring it (what is not a use): `export function f` names f once;
// `function f` with `export { f }` names it twice.
export function exportedFunctions(text) {
  const code = stripComments(text), found = new Map();
  const add = (name, declared) => { if (!found.has(name)) found.set(name, declared); };
  for (const m of code.matchAll(/(?:^|[\n;}])\s*export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) add(m[1], 1);
  for (const m of code.matchAll(/(?:^|[\n;}])\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=\n]+)?=>|[A-Za-z_$][\w$]*\s*=>)/g)) add(m[1], 1);
  for (const list of code.matchAll(/(?:^|[\n;}])\s*export\s*\{([^}]*)\}\s*(?!from\b)/g)) {
    for (const part of list[1].split(",")) {
      const m = /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+[A-Za-z_$][\w$]*)?\s*$/.exec(part);
      if (!m) continue;
      const local = m[1];
      const declaration = new RegExp(`(?:^|[\\n;}])\\s*(?:async\\s+)?function\\s*\\*?\\s*${local.replace(/\$/g, "\\$")}\\b|(?:^|[\\n;}])\\s*(?:const|let|var)\\s+${local.replace(/\$/g, "\\$")}\\s*(?::[^=\\n]+)?=\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*(?::[^=\\n]+)?=>|[A-Za-z_$][\\w$]*\\s*=>)`);
      if (declaration.test(code)) add(local, 2);
    }
  }
  return found;
}

// [{ file, name }] sorted, for the repository at root.
export function testOnlyExports(root) {
  const production = sourceFiles(root, SOURCE_DIRS[0]).concat(...SOURCE_DIRS.slice(1).map((d) => sourceFiles(root, d)));
  const prodCounts = new Map(), exportsOf = new Map();
  for (const file of production) {
    const raw = read(root, file);
    if (!raw) continue;
    const code = stripComments(raw);
    prodCounts.set(file, countIdents(code));
    if (/^(src|cli)\//.test(file) && EXPORTING.test(file)) exportsOf.set(file, exportedFunctions(raw));
  }
  const testCounts = new Map();
  for (const file of discover(root)) for (const [name, n] of countIdents(stripComments(read(root, file)))) testCounts.set(name, (testCounts.get(name) ?? 0) + n);

  const offenders = [];
  for (const [file, names] of exportsOf) {
    for (const [name, declared] of names) {
      let uses = -declared;
      for (const counts of prodCounts.values()) uses += counts.get(name) ?? 0;
      if (uses <= 0 && (testCounts.get(name) ?? 0) > 0) offenders.push({ file, name });
    }
  }
  return offenders.sort((a, b) => (a.file + a.name).localeCompare(b.file + b.name));
}

// The baseline, one entry per line: file:name, then why it is allowed. Blank
// lines and lines starting with # are notes.
export function parseBaseline(text) {
  const problems = [], entries = [], seen = new Map();
  for (const [n, line] of String(text).split("\n").entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const at = n + 1;
    const m = /^(\S+?):([A-Za-z_$][\w$]*)(?:\s+(\S.*))?$/.exec(trimmed);
    if (!m) { problems.push(`line ${at}: ${trimmed}: write file:function, then why it is allowed`); continue; }
    const [, file, name, reason] = m;
    if (!reason) { problems.push(`line ${at}: ${file}:${name}: write why it is allowed`); continue; }
    if (seen.has(`${file}:${name}`)) { problems.push(`line ${at}: ${file}:${name}: listed twice (line ${seen.get(`${file}:${name}`)})`); continue; }
    seen.set(`${file}:${name}`, at);
    entries.push({ at, file, name, reason });
  }
  return { entries, problems };
}

// What the check refuses, as lines: a new offender, a malformed entry, and an
// entry for a function that is gone or now has a production caller.
export function checkTestOnlyExports(root, baselineText) {
  const { entries, problems } = parseBaseline(baselineText);
  const offenders = testOnlyExports(root);
  const now = new Set(offenders.map((o) => `${o.file}:${o.name}`));
  const allowed = new Set(entries.map((e) => `${e.file}:${e.name}`));
  const out = [...problems];
  for (const { file, name } of offenders) {
    if (!allowed.has(`${file}:${name}`)) out.push(`${file}: ${name} is exported but only test files reference it; call it from production code, or delete it`);
  }
  for (const { at, file, name } of entries) {
    if (now.has(`${file}:${name}`)) continue;
    const text = read(root, file);
    out.push(text && exportedFunctions(text).has(name)
      ? `test/test-only-exports.txt line ${at}: ${file}:${name}: no longer test-only; remove the entry`
      : `test/test-only-exports.txt line ${at}: ${file}:${name}: no such exported function; remove the entry`);
  }
  return out;
}
