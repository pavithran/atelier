// A review's diff in the prompt a harness is given, and a harness's refusal of
// an input that is too large. A diff over the limit is never put in the prompt
// (t230): llm-basics t14's diff was 7,052,528 characters and codex takes
// 1,048,576, so every review of it was refused at once. The prompt names the
// diff file and the changed paths with their sizes instead, and the reviewer
// reads the file in parts.

export const DIFF_PROMPT_MAX = 200_000;
// The most paths the prompt lists; the rest are counted.
export const PATHS_LISTED = 200;

export interface DiffPath { path: string; chars: number; binary: boolean; generated: boolean }

const HEADER = /^diff --git a\/(.+?) b\/(.+)$/;

// The limit to use: ATELIER_REVIEW_DIFF_MAX when it is a positive whole
// number, else the default.
export function diffPromptMax(env: Record<string, string | undefined> = {}): number {
  const n = Number(env.ATELIER_REVIEW_DIFF_MAX);
  return Number.isSafeInteger(n) && n > 0 ? n : DIFF_PROMPT_MAX;
}

// The diff's sections, one per file, each with the path it changes, its size
// in characters, and whether it is binary or a path the project declares
// generated.
export function diffSections(diff: string, generated: ReadonlySet<string> = new Set()): Array<DiffPath & { text: string }> {
  const lines = diff.split("\n");
  const sections: Array<DiffPath & { text: string }> = [];
  let start = -1, path = "";
  const close = (end: number) => {
    if (start < 0) return;
    const text = lines.slice(start, end).join("\n") + (end < lines.length ? "\n" : "");
    sections.push({ path, chars: text.length, binary: /^(Binary files .* differ|GIT binary patch)$/m.test(text), generated: generated.has(path), text });
  };
  lines.forEach((line, i) => {
    const m = HEADER.exec(line);
    if (!m) return;
    close(i);
    start = i;
    path = m[2];
  });
  close(lines.length);
  return sections;
}

// The diff with the body of each binary or declared generated path replaced by
// a line saying so: those paths are listed, not shown.
export function withoutBulk(diff: string, generated: ReadonlySet<string> = new Set()): { text: string; hidden: DiffPath[] } {
  const sections = diffSections(diff, generated);
  if (!sections.some((s) => s.binary || s.generated)) return { text: diff, hidden: [] };
  const first = diff.indexOf("diff --git ");
  const head = first > 0 ? diff.slice(0, first) : "";
  const hidden: DiffPath[] = [];
  const body = sections.map((s) => {
    if (!s.binary && !s.generated) return s.text;
    hidden.push({ path: s.path, chars: s.chars, binary: s.binary, generated: s.generated });
    return `diff --git a/${s.path} b/${s.path}\n(${s.binary ? "binary" : "generated"} path, ${s.chars} characters, not shown: read it in the diff file if you need it)\n`;
  }).join("");
  return { text: head + body, hidden };
}

const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300);

function pathLines(paths: readonly DiffPath[]): string[] {
  const sorted = [...paths].sort((a, b) => b.chars - a.chars || a.path.localeCompare(b.path));
  const lines = sorted.slice(0, PATHS_LISTED).map((p) => `- ${oneLine(p.path)}: ${p.chars} characters${p.binary ? " (binary, not shown)" : p.generated ? " (generated, not shown)" : ""}`);
  if (sorted.length > PATHS_LISTED) lines.push(`- and ${sorted.length - PATHS_LISTED} more paths, the smallest`);
  return lines;
}

// What a prompt says in place of the diff when it is over `max` characters:
// the size, the file, and the changed paths largest first.
export function largeDiffNote(diff: string, file: string | null, generated: ReadonlySet<string> = new Set(), max = DIFF_PROMPT_MAX): string {
  const sections = diffSections(diff, generated);
  return [
    `The diff is ${diff.length} characters, over the ${max} this prompt carries, so it is not included here.${file ? ` The whole diff is in the file ${file}: read it in parts, for one path at a time, and do not load it whole.` : " Read it in your clone, one path at a time."}`,
    `It changes ${sections.length} path${sections.length === 1 ? "" : "s"}, largest first:`,
    ...pathLines(sections),
  ].join("\n");
}

// The text a harness reports for an input over its size limit, as { limit,
// actual }, or null for any other failure. Either number may be missing: the
// harnesses word it differently ("Input exceeds the maximum length of
// 1048576 characters", "prompt is too long: 250000 tokens > 200000 maximum").
export function sizeRefusal(text: string): { limit: number | null; actual: number | null } | null {
  const s = String(text ?? "");
  if (!/(exceeds? the maximum|maximum (?:context )?length|context[_ ]length|too long|too large|payload too large|input is too|request too large|over the limit)/i.test(s)) return null;
  const num = (v: string | undefined) => v ? Number(v.replace(/,/g, "")) : null;
  const limit = num(/maximum[^0-9\n]{0,60}?(\d[\d,]*)/i.exec(s)?.[1]) ?? num(/(\d[\d,]*)\s*(?:characters|tokens)?\s*maximum/i.exec(s)?.[1]) ?? num(/limit[^0-9\n]{0,30}?(\d[\d,]*)/i.exec(s)?.[1]);
  const actual = num(/(?:got|received|requested|actual|you sent|was)[^0-9\n]{0,30}?(\d[\d,]*)/i.exec(s)?.[1]) ?? num(/(?:too (?:long|large)|exceeded?)[^0-9\n]{0,20}?(\d[\d,]*)/i.exec(s)?.[1]);
  return { limit, actual: actual !== null && actual !== limit ? actual : null };
}

// The one reason a size refusal is reported with: who refused, the stated
// limit and the actual size (what the harness said, else what was sent), and
// the fix. It is not the model's refusal.
export function sizeRefusalReason(who: string, refusal: { limit: number | null; actual: number | null }, sent: number): string {
  const limit = refusal.limit === null ? "a limit it did not state" : `limit ${refusal.limit}`;
  const actual = refusal.actual === null ? `about ${sent} characters sent` : `actual ${refusal.actual}`;
  return `${who}'s harness refused the review input for its size (${limit}; ${actual}), not as a verdict. Fix: run the review on a runner whose CLI sends only the diff file and the changed paths (update and restart the runner), or split the change into smaller tasks, then ask again with atelier review-request ID --reviewer H/M. It is not tried again as it is.`;
}
