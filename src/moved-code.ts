// Edits that main moved to another file (t471). A landing merges main into
// the task's workspace, and Git merges a file line by line: where main moved
// a block of code out of a file into another one and the task edited that
// block in its old place, Git either stops on a conflict or — where the task's
// edit sits between lines Git kept because main wrote identical ones at that
// spot — merges cleanly and leaves the edit in code that no longer runs, while
// the moved copy never gets it. t437's edits to handlers in cli/atelier.mjs
// merged that way after t426 (5e46dc6) moved the handlers to cli/commands/
// (2026-10-10). So before the merge the landing compares the task's head and
// main's head with their merge base, and this module says which task edits
// lie in text main moved, and where to.
//
// The matching rule:
//   - The text main removed from a file is the base lines its diff from the
//     merge base deletes (Git's myers diff, named explicitly so no diff
//     configuration changes it), read as contiguous blocks. Two deletions
//     with at most MAX_BRIDGE kept lines between them are one block: Git
//     keeps a line where main happened to write an identical one at that
//     spot, and that is exactly how a moved block merges cleanly.
//   - A task edit counts when it overlaps such a block: a changed base line
//     inside it, or, for an edit that only inserts lines, the base lines on
//     both sides of the insertion (the one side at either end of the file).
//   - The block's text around those lines is looked for, line by line with
//     leading and trailing whitespace ignored, among the lines main added to
//     other files. A match is the longest contiguous run that covers every
//     overlapping line, holds at least MIN_MATCH_LINES non-blank lines and at
//     least one line main really deleted.
//   - One match is a confirmed move; several, in one file or many, are an
//     ambiguous warning naming each, never a confirmed move.
// Left out: a move main made within the file (an in-place edit, which Git
// merges or conflicts on by itself); moves no task edit touches; whole files
// Git pairs as renames at RENAME_THRESHOLD (merge-ort follows those, carrying
// the edits along), so a renamed file's new path is the same file, never a
// destination, and only a block it lost to a third file is a move; binary
// files, symlinks and submodules. Paths come from NUL-separated listings and
// contents are read by blob id, so a path with spaces, tabs or newlines is
// read as written and never taken for a pathspec.
//
// Limitations, by the rule above: a block main edited as it moved matches
// only through its unchanged run around the task's lines, so an edit next to
// main's own change can go unfound; a block split across files is found only
// where the piece holding the task's lines went; an insertion at the edge of
// a moved block (one neighbour moved, the other kept) is not reported, as
// nothing says which side it belonged to; a rename below the threshold is a
// deletion and an addition, so the whole file reads as moved, as Git's merge
// also reads it. A comparison sees only main's changes since the merge base:
// a move an earlier merge of main brought in is behind it.

export const RENAME_THRESHOLD = "50%";
export const MIN_MATCH_LINES = 3;
export const MAX_BRIDGE = 2;

// Git, run in the repository: answers the command's whole standard output
// and throws when the command fails. A landing's git answers at once; a
// runner's (t435) runs each command as a child and answers a promise, so
// the comparison is written once, as the sequence of reads it makes
// (`comparison`), and driven by either reader.
export type GitRead = (args: string[]) => string;
export type GitReadAsync = (args: string[]) => string | Promise<string>;
type Steps<T> = Generator<string[], T, string>;

export interface Span { path: string; start: number; end: number }
// A task edit in base lines: `change` replaces lines start..end; `insert`
// adds lines between base lines start and end (end = start + 1).
export interface TaskEdit { kind: "change" | "insert"; start: number; end: number; taskStart: number; taskEnd: number }
export interface MovedFinding { source: Span; destination: Span; edit: TaskEdit; lines: number; sample: string[] }
export interface AmbiguousMove { source: Span; destinations: Span[]; edit: TaskEdit; lines: number; sample: string[] }
export interface MovedReport { task: string; main: string; mergeBase: string; findings: MovedFinding[]; ambiguous: AmbiguousMove[] }

export interface RawEntry { status: string; score: number | null; modes: [string, string]; blobs: [string, string]; path: string; from: string | null }

const REGULAR = new Set(["100644", "100755"]);

// `git diff-tree -r -z` raw output: a meta field (":modeA modeB blobA blobB
// STATUS"), then the path, or the source and destination of a rename or copy.
export function parseRawZ(out: string): RawEntry[] {
  const parts = out.split("\0");
  const entries: RawEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const meta = parts[i];
    if (!meta.startsWith(":")) continue;
    const [modeA, modeB, blobA, blobB, status = ""] = meta.slice(1).split(" ");
    const letter = status.charAt(0);
    const score = status.length > 1 ? Number(status.slice(1)) : null;
    if (letter === "R" || letter === "C") {
      entries.push({ status: letter, score, modes: [modeA, modeB], blobs: [blobA, blobB], from: parts[i + 1], path: parts[i + 2] });
      i += 2;
    } else {
      entries.push({ status: letter, score, modes: [modeA, modeB], blobs: [blobA, blobB], from: null, path: parts[i + 1] });
      i += 1;
    }
  }
  return entries;
}

