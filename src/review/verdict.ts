// Reading a reviewer's reply. The brief asks for VERDICT, SUMMARY and FINDING
// lines, and REPLY_FORMAT below is the only statement of that format, so the
// brief and this parser cannot drift apart. A change with acceptance
// criteria is asked for one CRITERION line per criterion as well
// (replyFormat), and parseVerdict, told how many criteria there are, refuses
// an approval that misses one or declares one unmet: a criterion is proved,
// not waved through. Models wrap their answers in
// prose, in code fences or in JSON, including the design's verdict-file
// shape {approve, summary, findings[{path, line?, severity, note}]}, and all
// of these are read. Nothing is guessed: a reply that states no verdict,
// states both, or gives findings that contradict its verdict is refused with
// the reason, and the caller asks again or stops.

import { TEXT_CONTROLS } from "../text.ts";
import type { Finding } from "../rules.ts";

export type { Finding };

// Blocking findings are correctness, security and data loss faults; every
// other finding is a follow-up and never holds a change back.
export type Severity = Finding["severity"];

export type ParsedVerdict =
  | { ok: true; verdict: "approve" | "reject"; summary: string; findings: Finding[] }
  | { ok: false; error: string };

// A reply longer than `reply` is refused rather than scanned. A list of more
// than `findings` is refused rather than cut, since a cut could drop a
// blocking finding. Text over its cap is cut with an ellipsis, which changes
// no verdict.
export const VERDICT_LIMITS = { reply: 100_000, findings: 50, file: 512, text: 2000, summary: 600 } as const;

// What may block, when the project sets no review bar of its own (`atelier
// init --review-bar`). Every review brief states the bar in force, and
// bin/orchestrate/review.sh reads this one as its default.
export const DEFAULT_REVIEW_BAR = "Block only for a correctness, security or data-loss defect that the change introduces, or fails to fix while claiming to. A claim in a commit message that the code does not support is a correctness defect. Decisions the project owner made are not defects; everything else is a follow-up.";

const FORMAT_EXAMPLES = [
  "End your reply with these lines, each at the start of its own line:",
  "",
  "VERDICT: APPROVE",
  "SUMMARY: One sentence on what you checked and what you found.",
  "FINDING: follow-up src/example.ts:12 What is wrong, and why it matters.",
];

const FORMAT_RULES = [
  "The VERDICT line says APPROVE or REJECT and nothing else. Do not write APPROVE, APPROVED, REJECT or REJECTED in capitals anywhere else in your reply: a reply that says both is not read as a verdict.",
  "Write one FINDING line for each finding: its severity (blocking or follow-up), the file, then a colon and the line number when the finding has one, then the finding itself, all on one line.",
  "REJECT needs at least one blocking finding, and APPROVE allows none.",
];

const FORMAT_END = "Prose around these lines is allowed and is not read, apart from the rule on APPROVE and REJECT above.";

export const REPLY_FORMAT = [...FORMAT_EXAMPLES, "", ...FORMAT_RULES, FORMAT_END].join("\n");

// The format a change with acceptance criteria is asked for: the same lines,
// and one CRITERION line per criterion, numbered as the brief numbers the
// criteria, each saying met or unmet and how it was proved. A criterion is
// proved by experiment, not by reading, so the reviewer is sent to break the
// change and watch a test fail before calling a criterion met. parseVerdict
// takes the same count of criteria and refuses an approval that misses a
// criterion's line or declares one unmet, so the ask and the reading of the
// answer cannot drift apart either. A count of zero or less, or not a whole
// number, is the format with no criteria.
export function replyFormat(criteria: number): string {
  const count = Number.isSafeInteger(criteria) && criteria > 0 ? criteria : 0;
  if (!count) return REPLY_FORMAT;
  return [
    ...FORMAT_EXAMPLES,
    "CRITERION 1: met — What you did to prove criterion 1 met, and what you saw.",
    "",
    ...FORMAT_RULES,
    `Write one CRITERION line for each of the ${count} acceptance criteria, numbered as the brief numbers them: CRITERION n, then met or unmet, then how it was proved — what you did, and what you saw. Prefer breaking the change and watching a test fail over reading the code: say what you broke and which test failed. An approval needs every criterion met and proved; one you cannot prove met is unmet, and unmet blocks.`,
    FORMAT_END,
  ].join("\n");
}

