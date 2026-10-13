// Mechanical conflict resolution (t462): which conflicts a refresh may
// resolve without the task's builder, defined by the transformations below
// and nothing else, and the report a conflict outside them goes back to the
// builder with.
//
// A refresh merges main into a task's head with git's diff3 conflict style,
// so each conflicted hunk shows the task's side ("ours"), the merge base and
// main's side ("theirs"). Each hunk is classified alone:
//
//   mechanical   one of TRANSFORMATIONS applies to it, and its resolution is
//                fixed by that transformation (up to the order of added
//                imports, for import-union);
//   behavioural  both sides changed the same lines differently, and no
//                transformation applies: resolving it means deciding what
//                the code should do, which is the builder's work;
//   uncertain    the conflict cannot be read as a three-way hunk: no merge
//                base section (another conflict style), markers that do not
//                nest or close, a binary file, a file one side deleted or
//                renamed, or more than the limits below.
//
// A file is as bad as its worst hunk, and a refresh as bad as its worst
// file. Only a refresh whose every hunk is mechanical goes to a resolver;
// a behavioural or uncertain one goes back to the builder with the merge
// base, both heads, the paths and the hunks (conflictReport).
//
// A resolver's work is not trusted: verifyResolution compares each file the
// resolver wrote with the conflicted file, and passes it only when every
// context line stands as it was and every hunk holds exactly a resolution
// its transformation allows. Anything else is not mechanical, and goes back
// to the builder. The fixtures under src/refresh/fixtures/ are the
// documented examples, one per transformation and per kind refused.

export interface Transformation {
  id: "same-change" | "one-sided" | "whitespace" | "import-union";
  rule: string;
}

export const TRANSFORMATIONS: readonly Transformation[] = [
  { id: "same-change", rule: "Both sides made the same change to the base: the hunk becomes that change." },
  { id: "one-sided", rule: "One side left the base exactly as it was: the hunk becomes the other side." },
  { id: "whitespace", rule: "One side changed only trailing whitespace or blank lines, never indentation or text: the hunk becomes the other side." },
  { id: "import-union", rule: "Both sides kept every base line, in order, and added only single-line JavaScript or TypeScript import or export-from statements, with no name brought in by both sides from different statements: the hunk becomes the base lines with every added statement once, the base lines in their order and the added ones anywhere among them." },
];

export type ConflictKind = "mechanical" | "behavioural" | "uncertain";

export interface Hunk {
  line: number;               // where the hunk's <<<<<<< marker is, 1-based
  ours: string[];
  base: string[] | null;      // null when the conflict style shows no base
  theirs: string[];
}

export interface ClassifiedHunk extends Hunk {
  kind: ConflictKind;
  transformation?: Transformation["id"];
  why: string;
}

export interface ConflictFile {
  path: string;
  kind: ConflictKind;
  why: string;
  hunks: ClassifiedHunk[];
}

// What git left for one conflicted path: the file's text with markers, or
// null when it is not text git could mark (a binary file), and which stages
// the index holds (1 base, 2 ours, 3 theirs), so a file one side deleted is
// known.
export interface ConflictInput {
  path: string;
  text: string | null;
  stages: number[];
}

// The report a conflict outside the transformations goes back to the builder
// with: the merge base, the task's head, main's head, and each path with its
// hunks, cut to REPORT_LIMITS.
export interface ConflictReport {
  base: string;
  head: string;
  main: string;
  kind: ConflictKind;
  files: { path: string; kind: ConflictKind; why: string; hunks: { line: number; kind: ConflictKind; why: string; ours: string[]; base: string[] | null; theirs: string[] }[] }[];
  cut?: boolean;
}

export const LIMITS = { hunks: 200, hunkLines: 400 };
export const REPORT_LIMITS = { files: 40, hunks: 40, lines: 80, chars: 60_000 };

const OPEN = /^<{7}(?: |$)/, BASE = /^\|{7}(?: |$)/, SPLIT = /^={7}$/, CLOSE = /^>{7}(?: |$)/;

