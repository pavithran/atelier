// Reading a reviewer's reply. The brief asks for VERDICT, SUMMARY and FINDING
// lines, and REPLY_FORMAT below is the only statement of that format, so the
// brief and this parser cannot drift apart. Models wrap their answers in
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

export const REPLY_FORMAT = [
  "End your reply with these lines, each at the start of its own line:",
  "",
  "VERDICT: APPROVE",
  "SUMMARY: One sentence on what you checked and what you found.",
  "FINDING: follow-up src/example.ts:12 What is wrong, and why it matters.",
  "",
  "The VERDICT line says APPROVE or REJECT and nothing else. Do not write APPROVE, APPROVED, REJECT or REJECTED in capitals anywhere else in your reply: a reply that says both is not read as a verdict.",
  "Write one FINDING line for each finding: its severity (blocking or follow-up), the file, then a colon and the line number when the finding has one, then the finding itself, all on one line.",
  "REJECT needs at least one blocking finding, and APPROVE allows none.",
  "Prose around these lines is allowed and is not read, apart from the rule on APPROVE and REJECT above.",
].join("\n");

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

export function parseVerdict(text: unknown): ParsedVerdict {
  try {
    return { ok: true, ...read(text) };
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, error: err.message };
    throw err;
  }
}

function read(raw: unknown): Statement {
  if (typeof raw !== "string") refuse("the reply is not text");
  const reply = normalise(raw);
  if (reply.length > VERDICT_LIMITS.reply) refuse(`the reply is ${reply.length} characters, over the ${VERDICT_LIMITS.reply} a verdict needs`);

  const json = jsonStatements(reply);
  const lines = lineStatements(reply);
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

function lineStatements(reply: string): { verdicts: Statement["verdict"][]; findings: Finding[]; summary: string[] } {
  const verdicts: Statement["verdict"][] = [];
  const findings: Finding[] = [];
  const summary: string[] = [];
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
    else {
      const s = SUMMARY_LINE.exec(line);
      if (s && plain(s[1])) summary.push(plain(s[1]));
    }
  });
  return { verdicts, findings, summary };
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