// The severities the brief names, and the design's verdict-file names for
// the same two classes: blocker is blocking; should and nit are follow-ups.
const SEVERITIES: Record<string, Severity> = {
  blocking: "blocking", blocker: "blocking",
  "follow-up": "follow-up", followup: "follow-up", follow_up: "follow-up", should: "follow-up", nit: "follow-up",
};

// A failed JSON candidate costs a scan to the end of the reply at worst, so
// the number of failures is bounded. A verdict field left unread because of
// the bound is still caught: every "verdict" or "approve" key in the reply
// must belong to a parsed object, or the reply is refused.
const JSON_ATTEMPTS = 100;

type Statement = { verdict: "approve" | "reject"; summary: string; findings: Finding[] };
class Refusal extends Error {}
function refuse(message: string): never {
  throw new Refusal(message);
}

// `criteria` is how many acceptance criteria the brief numbered, as
// reviewBrief counts them; a reply to that brief must prove each with a
// CRITERION line, and an approval that misses one or declares one unmet is
// refused. Without criteria (the default) CRITERION lines are not read.
export function parseVerdict(text: unknown, criteria = 0): ParsedVerdict {
  try {
    return { ok: true, ...read(text, criteria) };
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, error: err.message };
    throw err;
  }
}

function read(raw: unknown, asked: number): Statement {
  if (typeof raw !== "string") refuse("the reply is not text");
  const reply = normalise(raw);
  if (reply.length > VERDICT_LIMITS.reply) refuse(`the reply is ${reply.length} characters, over the ${VERDICT_LIMITS.reply} a verdict needs`);
  const criteria = Number.isSafeInteger(asked) && asked > 0 ? asked : 0;

  const json = jsonStatements(reply);
  const lines = lineStatements(reply, criteria);
  const verdicts = new Set([...json.map((s) => s.verdict), ...lines.verdicts]);
  if (!verdicts.size) refuse("the reply states no verdict: it has no VERDICT line and no JSON verdict");
  // Lowercase approve and reject are ordinary words in a review of code that
  // approves and rejects things, so only the capitalised keywords count as
  // saying a verdict. A capitalised keyword for the other verdict anywhere,
  // in prose, a quotation or a finding, makes the reply ambiguous.
  for (const match of reply.matchAll(/\b(APPROVED?|REJECT(?:ED)?)\b/g)) verdicts.add(match[1].startsWith("A") ? "approve" : "reject");
  if (verdicts.size > 1) refuse("the reply says both APPROVE and REJECT, so it is not a verdict");
  const verdict = [...verdicts][0];

  if (json.length && lines.findings.length) refuse("the reply gives findings both as JSON and as FINDING lines");
  if (new Set(json.map((s) => JSON.stringify(s))).size > 1) refuse(`the reply has ${json.length} JSON verdicts that differ`);
  const findings = json.length ? json[0].findings : lines.findings;
  const summary = json.length ? json[0].summary : clip(lines.summary.join(" "), VERDICT_LIMITS.summary);
  if (findings.length > VERDICT_LIMITS.findings) refuse(`the reply has ${findings.length} findings, over the limit of ${VERDICT_LIMITS.findings}`);
  const blocking = findings.filter((f) => f.severity === "blocking").length;
  if (verdict === "reject" && !blocking) refuse("a rejection must name at least one blocking finding (correctness, security or data loss); every other finding is a follow-up");
  if (verdict === "approve" && blocking) refuse(`an approval cannot carry ${blocking === 1 ? "a blocking finding" : `${blocking} blocking findings`}; reject, or mark the finding a follow-up`);
  // An approval proves every acceptance criterion: one CRITERION line each,
  // each met. A missing line leaves the criterion unproved, and a line that
  // says unmet is a correctness fault the approval cannot carry, as a
  // blocking finding is below. A rejection needs no criterion lines: its
  // blocking findings say what they say.
  if (verdict === "approve" && criteria) {
    const missing: number[] = [];
    const unmet: number[] = [];
    for (let n = 1; n <= criteria; n++) {
      const met = lines.criteria.get(n);
      if (met === undefined) missing.push(n);
      else if (!met) unmet.push(n);
    }
    if (missing.length) refuse(`an approval needs a CRITERION line for each of the ${criteria} acceptance criteria: ${missing.length === 1 ? "criterion" : "criteria"} ${missing.join(", ")} ${missing.length === 1 ? "has" : "have"} none`);
    if (unmet.length) refuse(`an approval cannot declare ${unmet.length === 1 ? "criterion" : "criteria"} ${unmet.join(", ")} unmet; an unmet criterion is a correctness fault, so reject with a blocking finding`);
  }
  return { verdict, summary, findings };
}