// A conflicted file as context and hunks, in order: `parts` alternate
// context line runs and hunks. A malformed file names its fault.
export function parseConflicts(text: string): { parts: (string[] | Hunk)[]; finalNewline: boolean } | { error: string } {
  const finalNewline = text.endsWith("\n");
  const lines = (finalNewline ? text.slice(0, -1) : text).split("\n").map((l) => l.replace(/\r$/, ""));
  const parts: (string[] | Hunk)[] = [];
  let context: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!OPEN.test(lines[i])) {
      if (BASE.test(lines[i]) || SPLIT.test(lines[i]) || CLOSE.test(lines[i])) return { error: `a conflict marker at line ${i + 1} stands outside any conflict` };
      context.push(lines[i]);
      continue;
    }
    const start = i + 1;
    const ours: string[] = [], theirs: string[] = [];
    let base: string[] | null = null;
    let side: "ours" | "base" | "theirs" = "ours";
    let closed = false;
    for (i++; i < lines.length; i++) {
      const l = lines[i];
      if (OPEN.test(l)) return { error: `a conflict opens inside the conflict at line ${start}` };
      if (BASE.test(l)) { if (side !== "ours") return { error: `the conflict at line ${start} has its base section out of place` }; side = "base"; base = []; continue; }
      if (SPLIT.test(l)) { if (side === "theirs") return { error: `the conflict at line ${start} is split twice` }; side = "theirs"; continue; }
      if (CLOSE.test(l)) { if (side !== "theirs") return { error: `the conflict at line ${start} closes before main's side` }; closed = true; break; }
      (side === "ours" ? ours : side === "base" ? base! : theirs).push(l);
    }
    if (!closed) return { error: `the conflict at line ${start} never closes` };
    parts.push(context, { line: start, ours, base, theirs });
    context = [];
  }
  parts.push(context);
  return { parts, finalNewline };
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const loose = (l: readonly string[]) => l.map((x) => x.replace(/\s+$/, "")).filter((x) => x !== "");

// A single-line import or export-from statement, and the names it brings
// into scope (or re-exports); a bare `import "x";` brings none.
const IMPORT = /^\s*(?:import\s+(?:type\s+)?(.+?)\s+from\s+|export\s+(?:type\s+)?(.+?)\s+from\s+|import\s+)(["'])[^"'\n]+\3\s*;?\s*$/;
export function importNames(line: string): string[] | null {
  const m = IMPORT.exec(line);
  if (!m) return null;
  const clause = m[1] ?? m[2];
  if (!clause) return [];
  return clause.replace(/[{}]/g, ",").split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const alias = /^(?:type\s+)?\S+\s+as\s+(\S+)$/.exec(s);
    return alias ? alias[1] : s.replace(/^type\s+/, "");
  });
}

// The lines `side` adds to `base`, when it keeps every base line in order
// and only adds; null when it removes or changes one.
function additions(base: readonly string[], side: readonly string[]): string[] | null {
  const added: string[] = [];
  let b = 0;
  for (const line of side) {
    if (b < base.length && line === base[b]) b++;
    else added.push(line);
  }
  return b === base.length ? added : null;
}

function importUnion(h: Hunk & { base: string[] }): { added: string[]; why: null } | { added: null; why: string } {
  const ours = additions(h.base, h.ours), theirs = additions(h.base, h.theirs);
  if (!ours || !theirs) return { added: null, why: "a side removed or changed a base line" };
  const all = [...ours, ...theirs];
  if (!all.length) return { added: null, why: "neither side added a line" };
  const bad = all.find((l) => importNames(l) === null);
  if (bad !== undefined) return { added: null, why: `an added line is not a single-line import: ${JSON.stringify(bad.slice(0, 120))}` };
  const unique = [...new Set(all)];
  // A name brought in by two different statements would be declared twice,
  // or from two places: which one the code means is a behavioural question.
  const from = new Map<string, string>();
  for (const line of [...h.base, ...unique]) {
    for (const name of importNames(line) ?? []) {
      const prior = from.get(name);
      if (prior !== undefined && prior !== line) return { added: null, why: `both sides bring in ${name}, from different statements` };
      from.set(name, line);
    }
  }
  return { added: [...ours, ...theirs.filter((l) => !ours.includes(l))].filter((l, i, a) => a.indexOf(l) === i), why: null };
}