export interface Hunk { oldStart: number; oldCount: number; newStart: number; newCount: number; added: string[] }

// The hunks of a `git diff -U0` between two blobs. Each hunk's lines are read
// by its own counts, so a deleted line that looks like a header is still a
// line. Answers null for a diff Git reports as binary.
export function parseHunks(out: string): Hunk[] | null {
  const lines = out.split("\n");
  const hunks: Hunk[] = [];
  let binary = false;
  for (let i = 0; i < lines.length; i++) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]);
    if (!m) { if (!hunks.length && /^Binary files /.test(lines[i])) binary = true; continue; }
    const oldCount = m[2] === undefined ? 1 : Number(m[2]), newCount = m[4] === undefined ? 1 : Number(m[4]);
    // Line numbers of the next old and new line; with no lines on a side,
    // Git's header names the line before, so the next is one after it.
    let oldLine = Number(m[1]) + (oldCount === 0 ? 1 : 0), newLine = Number(m[3]) + (newCount === 0 ? 1 : 0);
    // A hunk Git printed with context lines (GIT_DIFF_OPTS, diff.interHunkContext)
    // is split into its runs of changed lines, each numbered as -U0 would
    // number it, so context is never read as changed.
    let run: Hunk | null = null;
    const close = () => {
      if (!run) return;
      if (run.oldCount === 0) run.oldStart -= 1;
      if (run.newCount === 0) run.newStart -= 1;
      hunks.push(run); run = null;
    };
    let olds = 0, news = 0;
    while ((olds < oldCount || news < newCount) && i + 1 < lines.length) {
      const line = lines[++i];
      if (line.startsWith("\\")) continue;
      if (line.startsWith("-") || line.startsWith("+")) {
        run ??= { oldStart: oldLine, oldCount: 0, newStart: newLine, newCount: 0, added: [] };
        if (line.startsWith("-")) { olds++; oldLine++; run.oldCount++; }
        else { news++; newLine++; run.newCount++; run.added.push(line.slice(1)); }
      } else { close(); olds++; news++; oldLine++; newLine++; }
    }
    close();
  }
  return binary ? null : hunks;
}

export const normalize = (line: string): string => line.trim();
const splitLines = (text: string): string[] => { const l = text.split("\n"); if (l.at(-1) === "") l.pop(); return l; };

// The diff of two blobs, as a landing's comparison reads it whatever the
// repository's diff configuration says. DETECTOR_ENV clears what the
// environment could add (GIT_DIFF_OPTS, an external diff, -c overrides);
// parseHunks reads context correctly in any case.
export const DETECTOR_ENV = { GIT_DIFF_OPTS: "", GIT_EXTERNAL_DIFF: "", GIT_CONFIG_PARAMETERS: "", GIT_CONFIG_COUNT: "0" };
const DIFF = ["diff", "-U0", "--inter-hunk-context=0", "--no-color", "--no-ext-diff", "--no-textconv", "--diff-algorithm=myers", "--indent-heuristic", "--src-prefix=a/", "--dst-prefix=b/"];
const LIST = ["diff-tree", "-r", "-z", "--no-commit-id", `--find-renames=${RENAME_THRESHOLD}`];

interface SourceFile { path: string; same: Set<string>; base: string[]; deleted: Set<number> }
interface AddedRun { path: string; start: number; lines: string[] }

// The comparison: the task's edits (merge base → task) against what main
// moved (merge base → main), read through a synchronous git.
export function detectMovedEdits(read: GitRead, revs: { task: string; main: string; mergeBase: string }): MovedReport {
  const steps = comparison(revs);
  let next = steps.next();
  while (!next.done) next = steps.next(read(next.value));
  return next.value;
}

// The same comparison through a git that answers a promise (a runner's).
export async function detectMovedEditsAsync(read: GitReadAsync, revs: { task: string; main: string; mergeBase: string }): Promise<MovedReport> {
  const steps = comparison(revs);
  let next = steps.next();
  while (!next.done) next = steps.next(await read(next.value));
  return next.value;
}