// Line breaks become \n. C0 and C1 controls other than tabs become spaces,
// and invisible format characters are removed, so a zero-width character
// cannot hide a keyword from the scan.
function normalise(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(TEXT_CONTROLS, (c) =>
    c === "\n" || c === "\t" ? c : /[\u0000-\u001f\u007f-\u009f]/.test(c) ? " " : "");
}

const plain = (s: string) => s.replace(TEXT_CONTROLS, " ").replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ── JSON ─────────────────────────────────────────────────────────────────

function closingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === "\"") inString = false;
    } else if (c === "\"") inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

// An object opens with a key or closes at once; prose braces rarely do.
const OBJECT_START = /\{\s*["}]/y;

function jsonValues(text: string): unknown[] {
  const values: unknown[] = [];
  let failures = 0;
  for (let i = text.indexOf("{"); i !== -1;) {
    OBJECT_START.lastIndex = i;
    if (OBJECT_START.test(text)) {
      const end = closingBrace(text, i);
      if (end !== -1) {
        try {
          values.push(JSON.parse(text.slice(i, end + 1)));
          i = text.indexOf("{", end + 1);
          continue;
        } catch { /* not JSON from this brace; try the next one */ }
      }
      if (++failures > JSON_ATTEMPTS) break;
    }
    i = text.indexOf("{", i + 1);
  }
  return values;
}

const VERDICT_KEY = /^(verdict|approve)$/i;

// Objects anywhere in a parsed value that carry a verdict key, so a verdict
// inside an envelope such as {"result": {...}} is read, and the number of
// verdict keys seen, for the check against the raw text.
function collect(value: unknown, found: Record<string, unknown>[], depth = 0): number {
  if (depth > 64 || value === null || typeof value !== "object") return 0;
  if (Array.isArray(value)) return value.reduce((n: number, v) => n + collect(v, found, depth + 1), 0);
  const record = value as Record<string, unknown>;
  const own = Object.keys(record).filter((k) => VERDICT_KEY.test(k)).length;
  if (own) found.push(record);
  return own + Object.values(record).reduce((n: number, v) => n + collect(v, found, depth + 1), 0);
}

function jsonStatements(reply: string): Statement[] {
  const found: Record<string, unknown>[] = [];
  const keys = jsonValues(reply).reduce((n: number, v) => n + collect(v, found), 0);
  // Every verdict key written in the reply must have been read from valid
  // JSON. This refuses a malformed verdict object, a verdict field in prose,
  // and a duplicated key, which JSON.parse would silently collapse to its
  // last value.
  const written = reply.match(/"(?:verdict|approve)"\s*:/gi)?.length ?? 0;
  if (written !== keys) refuse(`the reply writes ${written} "verdict" or "approve" ${written === 1 ? "field" : "fields"} and ${keys} could be read from valid JSON`);
  return found.map((o, i) => statementFrom(o, found.length > 1 ? `JSON verdict ${i + 1}` : "the JSON verdict"));
}

// One field by any of its names, in any case. Two names given different
// values is a contradiction, not a choice.
function field(o: Record<string, unknown>, names: string[], at: string): unknown {
  const values = Object.keys(o).filter((k) => names.includes(k.toLowerCase())).map((k) => o[k]);
  if (new Set(values.map((v) => JSON.stringify(v))).size > 1) refuse(`${at} gives ${names.join(" and ")} different values`);
  return values[0];
}

function statementFrom(o: Record<string, unknown>, at: string): Statement {
  const said = field(o, ["verdict"], at);
  const approve = field(o, ["approve"], at);
  let verdict: Statement["verdict"] | undefined;
  if (said !== undefined) {
    const m = typeof said === "string" ? /^\s*(approved?|reject(?:ed)?)\s*$/i.exec(said) : null;
    if (!m) refuse(`${at}: "verdict" must be APPROVE or REJECT`);
    verdict = m[1].toLowerCase().startsWith("a") ? "approve" : "reject";
  }
  if (approve !== undefined) {
    if (typeof approve !== "boolean") refuse(`${at}: "approve" must be true or false`);
    const byFlag = approve ? "approve" : "reject";
    if (verdict && verdict !== byFlag) refuse(`${at} says "verdict" ${verdict} but "approve" ${approve}`);
    verdict = byFlag;
  }
  if (!verdict) refuse(`${at} has no "verdict" or "approve" field`);
  const summary = field(o, ["summary"], at) ?? "";
  if (typeof summary !== "string") refuse(`${at}: "summary" must be text`);
  const list = field(o, ["findings"], at) ?? [];
  if (!Array.isArray(list)) refuse(`${at}: "findings" must be a list`);
  const findings = list.map((entry: unknown, i) => findingFrom(entry, `${at}, finding ${i + 1}`));
  return { verdict, summary: clip(plain(summary), VERDICT_LIMITS.summary), findings };
}

function findingFrom(entry: unknown, at: string): Finding {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) refuse(`${at} is not an object`);
  const o = entry as Record<string, unknown>;
  const severity = field(o, ["severity"], at);
  const text = field(o, ["text", "note"], at);
  const line = field(o, ["line"], at);
  if (typeof text !== "string" || !plain(text)) refuse(`${at} has no text`);
  return {
    file: fileFrom(field(o, ["file", "path"], at), at),
    line: lineFrom(line, at),
    severity: severityFrom(severity, at),
    text: clip(plain(text), VERDICT_LIMITS.text),
  };
}

// ── Findings, as either encoding gives them ─────────────────────────────

function severityFrom(value: unknown, at: string): Severity {
  const named = typeof value === "string" ? SEVERITIES[value.trim().toLowerCase()] : undefined;
  if (!named) refuse(`${at}: severity must be blocking or follow-up, not ${JSON.stringify(value ?? null)}`);
  return named;
}

// A path as the reviewer gave it, less quoting and a leading "./". It is not
// resolved or checked against the change: a finding may name a file the
// change should have touched.
function fileFrom(value: unknown, at: string): string {
  const file = typeof value === "string" ? value.trim().replace(/^[`'"]+|[`'"]+$/g, "").replace(/^\.\//, "") : "";
  if (!file) refuse(`${at} names no file`);
  if (file.length > VERDICT_LIMITS.file || /[\u0000-\u001f\u007f-\u009f]/.test(file)) refuse(`${at} names a file Atelier cannot record`);
  return file;
}

// A line is a positive integer. A range such as 12-20 keeps its first line.
function lineFrom(value: unknown, at: string): number | null {
  if (value === undefined || value === null) return null;
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  const m = /^(\d+)(?:-\d+)?$/.exec(text);
  const n = m ? Number(m[1]) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) refuse(`${at}: line must be a positive whole number`);
  return n;
}

// ── Lines ────────────────────────────────────────────────────────────────

// Markdown a model puts before a keyword: indentation, quotes, headings,
// bullets, emphasis and code ticks.
const DECORATION = /^[\s>#*+_`-]+/;
const E = "[*_`]*";
const VERDICT_HEAD = new RegExp(`^verdict${E}\\s*:`, "i");
const VERDICT_TITLE = new RegExp(`^verdict${E}\\s*:?\\s*${E}\\s*$`, "i");
const VERDICT_LINE = new RegExp(`^verdict${E}\\s*:\\s*${E}\\s*(approved?|reject(?:ed)?)\\s*${E}\\s*[.!]?\\s*${E}\\s*$`, "i");
const BARE = new RegExp(`^(approved?|reject(?:ed)?)\\s*${E}\\s*[.!]?\\s*${E}\\s*$`, "i");
// "FINDING:" in any case, or "FINDING " in capitals; "Findings:" is a heading
// and "Finding the cause" is prose.
const FINDING_COLON = new RegExp(`^finding${E}\\s*:`, "i");
const findingHead = (line: string) => FINDING_COLON.test(line) || /^FINDING\s/.test(line);
const FINDING_LINE = new RegExp(`^finding${E}\\s*:?\\s*${E}\\s*\\[?([a-z_-]+)\\]?${E}\\s*:?\\s+(\\S+)\\s+(.+)$`, "i");
const SUMMARY_LINE = new RegExp(`^summary${E}\\s*:\\s*${E}\\s*(.*?)\\s*${E}\\s*$`, "i");
// A CRITERION line starts with "criterion" and its number, bracketed or not,
// colon or not, in any case; "Criteria:" is a heading and "criterion" in
// prose carries no number. The head recognises the number in every form the
// line parser reads, so a line that declares a criterion met or unmet is
// never mistaken for prose. Only a reply asked for criteria (replyFormat)
// has its CRITERION lines read; elsewhere they are prose.
const CRITERION_HEAD = new RegExp(`^criterion${E}\\s*:?\\s*${E}\\[?\\d`, "i");
const criterionHead = (line: string) => CRITERION_HEAD.test(line);
// The met or unmet word ends at anything but a letter or digit, so an
// underscore closes formatting (**, __, backticks) rather than extending the
// word, as a \b would read it.
const CRITERION_LINE = new RegExp(`^criterion${E}\\s*:?\\s*${E}\\[?(\\d+)\\]?${E}\\s*:?\\s*${E}\\s*\\[?(unmet|not met|met)(?![a-z0-9])\\]?\\s*(?:[-–—:]\\s*)?(.*?)\\s*$`, "i");

function lineStatements(reply: string, criteria: number): { verdicts: Statement["verdict"][]; findings: Finding[]; summary: string[]; criteria: Map<number, boolean> } {
  const verdicts: Statement["verdict"][] = [];
  const findings: Finding[] = [];
  const summary: string[] = [];
  const met = new Map<number, boolean>();
  reply.split("\n").forEach((raw, i) => {
    const line = raw.replace(DECORATION, "");
    const at = `line ${i + 1}`;
    const word = (w: string) => (w.toLowerCase().startsWith("a") ? "approve" : "reject");
    const verdict = VERDICT_LINE.exec(line) ?? BARE.exec(line);
    if (verdict) verdicts.push(word(verdict[1]));
    // A heading such as "## Verdict" is not a statement; any other text after
    // "Verdict:" must be the verdict alone, or the reply is refused.
    else if (VERDICT_HEAD.test(line) && !VERDICT_TITLE.test(line)) refuse(`${at}: a VERDICT line says APPROVE or REJECT and nothing else`);
    else if (findingHead(line)) findings.push(findingLine(line, at));
    else if (criteria && criterionHead(line)) {
      const c = criterionLine(line, at, criteria);
      // The same criterion proved twice must be proved one way.
      if (met.has(c.n) && met.get(c.n) !== c.met) refuse(`the reply proves criterion ${c.n} both met and unmet`);
      met.set(c.n, c.met);
    }
    else {
      const s = SUMMARY_LINE.exec(line);
      if (s && plain(s[1])) summary.push(plain(s[1]));
    }
  });
  return { verdicts, findings, summary, criteria: met };
}

// One CRITERION line: the criterion's number as the brief numbers it, met or
// unmet, then how it was proved — the proof is the point of the line, so a
// line without one is refused rather than read as a bare met. The pattern
// takes an empty proof so the refusal can name the missing proof, not the
// line's shape. Closing formatting around the met or unmet (**, __,
// backticks) is captured as if it were proof, so markers are not counted:
// only the proof's words are.
function criterionLine(line: string, at: string, of: number): { n: number; met: boolean } {
  const m = CRITERION_LINE.exec(line);
  if (!m) refuse(`${at}: a CRITERION line gives the criterion's number, met or unmet, and how it was proved`);
  const n = Number(m[1]);
  if (n < 1 || n > of) refuse(`${at}: CRITERION ${n} is not one of the ${of} acceptance criteria the brief numbers`);
  if (!plain(m[3]).replace(/[*_`]/g, "")) refuse(`${at}: a CRITERION line ends with how the criterion was proved`);
  return { n, met: m[2].toLowerCase() === "met" };
}

function findingLine(line: string, at: string): Finding {
  const m = FINDING_LINE.exec(line);
  if (!m) refuse(`${at}: a FINDING line gives a severity, a file and the finding`);
  const [, severity, token, rest] = m;
  // The file may carry :line or :start-end, and a trailing colon or comma.
  const place = /^(.+?)(?::(\d+)(?:-\d+)?)?$/.exec(token.replace(/^[`'"]+|[`'"]+$/g, "").replace(/[:,]$/, ""));
  const text = plain(rest.replace(/^[-–—:]\s*/, ""));
  if (!text) refuse(`${at} has no text`);
  return {
    file: fileFrom(place?.[1], at),
    line: place?.[2] ? lineFrom(place[2], at) : null,
    severity: severityFrom(severity, at),
    text: clip(text, VERDICT_LIMITS.text),
  };
}