// One hunk classified: the transformation that resolves it, or why none does.
export function classifyHunk(h: Hunk): ClassifiedHunk {
  if (h.base === null) return { ...h, kind: "uncertain", why: "the conflict shows no merge base, so what each side changed cannot be told" };
  if (Math.max(h.ours.length, h.base.length, h.theirs.length) > LIMITS.hunkLines) return { ...h, kind: "uncertain", why: `the hunk is over ${LIMITS.hunkLines} lines` };
  if (same(h.ours, h.theirs)) return { ...h, kind: "mechanical", transformation: "same-change", why: "both sides made the same change" };
  if (same(h.ours, h.base)) return { ...h, kind: "mechanical", transformation: "one-sided", why: "the task left these lines as they were; main's side is taken" };
  if (same(h.theirs, h.base)) return { ...h, kind: "mechanical", transformation: "one-sided", why: "main left these lines as they were; the task's side is taken" };
  if (same(loose(h.ours), loose(h.base))) return { ...h, kind: "mechanical", transformation: "whitespace", why: "the task changed only trailing whitespace or blank lines here; main's side is taken" };
  if (same(loose(h.theirs), loose(h.base))) return { ...h, kind: "mechanical", transformation: "whitespace", why: "main changed only trailing whitespace or blank lines here; the task's side is taken" };
  const union = importUnion(h as Hunk & { base: string[] });
  if (union.added) return { ...h, kind: "mechanical", transformation: "import-union", why: "both sides only added imports" };
  return { ...h, kind: "behavioural", why: `both sides changed these lines differently (${union.why})` };
}

const WORST: Record<ConflictKind, number> = { mechanical: 0, behavioural: 1, uncertain: 2 };
export const worst = (kinds: ConflictKind[]): ConflictKind => kinds.reduce<ConflictKind>((a, b) => (WORST[b] > WORST[a] ? b : a), "mechanical");

export function classifyFile(input: ConflictInput): ConflictFile {
  const { path } = input;
  const uncertain = (why: string): ConflictFile => ({ path, kind: "uncertain", why, hunks: [] });
  if (!input.stages.includes(2) || !input.stages.includes(3)) return uncertain(input.stages.includes(2) ? "main deleted or renamed the file the task changed" : "the task deleted or renamed the file main changed");
  if (input.text === null || input.text.includes("\0")) return uncertain("the file is not text git can mark");
  const parsed = parseConflicts(input.text);
  if ("error" in parsed) return uncertain(parsed.error);
  const hunks = parsed.parts.filter((p): p is Hunk => !Array.isArray(p)).map(classifyHunk);
  if (!hunks.length) return uncertain("git reports a conflict, but the file holds no conflict markers");
  if (hunks.length > LIMITS.hunks) return uncertain(`the file has over ${LIMITS.hunks} conflicts`);
  const kind = worst(hunks.map((h) => h.kind));
  const why = kind === "mechanical" ? `${hunks.length} hunk${hunks.length === 1 ? "" : "s"}, each ${[...new Set(hunks.map((h) => h.transformation))].join(" or ")}` : hunks.find((h) => h.kind === kind)!.why;
  return { path, kind, why, hunks };
}

// Every conflicted file classified, and the refresh's kind: its worst file's.
export function classifyConflicts(inputs: ConflictInput[]): { kind: ConflictKind; files: ConflictFile[] } {
  const files = inputs.map(classifyFile);
  return { kind: files.length ? worst(files.map((f) => f.kind)) : "uncertain", files };
}