// The comparison as the Git reads it makes, in order: each yield is one
// command's arguments, and takes back its whole standard output.
function* comparison(revs: { task: string; main: string; mergeBase: string }): Steps<MovedReport> {
  const report: MovedReport = { ...revs, findings: [], ambiguous: [] };
  const blob = function* (id: string): Steps<string | null> { const text: string = yield ["cat-file", "blob", id]; return text.includes("\0") ? null : text; };
  const hunksOf = function* (a: string, b: string): Steps<Hunk[] | null> { return parseHunks(yield [...DIFF, a, b]); };

  // What main removed, file by file, and what it added anywhere.
  const sources = new Map<string, SourceFile>();
  const added: AddedRun[] = [];
  const mainEntries = parseRawZ(yield [...LIST, revs.mergeBase, revs.main]);
  // The task's files first, so main's files are read only where the task edited.
  const taskEntries = parseRawZ(yield [...LIST, revs.mergeBase, revs.task])
    .filter((e) => ["M", "R", "D"].includes(e.status) && REGULAR.has(e.modes[0]) && (e.status === "D" || REGULAR.has(e.modes[1])));
  const taskPaths = new Set(taskEntries.map((e) => e.from ?? e.path));
  for (const e of mainEntries) {
    const regularA = REGULAR.has(e.modes[0]), regularB = REGULAR.has(e.modes[1]);
    if (e.status === "A") {
      if (!regularB) continue;
      const text = yield* blob(e.blobs[1]);
      if (text !== null) added.push({ path: e.path, start: 1, lines: splitLines(text) });
      continue;
    }
    if (!["M", "R", "D"].includes(e.status) || !regularA || (e.status !== "D" && !regularB)) continue;
    const source = e.from ?? e.path;
    const wanted = taskPaths.has(source);
    if (e.status === "D") {
      if (!wanted) continue;
      const text = yield* blob(e.blobs[0]);
      if (text === null) continue;
      const base = splitLines(text);
      sources.set(source, { path: source, same: new Set([source]), base, deleted: new Set(base.map((_, i) => i + 1)) });
      continue;
    }
    const hunks = yield* hunksOf(e.blobs[0], e.blobs[1]);
    if (!hunks) continue;
    for (const h of hunks) if (h.newCount > 0) added.push({ path: e.path, start: h.newStart, lines: h.added });
    if (!wanted) continue;
    const text = yield* blob(e.blobs[0]);
    if (text === null) continue;
    const deleted = new Set<number>();
    for (const h of hunks) for (let l = h.oldStart; l < h.oldStart + h.oldCount; l++) deleted.add(l);
    if (deleted.size) sources.set(source, { path: source, same: new Set([source, e.path]), base: splitLines(text), deleted });
  }
  if (!sources.size) return report;

  // Every line main added, by its normalized text, for the search.
  const index = new Map<string, Array<{ run: AddedRun; at: number }>>();
  for (const run of added) run.lines.forEach((line, at) => {
    const key = normalize(line);
    let list = index.get(key);
    if (!list) index.set(key, list = []);
    list.push({ run, at });
  });

  for (const e of taskEntries) {
    const src = sources.get(e.from ?? e.path);
    if (!src) continue;
    let edits: TaskEdit[];
    if (e.status === "D") edits = [{ kind: "change", start: 1, end: src.base.length, taskStart: 0, taskEnd: -1 }];
    else {
      const hunks = yield* hunksOf(e.blobs[0], e.blobs[1]);
      if (!hunks) continue;
      edits = hunks.map((h) => h.oldCount > 0
        ? { kind: "change" as const, start: h.oldStart, end: h.oldStart + h.oldCount - 1, taskStart: h.newStart, taskEnd: h.newStart + h.newCount - 1 }
        : { kind: "insert" as const, start: h.oldStart, end: h.oldStart + 1, taskStart: h.newStart, taskEnd: h.newStart + h.newCount - 1 });
    }
    const blocks = movedBlocks(src);
    for (const edit of edits) {
      for (const block of blocks) {
        const anchor = anchorOf(edit, block, src.base.length);
        if (!anchor) continue;
        const matches = matchesFor(src, block, anchor, index);
        if (!matches.length) continue;
        const best = matches.reduce((a, b) => (b.lines > a.lines ? b : a));
        const source: Span = { path: src.path, start: best.from, end: best.to };
        const sample = src.base.slice(best.from - 1, best.to).map(normalize).filter(Boolean).slice(0, 3);
        if (matches.length === 1) report.findings.push({ source, destination: best.destination, edit, lines: best.lines, sample });
        else report.ambiguous.push({ source, destinations: matches.map((m) => m.destination), edit, lines: best.lines, sample });
      }
    }
  }
  return report;
}

interface Block { start: number; end: number; deleted: Set<number> }

