// The static check for logic only tests call (t534). PAVI, 2026-11-07: of 65
// blocking findings in astra's rejections of t512-t528, 18 were functions
// that exist but no production code calls (t521's dispatchBuilder, io.wake
// and io.readItem, t524's guardLanding and revertOnMain, t513's wake
// predicate). Each cost a review round. This finds every function exported
// from src/ or cli/ whose only references are in test files.
//
// It reads names, not types: a name counts as referenced when it appears as
// an identifier, outside comments, strings and its own declaration, in any
// non-test file under src/, cli/ or bin/. A call, a re-export, an entry in an
// object of handlers and an import all show up that way. A file that declares its own name is
// not counted, since that is a different function.
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

// Comments out, and the inside of strings and template text out, so a name in
// prose or a message is not a reference. Code inside a template's ${ } stays.
// A / starting a regular expression is skipped as one, so a quote inside it
// does not open a string. Unterminated quotes end at the line.
const REGEX_AFTER = /[(,=:[!&|?{};+\-*%<>~^]$|(?:^|[^\w$.])(?:return|typeof|case|in|of|void|delete|throw|else|do)$/;
const PLAIN = /[^"'`\/{}]+/y;
export function stripNonCode(text) {
  let i = 0;
  const run = (closer) => {
    let out = "", tail = "", depth = 0;
    const emit = (x) => { out += x; tail = (tail + x).trimEnd().slice(-12); };
    while (i < text.length) {
      PLAIN.lastIndex = i;
      const plain = PLAIN.exec(text);
      if (plain) { emit(plain[0]); i += plain[0].length; continue; }
      const c = text[i], next = text[i + 1];
      if (closer === "}" && c === "}" && depth === 0) { i++; return out; }
      if (c === "/" && next === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
      if (c === "/" && next === "*") { const end = text.indexOf("*/", i + 2); i = end < 0 ? text.length : end + 2; emit(" "); continue; }
      if (c === '"' || c === "'") {
        i++;
        while (i < text.length && text[i] !== c && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
        if (text[i] === c) i++;
        emit(c + c); continue;
      }
      if (c === "`") {
        i++; emit("``");
        while (i < text.length && text[i] !== "`") {
          if (text[i] === "\\") i += 2;
          else if (text[i] === "$" && text[i + 1] === "{") { i += 2; emit(" " + run("}") + " "); }
          else i++;
        }
        i++; continue;
      }
      if (c === "/" && (tail === "" || REGEX_AFTER.test(tail))) {
        let j = i + 1, inClass = false;
        while (j < text.length && text[j] !== "\n" && (inClass || text[j] !== "/")) {
          if (text[j] === "\\") j++; else if (text[j] === "[") inClass = true; else if (text[j] === "]") inClass = false;
          j++;
        }
        if (text[j] === "/") { i = j + 1; emit("/ /"); continue; }
      }
      if (c === "{") depth++;
      if (c === "}") depth--;
      emit(c); i++;
    }
    return out;
  };
  return run(null);
}

const IDENT = /[A-Za-z_$][\w$]*/g;
const countIdents = (text) => {
  const counts = new Map();
  for (const [name] of text.matchAll(IDENT)) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
};
const escape = (name) => name.replace(/\$/g, "\\$");

// What follows `name =` for a function value: function, or an arrow with
// optional async, generics, parameters and return type.
const FN_VALUE = String.raw`(?:async\s*)?(?:function\b|(?:<[^(]*?>\s*)?\([^)]*\)\s*(?::[^=\n]+)?=>|[A-Za-z_$][\w$]*\s*=>)`;
const START = String.raw`(?:^|[\n;}])\s*`;

// The functions a file exports, each with how many times its own text names
// it in declaring it (what is not a use): `export function f` names f once;
// `function f` with `export { f }` names it twice.
export function exportedFunctions(text) {
  const code = stripNonCode(text), found = new Map();
  const add = (name, declared) => { if (!found.has(name)) found.set(name, declared); };
  for (const m of code.matchAll(new RegExp(`${START}export\\s+(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*([A-Za-z_$][\\w$]*)`, "g"))) add(m[1], 1);
  for (const m of code.matchAll(new RegExp(`${START}export\\s+(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=\\n]+)?=\\s*${FN_VALUE}`, "g"))) add(m[1], 1);
  for (const list of code.matchAll(/(?:^|[\n;}])\s*export\s*\{([^}]*)\}\s*(?!from\b)/g)) {
    for (const part of list[1].split(",")) {
      const m = /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+[A-Za-z_$][\w$]*)?\s*$/.exec(part);
      if (!m) continue;
      const local = m[1];
      if (declaresFunction(code, local)) add(local, 2);
    }
  }
  return found;
}

// The name of the function a file exports as its default, or null. Another
// file may import it under any name, so it counts as used when a production
// file default-imports this one by path (see defaultImports).
export const defaultExportName = (text) => defaultNameOf(stripNonCode(text));
const defaultNameOf = (code) => /(?:^|[\n;}])\s*export\s+default\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(code)?.[1] ?? null;
const stem = (file) => file.replace(/^.*\//, "").replace(/\.[^.]+$/, "");
const defaultImports = (raw, file) => new RegExp(`import\\s+[A-Za-z_$][\\w$]*\\s*(?:,\\s*\\{[^}]*\\}\\s*)?from\\s*["'][^"']*\\/${stem(file).replace(/[.$]/g, "\\$&")}(?:\\.\\w+)?["']`).test(raw);

// Whether code (already stripped) declares a function named name, exported or not.
const declaresFunction = (code, name) => new RegExp(`${START}(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?function\\s*\\*?\\s*${escape(name)}\\b|${START}(?:export\\s+)?(?:const|let|var)\\s+${escape(name)}\\s*(?::[^=\\n]+)?=\\s*${FN_VALUE}`).test(code);
// Every name a file declares as a function, class, variable or enum.
const declaredNames = (code) => new Set(Array.from(code.matchAll(/(?:^|[\n;}{(,])\s*(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/g), (m) => m[1]));

// [{ file, name }] sorted, for the repository at root.
export function testOnlyExports(root) {
  const production = sourceFiles(root, SOURCE_DIRS[0]).concat(...SOURCE_DIRS.slice(1).map((d) => sourceFiles(root, d)));
  const prodCounts = new Map(), prodRaw = new Map(), declaredIn = new Map(), defaults = new Map(), exportsOf = new Map();
  for (const file of production) {
    const raw = read(root, file);
    if (!raw) continue;
    const code = stripNonCode(raw);
    declaredIn.set(file, declaredNames(code));
    defaults.set(file, defaultNameOf(code));
    prodRaw.set(file, raw);
    prodCounts.set(file, countIdents(code));
    if (/^(src|cli)\//.test(file) && EXPORTING.test(file)) exportsOf.set(file, exportedFunctions(raw));
  }
  const testCounts = new Map();
  for (const file of discover(root)) for (const [name, n] of countIdents(stripNonCode(read(root, file)))) testCounts.set(name, (testCounts.get(name) ?? 0) + n);

  const offenders = [];
  for (const [file, names] of exportsOf) {
    for (const [name, declared] of names) {
      // Its own file: uses beyond the declaration. Other files count only when
      // they do not declare a name of their own, which is another function.
      let uses = (prodCounts.get(file).get(name) ?? 0) - declared;
      for (const [other, counts] of prodCounts) {
        if (other !== file && (counts.get(name) ?? 0) > 0 && !declaredIn.get(other).has(name)) uses += counts.get(name);
      }
      if (name === defaults.get(file)) {
        for (const [other, raw] of prodRaw) if (other !== file && defaultImports(raw, file)) uses++;
      }
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