// The resolution each transformation fixes: for import-union, the task's
// side then main's added statements, one order of the several it allows.
export function resolveHunk(h: ClassifiedHunk): string[] | null {
  if (h.kind !== "mechanical") return null;
  switch (h.transformation) {
    case "same-change": return h.ours;
    case "one-sided": return same(h.ours, h.base ?? []) ? h.theirs : h.ours;
    case "whitespace": return same(loose(h.ours), loose(h.base ?? [])) ? h.theirs : h.ours;
    case "import-union": {
      const u = importUnion(h as Hunk & { base: string[] });
      return u.added ? [...h.ours, ...u.added.filter((l) => !h.ours.includes(l))] : null;
    }
    default: return null;
  }
}

// The mechanical resolution of a whole file, or null when a hunk is not mechanical.
export function resolveFile(text: string): string | null {
  const parsed = parseConflicts(text);
  if ("error" in parsed) return null;
  const out: string[] = [];
  for (const part of parsed.parts) {
    if (Array.isArray(part)) { out.push(...part); continue; }
    const r = resolveHunk(classifyHunk(part));
    if (!r) return null;
    out.push(...r);
  }
  return out.join("\n") + (parsed.finalNewline ? "\n" : "");
}

// Whether `resolved`, as a resolver wrote it, is a resolution of
// `conflicted` the transformations allow: every context line as it was, and
// each hunk replaced by exactly what its transformation fixes, or for an
// import union by the same lines in another order that keeps the base lines
// in theirs. Null when it is; otherwise what is wrong, first fault only.
export function verifyResolution(conflicted: string, resolved: string): string | null {
  const parsed = parseConflicts(conflicted);
  if ("error" in parsed) return `the conflicted file cannot be read: ${parsed.error}`;
  const hunks = parsed.parts.filter((p): p is Hunk => !Array.isArray(p)).map(classifyHunk);
  const odd = hunks.find((h) => h.kind !== "mechanical");
  if (odd) return `the conflict at line ${odd.line} is ${odd.kind}: ${odd.why}`;
  const finalNewline = resolved.endsWith("\n");
  if (finalNewline !== parsed.finalNewline) return parsed.finalNewline ? "the file lost its final newline" : "the file gained a final newline";
  const lines = (finalNewline ? resolved.slice(0, -1) : resolved).split("\n");
  // Each part's length is fixed: context as it was, and a hunk as long as
  // its resolution, so the resolved file is cut where each part lies.
  let at = 0, k = 0;
  for (const part of parsed.parts) {
    if (Array.isArray(part)) {
      const got = lines.slice(at, at + part.length);
      const bad = part.findIndex((l, i) => got[i] !== l);
      if (bad !== -1) return `line ${at + bad + 1} should be the context line ${JSON.stringify(part[bad].slice(0, 120))}, which a resolution never changes`;
      at += part.length;
      continue;
    }
    const h = hunks[k++];
    const want = resolveHunk(h)!;
    const got = lines.slice(at, at + want.length);
    if (h.transformation === "import-union") {
      const sorted = (l: string[]) => [...l].sort();
      if (!same(sorted(got), sorted(want)) || additions(h.base ?? [], got) === null) {
        return `the conflict at line ${h.line} (import-union) should hold the base lines in order and each added import once, and nothing else`;
      }
    } else if (!same(got, want)) {
      return `the conflict at line ${h.line} (${h.transformation}) should become ${want.length} line${want.length === 1 ? "" : "s"} exactly: ${h.why}`;
    }
    at += want.length;
  }
  if (at !== lines.length) return `the file has ${lines.length - at} line${lines.length - at === 1 ? "" : "s"} more than its resolution allows`;
  return null;
}