// The contiguous base text main removed from a file, bridging up to
// MAX_BRIDGE lines Git kept between two deletions.
function movedBlocks(src: SourceFile): Block[] {
  const lines = [...src.deleted].sort((a, b) => a - b);
  const blocks: Block[] = [];
  for (const l of lines) {
    const last = blocks.at(-1);
    if (last && l - last.end - 1 <= MAX_BRIDGE) last.end = l;
    else blocks.push({ start: l, end: l, deleted: src.deleted });
  }
  return blocks;
}

// The base lines of an edit the match must cover: the changed lines inside
// the block, or both neighbours of an insertion (one, at a file's edge).
function anchorOf(edit: TaskEdit, block: Block, length: number): [number, number] | null {
  if (edit.kind === "change") {
    const from = Math.max(edit.start, block.start), to = Math.min(edit.end, block.end);
    return from <= to ? [from, to] : null;
  }
  const before = edit.start, after = edit.start + 1;
  const from = before >= 1 ? before : after, to = after <= length ? after : before;
  return from >= block.start && to <= block.end && from <= to ? [from, to] : null;
}

interface Match { from: number; to: number; lines: number; destination: Span }

// Every place in the lines main added to another file where the block's text
// around the anchor runs on, contiguously, past the matching rule's floor.
function matchesFor(src: SourceFile, block: Block, [from, to]: [number, number], index: Map<string, Array<{ run: AddedRun; at: number }>>): Match[] {
  const norm = (l: number) => normalize(src.base[l - 1] ?? "");
  // The anchor line whose text is rarest among main's additions leads the search.
  let lead = from;
  for (let l = from; l <= to; l++) if ((index.get(norm(l))?.length ?? 0) < (index.get(norm(lead))?.length ?? 0)) lead = l;
  const matches: Match[] = [];
  for (const { run, at } of index.get(norm(lead)) ?? []) {
    if (src.same.has(run.path)) continue;
    const pos = (l: number) => at + (l - lead);
    const same = (l: number) => pos(l) >= 0 && pos(l) < run.lines.length && normalize(run.lines[pos(l)]) === norm(l);
    let ok = true;
    for (let l = from; l <= to && ok; l++) ok = same(l);
    if (!ok) continue;
    let lo = from, hi = to;
    while (lo - 1 >= block.start && same(lo - 1)) lo--;
    while (hi + 1 <= block.end && same(hi + 1)) hi++;
    let nonBlank = 0, removed = false;
    for (let l = lo; l <= hi; l++) { if (norm(l)) nonBlank++; if (block.deleted.has(l)) removed = true; }
    if (nonBlank < MIN_MATCH_LINES || !removed) continue;
    matches.push({ from: lo, to: hi, lines: hi - lo + 1, destination: { path: run.path, start: run.start + pos(lo), end: run.start + pos(hi) } });
  }
  return matches;
}

// ── how a landing says it ────────────────────────────────────────────────

// A path as a message shows it: as written, or quoted as JSON where a space,
// a quote, a backslash or a control character would blur where it ends.
export const showPath = (path: string): string => (/^[\x21-\x7e]+$/.test(path) && !/["\\]/.test(path) ? path : JSON.stringify(path));
const range = (s: { start: number; end: number }) => (s.start === s.end ? `line ${s.start}` : `lines ${s.start}-${s.end}`);
const editText = (e: TaskEdit) => (e.kind === "insert"
  ? `inserted ${e.taskEnd - e.taskStart + 1} line${e.taskEnd === e.taskStart ? "" : "s"} between base lines ${e.start} and ${e.end}`
  : `changed base ${range(e)}`);

export function describeFinding(f: MovedFinding): string {
  return `${showPath(f.source.path)} ${range(f.source)} moved to ${showPath(f.destination.path)} ${range(f.destination)}: the task ${editText(f.edit)} there${f.edit.taskEnd >= f.edit.taskStart ? ` (its ${range({ start: f.edit.taskStart, end: f.edit.taskEnd })} at the task's head)` : ""}; ${f.lines} line${f.lines === 1 ? "" : "s"} match, whitespace aside, beginning ${JSON.stringify(f.sample[0] ?? "")}`;
}

export function describeAmbiguous(a: AmbiguousMove): string {
  return `${showPath(a.source.path)} ${range(a.source)}, where the task ${editText(a.edit)}, matches text main added in ${a.destinations.length} places (${a.destinations.map((d) => `${showPath(d.path)} ${range(d)}`).join(", ")}), so it is not taken for a move`;
}

// A stable key per finding, so an approval names exactly what it approved.
export const findingKey = (f: MovedFinding): string => JSON.stringify([f.source.path, f.source.start, f.source.end, f.destination.path, f.destination.start, f.destination.end, f.edit.kind, f.edit.start, f.edit.end]);