// The report a conflict goes back to the builder with, cut to REPORT_LIMITS.
export function conflictReport(input: { base: string; head: string; main: string }, files: ConflictFile[]): ConflictReport {
  let cut = files.length > REPORT_LIMITS.files;
  const take = (l: string[] | null) => {
    if (!l) return l;
    if (l.length > REPORT_LIMITS.lines) cut = true;
    return l.slice(0, REPORT_LIMITS.lines).map((x) => x.slice(0, 400));
  };
  const report: ConflictReport = {
    ...input, kind: files.length ? worst(files.map((f) => f.kind)) : "uncertain",
    files: files.slice(0, REPORT_LIMITS.files).map((f) => {
      if (f.hunks.length > REPORT_LIMITS.hunks) cut = true;
      return { path: f.path, kind: f.kind, why: f.why, hunks: f.hunks.slice(0, REPORT_LIMITS.hunks).map((h) => ({ line: h.line, kind: h.kind, why: h.why, ours: take(h.ours)!, base: take(h.base), theirs: take(h.theirs)! })) };
    }),
  };
  // Whole hunks are dropped from the end until the report fits.
  while (JSON.stringify(report).length > REPORT_LIMITS.chars) {
    cut = true;
    const f = report.files.at(-1);
    if (!f) break;
    if (f.hunks.length > 1) f.hunks.pop(); else if (report.files.length > 1) report.files.pop(); else { f.hunks = []; break; }
  }
  return cut ? { ...report, cut: true } : report;
}

// A report as the Ledger accepts it from a runner: the shape above, its
// hashes full, within REPORT_LIMITS. Anything else is refused.
export function parseReport(value: unknown): ConflictReport | string {
  const v = value as ConflictReport | null;
  const hash = /^[a-f0-9]{40,64}$/;
  if (!v || typeof v !== "object") return "the conflict report must be an object";
  if (![v.base, v.head, v.main].every((h) => typeof h === "string" && hash.test(h))) return "the conflict report must name the merge base, the task's head and main's head as full hashes";
  if (!["mechanical", "behavioural", "uncertain"].includes(v.kind)) return "the conflict report's kind must be mechanical, behavioural or uncertain";
  if (!Array.isArray(v.files) || v.files.length > REPORT_LIMITS.files) return `the conflict report must list at most ${REPORT_LIMITS.files} files`;
  if (JSON.stringify(v).length > REPORT_LIMITS.chars) return `the conflict report must be under ${REPORT_LIMITS.chars} characters`;
  const lines = (l: unknown) => Array.isArray(l) && l.every((x) => typeof x === "string");
  for (const f of v.files) {
    if (!f || typeof f.path !== "string" || !f.path || typeof f.why !== "string" || !["mechanical", "behavioural", "uncertain"].includes(f.kind) || !Array.isArray(f.hunks)) return "each file of the conflict report needs a path, a kind, a reason and its hunks";
    for (const h of f.hunks) {
      if (!h || !Number.isInteger(h.line) || !lines(h.ours) || !lines(h.theirs) || !(h.base === null || lines(h.base)) || typeof h.why !== "string") return `a hunk of ${f.path} in the conflict report is malformed`;
    }
  }
  return { base: v.base, head: v.head, main: v.main, kind: v.kind, files: v.files, ...(v.cut ? { cut: true } : {}) };
}

// The report as the builder reads it, in a brief or on the task's page.
export function reportText(r: ConflictReport): string {
  const out = [`Main at ${r.main.slice(0, 8)} conflicts with this task's head ${r.head.slice(0, 8)} (merge base ${r.base.slice(0, 8)}), in a way no mechanical resolution covers (${r.kind}):`];
  for (const f of r.files) {
    out.push("", `${f.path}: ${f.kind}, ${f.why}`);
    for (const h of f.hunks) {
      out.push(`  at line ${h.line}: ${h.kind}, ${h.why}`, "  <<<<<<< task", ...h.ours.map((l) => `  ${l}`));
      if (h.base) out.push("  ||||||| base", ...h.base.map((l) => `  ${l}`));
      out.push("  =======", ...h.theirs.map((l) => `  ${l}`), "  >>>>>>> main");
    }
  }
  if (r.cut) out.push("", "(cut to fit; merge main into the workspace to see every conflict)");
  return out.join("\n");
}
