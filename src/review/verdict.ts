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
import { CHECK_BY, type Finding, type PostDeployCheck } from "../rules.ts";

export type { Finding, PostDeployCheck };

// Blocking findings are what the review bar in force allows to block; every
// other finding is a follow-up and never holds a change back.
export type Severity = Finding["severity"];

// `checks` are the criteria a criteria review flagged as checks after deploy
// (t457): read only when the reply was asked for CHECK lines
// (VerdictOptions.checks), empty otherwise.
export type ParsedVerdict =
  | { ok: true; verdict: "approve" | "reject"; summary: string; findings: Finding[]; checks: PostDeployCheck[] }
  | { ok: false; error: string };

// What a reply was asked for beyond the verdict, summary and findings.
// `checks`: the reply is a criteria review's (CRITERIA_REPLY_FORMAT), and
// its CHECK lines, one per criterion the builder cannot verify in its
// workspace, are read; elsewhere they are prose. `deferred`: the criteria, numbered as
// the brief numbers them, that a criteria review flagged as checks after
// deploy, whose CRITERION line may say deferred instead of met; deferred on
// any other criterion is refused, as unmet is.
//
// `settled` (t717) replaces a rejection's findings with the ones that stand
// after the runner settled them: those answered before dropped, those on
// code the change did not touch labelled pre-existing, those no independent
// check confirmed labelled unverified. A rejection left with no blocking
// finding is then an approval, and read as one: it needs every CRITERION
// line, met. The reply the reviewer wrote is not changed, and an approval
// stays an approval.
//
// `counted` (t718) is set for a code review, whose brief asks for a count line
// (replyFormat's `counted`): the reply must give exactly one BLOCKING: N line,
// N must equal the number of blocking findings the reply itself lists, and
// every blocking finding must name a line, not only a file. A reply that does
// not is refused, so the request is released and asked again. Unset, none of
// this is read, which is how a criteria review, a pre-review and a
// verification, whose briefs ask for no count, are read as they were.
export interface VerdictOptions {
  counted?: boolean;
  checks?: boolean;
  deferred?: readonly number[];
  settled?: readonly Finding[];
}

// A reply longer than `reply` is refused rather than scanned. A list of more
// than `findings` is refused rather than cut, since a cut could drop a
// blocking finding. Text over its cap is cut with an ellipsis, which changes
// no verdict.
// The refusal of a reply with no verdict at all, which the opencode adapter
// answers by asking once more for the verdict lines (t576).
// The first line of a verification brief (src/review/verify.ts). A harness
// adapter reads it to give the verifier the verification format and not this
// review format (cli/harness/adapter.mjs).
export const VERIFY_HEADING = "# Verification of findings";

// The line of a verification brief's reply format that offers PRE-EXISTING,
// present only when the check was given a base commit. The adapter reads it
// to end its prompt with a demand that offers the same answer: a final line
// that allowed fewer answers than the brief would override the brief.
export const VERIFY_BASE_LINE = "FINDING 3: PRE-EXISTING because the same defect is in the code at the base, shown by the lines you read there.";

export const NO_VERDICT = "the reply states no verdict: it has no VERDICT line and no JSON verdict";

export const VERDICT_LIMITS = { reply: 100_000, findings: 50, file: 512, text: 2000, summary: 600 } as const;

// What may block, when the project sets no review bar of its own (`atelier
// init --review-bar`). Every review brief states the bar in force, and
// bin/orchestrate/review.sh reads this one as its default.
export const DEFAULT_REVIEW_BAR = "Block only for a correctness, security or data-loss defect that the change introduces, or fails to fix while claiming to; a behaviour change without a test that covers it; docs or help that now contradict the code; a breaking change to a command, route or API field without a migration; or a visible regression on a user-facing page. A claim in a commit message that the code does not support is a correctness defect. A blocking finding names the file and line and what breaks, and is never style or naming. Decisions the developer made are not defects; anything else is a follow-up.";

const FORMAT_EXAMPLES = [
  "End your reply with these lines, each at the start of its own line:",
  "",
  "VERDICT: APPROVE",
  "SUMMARY: One sentence on what you checked and what you found.",
  "FINDING: follow-up src/example.ts:12 What is wrong, and why it matters.",
];

// A code review's reply begins its findings with the count of the blocking
// ones (t718, after the review guides of Anthropic's code owners): a count a
// reader can check against the lines, so a reply that says "nothing to fix"
// while listing a blocker, or lists a blocker with no line to look at, is
// refused rather than posted.
const COUNT_EXAMPLE = "BLOCKING: 0";
const COUNT_RULE = "Write one BLOCKING line with the number of blocking findings you list, 0 when there are none; it must equal the number of FINDING lines marked blocking. A blocking finding names its file and its line, as PATH:LINE, so the developer can look at the code it means.";
const examples = (counted: boolean) => counted
  ? [...FORMAT_EXAMPLES.slice(0, 4), COUNT_EXAMPLE, ...FORMAT_EXAMPLES.slice(4)]
  : FORMAT_EXAMPLES;
const rules = (counted: boolean) => counted ? [...FORMAT_RULES, COUNT_RULE] : FORMAT_RULES;

const FORMAT_RULES = [
  "The VERDICT line says APPROVE or REJECT and nothing else. Do not write APPROVE, APPROVED, REJECT or REJECTED in capitals anywhere else in your reply: a reply that says both is not read as a verdict.",
  "Write one FINDING line for each finding: its severity (blocking or follow-up), the file, then a colon and the line number when the finding has one, then the finding itself, all on one line.",
  "REJECT needs at least one blocking finding, and APPROVE allows none.",
];

const FORMAT_END = "Prose around these lines is allowed and is not read, apart from the rule on APPROVE and REJECT above.";

export const REPLY_FORMAT = [...FORMAT_EXAMPLES, "", ...FORMAT_RULES, FORMAT_END].join("\n");

// The format a criteria review is asked for (src/review/criteria.ts, t457):
// the same lines, no CRITERION line (the review judges the criteria, it
// does not prove them met), and one CHECK line for each criterion the
// builder cannot verify in its workspace: the criterion's number as the
// brief numbers it, who checks it after deploy (owner, for a human step;
// orchestrator, for a check a script runs against the deployed project),
// then why the builder cannot verify it and what the check is. parseVerdict
// reads the CHECK lines only when asked to (VerdictOptions.checks).
const CHECK_EXAMPLE = "CHECK: criterion-3 owner Why the builder cannot verify it in its workspace, and what is checked after deploy.";
const CHECK_RULE = "Write one CHECK line for each criterion the builder cannot verify in its workspace (it needs a signed-in browser, production data, a deployed service or a human step): criterion-N, then owner for a check a person makes or orchestrator for one a script runs against the deployed project, then why the builder cannot verify it and what the check is, all on one line. A CHECK line is not a finding and blocks nothing: do not also write a blocking FINDING for the same criterion on that ground.";
export const CRITERIA_REPLY_FORMAT = [...FORMAT_EXAMPLES, CHECK_EXAMPLE, "", ...FORMAT_RULES, CHECK_RULE, FORMAT_END].join("\n");

// The format a change with acceptance criteria is asked for: the same lines,
// and one CRITERION line per criterion, each saying met or unmet and how it
// was proved. The reply numbers the criteria across every list the brief
// carries, while each list in the brief keeps its own numbers from 1, as the
// criteria binding stores it (src/criteria.ts): when the brief carries the
// task's own criteria and the plan's for the part, `own` says how many are
// the task's and the format states the mapping — the task's keep the numbers
// its list carries, and the plan's follow after them. A criterion is proved
// by experiment, not by reading, so the reviewer is sent to break the
// change and watch a test fail before calling a criterion met. parseVerdict
// takes the same count of criteria and refuses an approval that misses a
// criterion's line or declares one unmet, so the ask and the reading of the
// answer cannot drift apart either. A count of zero or less, or not a whole
// number, is the format with no criteria. `deferred` names the criteria the
// criteria review flagged as checks after deploy (t457): their CRITERION
// line may say deferred, with what the change built for them, since neither
// the builder nor the reviewer can verify them in a workspace; parseVerdict
// is handed the same numbers.
export function replyFormat(criteria: number, own = 0, deferred: readonly number[] = [], counted = false): string {
  const count = Number.isSafeInteger(criteria) && criteria > 0 ? criteria : 0;
  if (!count) return counted ? [...examples(true), "", ...rules(true), FORMAT_END].join("\n") : REPLY_FORMAT;
  const mine = Number.isSafeInteger(own) && own > 0 ? own : 0;
  const flagged = [...new Set(deferred.filter((n) => Number.isSafeInteger(n) && n >= 1 && n <= count))].sort((a, b) => a - b);
  // How the reply numbers the criteria: as the brief's one list numbers them
  // when there is only one, and across both lists when the task's own
  // criteria and the plan's are carried together.
  const numbering = mine && mine < count
    ? `numbered across both lists above: the task's own acceptance criteria keep the numbers its list carries, 1 to ${mine}, and the plan's acceptance criteria for this part follow as criteria ${mine + 1} to ${count}, though the plan's list above numbers them from 1`
    : "numbered as the brief numbers them";
  return [
    ...examples(counted),
    "CRITERION 1: met — What you did to prove criterion 1 met, and what you saw.",
    ...(flagged.length ? [`CRITERION ${flagged[0]}: deferred — What the change built for criterion ${flagged[0]}, which is checked after deploy.`] : []),
    "",
    ...rules(counted),
    `${criteriaRule(count)}, ${numbering}: CRITERION n, then met or unmet, then how it was proved — what you did, and what you saw. Prefer breaking the change and watching a test fail over reading the code: say what you broke and which test failed. An approval needs every criterion met and proved; one you cannot prove met is unmet, and unmet blocks.`,
    ...(flagged.length ? [`${flagged.length === 1 ? `Criterion ${flagged[0]} was` : `Criteria ${flagged.join(", ")} were`} flagged by the review of the acceptance criteria as ${flagged.length === 1 ? "a check" : "checks"} after deploy: the builder could not verify ${flagged.length === 1 ? "it" : "them"} in a workspace and neither can you. For ${flagged.length === 1 ? "it" : "each"} write CRITERION n, then deferred, then what the change built for it and what the developer or the orchestrator checks after deploy; met is allowed only when you proved it. Deferred is refused on any other criterion: prove it met, or reject with a blocking finding.`] : []),
    FORMAT_END,
  ].join("\n");
}

// The words that open replyFormat's CRITERION rule, and the count of
// criteria read back from a brief that carries it (0 when none does): the
// adapter's second ask of a reviewer whose first reply states no verdict
// (cli/harness/adapter.mjs, t608) asks again for one CRITERION line per
// criterion, and reads how many from the brief the reviewer was given. The
// reply format is the brief's last section, so its rule is the last match;
// criteria quoted earlier in the brief do not change the count.
const criteriaRule = (count: number) => `Write one CRITERION line for each of the ${count} acceptance criteria`;
const CRITERIA_RULE = /Write one CRITERION line for each of the (\d+) acceptance criteria/g;
export function criteriaAsked(brief: string): number {
  const last = [...String(brief).matchAll(CRITERIA_RULE)].at(-1);
  const count = last ? Number(last[1]) : 0;
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
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

type Statement = { verdict: "approve" | "reject"; summary: string; findings: Finding[]; checks: PostDeployCheck[] };
class Refusal extends Error {}
function refuse(message: string): never {
  throw new Refusal(message);
}

// `criteria` is how many acceptance criteria the brief numbered, as
// reviewBrief counts them; a reply to that brief must prove each with a
// CRITERION line, and an approval that misses one or declares one unmet is
// refused. Without criteria (the default) CRITERION lines are not read.
// `options` says whether CHECK lines are read (a criteria review's reply)
// and which criteria may be deferred (VerdictOptions).
export function parseVerdict(text: unknown, criteria = 0, options: VerdictOptions = {}): ParsedVerdict {
  try {
    return { ok: true, ...read(text, criteria, options) };
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, error: err.message };
    throw err;
  }
}

function read(raw: unknown, asked: number, options: VerdictOptions): Statement {
  if (typeof raw !== "string") refuse("the reply is not text");
  const reply = normalise(raw);
  if (reply.length > VERDICT_LIMITS.reply) refuse(`the reply is ${reply.length} characters, over the ${VERDICT_LIMITS.reply} a verdict needs`);
  const criteria = Number.isSafeInteger(asked) && asked > 0 ? asked : 0;
  const withChecks = options.checks === true;
  const deferrable = new Set((options.deferred ?? []).filter((n) => Number.isSafeInteger(n) && n >= 1));

  const json = jsonStatements(reply, withChecks);
  const lines = lineStatements(reply, criteria, withChecks);
  const verdicts = new Set([...json.map((s) => s.verdict), ...lines.verdicts]);
  if (!verdicts.size) refuse(NO_VERDICT);
  // Lowercase approve and reject are ordinary words in a review of code that
  // approves and rejects things, so only the capitalised keywords count as
  // saying a verdict. A capitalised keyword for the other verdict anywhere,
  // in prose, a quotation or a finding, makes the reply ambiguous.
  for (const match of reply.matchAll(/\b(APPROVED?|REJECT(?:ED)?)\b/g)) verdicts.add(match[1].startsWith("A") ? "approve" : "reject");
  if (verdicts.size > 1) refuse("the reply says both APPROVE and REJECT, so it is not a verdict");
  let verdict = [...verdicts][0];

  if (json.length && lines.findings.length) refuse("the reply gives findings both as JSON and as FINDING lines");
  if (json.length && lines.checks.length) refuse("the reply gives checks both as JSON and as CHECK lines");
  if (new Set(json.map((s) => JSON.stringify(s))).size > 1) refuse(`the reply has ${json.length} JSON verdicts that differ`);
  let findings = json.length ? json[0].findings : lines.findings;
  const checks = json.length ? json[0].checks : lines.checks;
  const summary = json.length ? json[0].summary : clip(lines.summary.join(" "), VERDICT_LIMITS.summary);
  if (findings.length > VERDICT_LIMITS.findings) refuse(`the reply has ${findings.length} findings, over the limit of ${VERDICT_LIMITS.findings}`);
  if (checks.length > VERDICT_LIMITS.findings) refuse(`the reply has ${checks.length} checks, over the limit of ${VERDICT_LIMITS.findings}`);
  // One check per criterion: two CHECK lines on one criterion are two
  // readings of the same check, not two checks.
  const twice = checks.map((c) => c.criterion).filter((n, i, all) => all.indexOf(n) !== i);
  if (twice.length) refuse(`the reply flags criterion ${twice[0]} as a check after deploy twice; write one CHECK line per criterion`);
  // A counted reply (t718) says how many of its findings block, and each of
  // those names a line. This reads the reply as written, before the runner's
  // settling replaces its findings below: the count is the reviewer's own.
  if (options.counted) {
    const stated = [...new Set(lines.counts)];
    if (!stated.length) refuse("the reply has no BLOCKING line: a review begins its findings with the count of blocking findings, as BLOCKING: 0");
    if (stated.length > 1) refuse(`the reply gives different counts of blocking findings: ${stated.join(" and ")}`);
    const written = findings.filter((f) => f.severity === "blocking");
    if (stated[0] !== written.length) refuse(`the reply says BLOCKING: ${stated[0]} and lists ${written.length} blocking ${written.length === 1 ? "finding" : "findings"}`);
    const unplaced = written.filter((f) => f.line === null);
    if (unplaced.length) refuse(`a blocking finding names a line, as PATH:LINE; ${unplaced.length === 1 ? `the one in ${unplaced[0].file} does not` : `${unplaced.length} do not`}`);
  }
  if (verdict === "reject" && options.settled) {
    findings = [...options.settled];
    if (!findings.some((f) => f.severity === "blocking")) verdict = "approve";
  }
  const blocking = findings.filter((f) => f.severity === "blocking").length;
  if (verdict === "reject" && !blocking) refuse("a rejection must name at least one blocking finding; every other finding is a follow-up");
  if (verdict === "approve" && blocking) refuse(`an approval cannot carry ${blocking === 1 ? "a blocking finding" : `${blocking} blocking findings`}; reject, or mark the finding a follow-up`);
  // A criterion may be deferred only when the criteria review flagged it as
  // a check after deploy (options.deferred): on any other, deferred is a
  // way round proving it, and is refused whatever the verdict.
  const deferredWrongly = [...lines.criteria].filter(([n, state]) => state === "deferred" && !deferrable.has(n)).map(([n]) => n);
  if (deferredWrongly.length) refuse(`${deferredWrongly.length === 1 ? "criterion" : "criteria"} ${deferredWrongly.join(", ")} ${deferredWrongly.length === 1 ? "is not a check" : "are not checks"} after deploy the review of the acceptance criteria flagged, so ${deferredWrongly.length === 1 ? "it" : "they"} cannot be deferred: prove ${deferredWrongly.length === 1 ? "it" : "each"} met, or reject with a blocking finding`);
  // An approval proves every acceptance criterion: one CRITERION line each,
  // each met, or deferred where the criteria review flagged the criterion
  // as a check after deploy. A missing line leaves the criterion unproved,
  // and a line that says unmet is a correctness fault the approval cannot
  // carry, as a blocking finding is below. A rejection needs no criterion
  // lines: its blocking findings say what they say.
  if (verdict === "approve" && criteria) {
    const missing: number[] = [];
    const unmet: number[] = [];
    for (let n = 1; n <= criteria; n++) {
      const state = lines.criteria.get(n);
      if (state === undefined) missing.push(n);
      else if (state === "unmet") unmet.push(n);
    }
    if (missing.length) refuse(`an approval needs a CRITERION line for each of the ${criteria} acceptance criteria: ${missing.length === 1 ? "criterion" : "criteria"} ${missing.join(", ")} ${missing.length === 1 ? "has" : "have"} none`);
    if (unmet.length) refuse(`an approval cannot declare ${unmet.length === 1 ? "criterion" : "criteria"} ${unmet.join(", ")} unmet; an unmet criterion is a correctness fault, so reject with a blocking finding`);
  }
  return { verdict, summary, findings, checks };
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

function jsonStatements(reply: string, withChecks: boolean): Statement[] {
  const found: Record<string, unknown>[] = [];
  const keys = jsonValues(reply).reduce((n: number, v) => n + collect(v, found), 0);
  // Every verdict key written in the reply must have been read from valid
  // JSON. This refuses a malformed verdict object, a verdict field in prose,
  // and a duplicated key, which JSON.parse would silently collapse to its
  // last value.
  const written = reply.match(/"(?:verdict|approve)"\s*:/gi)?.length ?? 0;
  if (written !== keys) refuse(`the reply writes ${written} "verdict" or "approve" ${written === 1 ? "field" : "fields"} and ${keys} could be read from valid JSON`);
  return found.map((o, i) => statementFrom(o, found.length > 1 ? `JSON verdict ${i + 1}` : "the JSON verdict", withChecks));
}

// One field by any of its names, in any case. Two names given different
// values is a contradiction, not a choice.
function field(o: Record<string, unknown>, names: string[], at: string): unknown {
  const values = Object.keys(o).filter((k) => names.includes(k.toLowerCase())).map((k) => o[k]);
  if (new Set(values.map((v) => JSON.stringify(v))).size > 1) refuse(`${at} gives ${names.join(" and ")} different values`);
  return values[0];
}

function statementFrom(o: Record<string, unknown>, at: string, withChecks: boolean): Statement {
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
  // A "checks" list is read only from a criteria review's reply; elsewhere
  // the field is not the reply's to give, and is left unread.
  const flagged = withChecks ? field(o, ["checks"], at) ?? [] : [];
  if (!Array.isArray(flagged)) refuse(`${at}: "checks" must be a list`);
  const checks = flagged.map((entry: unknown, i) => checkFrom(entry, `${at}, check ${i + 1}`));
  return { verdict, summary: clip(plain(summary), VERDICT_LIMITS.summary), findings, checks };
}

// One check after deploy as JSON: {criterion, by, text}, the criterion by
// its number or as the brief names it (criterion-N).
function checkFrom(entry: unknown, at: string): PostDeployCheck {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) refuse(`${at} is not an object`);
  const o = entry as Record<string, unknown>;
  const text = field(o, ["text", "note"], at);
  if (typeof text !== "string" || !plain(text)) refuse(`${at} has no text`);
  return {
    criterion: criterionFrom(field(o, ["criterion", "file"], at), at),
    by: checkByFrom(field(o, ["by"], at), at),
    text: clip(plain(text), VERDICT_LIMITS.text),
  };
}

function criterionFrom(value: unknown, at: string): number {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim().replace(/^[`'"]+|[`'"]+$/g, "") : "";
  const m = /^(?:criterion[-\s]*)?\[?(\d+)\]?$/i.exec(text);
  const n = m ? Number(m[1]) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) refuse(`${at}: a check names its criterion by number, as the brief numbers them`);
  return n;
}

function checkByFrom(value: unknown, at: string): PostDeployCheck["by"] {
  const by = typeof value === "string" ? value.trim().toLowerCase() : "";
  const named = CHECK_BY.find((b) => b === by);
  if (!named) refuse(`${at}: a check is made by owner or orchestrator, not ${JSON.stringify(value ?? null)}`);
  return named;
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
// The count line of a counted reply (t718): "BLOCKING: 2", decoration and a
// closing full stop allowed. "FINDING: blocking ..." starts with FINDING and
// is read as a finding before this is tried.
const COUNT_LINE = new RegExp(`^blocking${E}\\s*:\\s*${E}\\s*(\\d{1,6})\\s*${E}\\s*[.!]?\\s*${E}\\s*$`, "i");
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
// word, as a \b would read it. The closing formatting around the word, and
// the separator after it, are consumed before the proof is taken, so neither
// markers nor a bare dash can stand in as the proof.
const CRITERION_LINE = new RegExp(`^criterion${E}\\s*:?\\s*${E}\\[?(\\d+)\\]?${E}\\s*:?\\s*${E}\\s*\\[?(unmet|not met|met|deferred)(?![a-z0-9])\\]?${E}\\s*(?:[-–—:]\\s*)?${E}\\s*(.*?)\\s*$`, "i");
// A CHECK line (t457): "CHECK:" in any case, or "CHECK " in capitals;
// "Checks:" is a heading and "Check the" is prose. Only a reply asked for
// checks (CRITERIA_REPLY_FORMAT) has its CHECK lines read; elsewhere they
// are prose. The line names the criterion as the brief does (criterion-N, or its
// number alone), who checks it, and the check.
const CHECK_COLON = new RegExp(`^check${E}\\s*:`, "i");
const checkHead = (line: string) => CHECK_COLON.test(line) || /^CHECK\s/.test(line);
const CHECK_LINE = new RegExp(`^check${E}\\s*:?\\s*${E}\\s*(?:criterion[-\\s]*)?\\[?(\\d+)\\]?${E}\\s*:?\\s*${E}\\s*\\[?(owner|orchestrator)(?![a-z0-9])\\]?${E}\\s*(?:[-–—:]\\s*)?${E}\\s*(.*?)\\s*$`, "i");

// What a CRITERION line says of its criterion: met, unmet, or deferred to a
// check after deploy (t457).
type CriterionState = "met" | "unmet" | "deferred";

function lineStatements(reply: string, criteria: number, withChecks: boolean): { verdicts: Statement["verdict"][]; findings: Finding[]; checks: PostDeployCheck[]; summary: string[]; counts: number[]; criteria: Map<number, CriterionState> } {
  const counts: number[] = [];
  const verdicts: Statement["verdict"][] = [];
  const findings: Finding[] = [];
  const checks: PostDeployCheck[] = [];
  const summary: string[] = [];
  const states = new Map<number, CriterionState>();
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
    else if (COUNT_LINE.test(line)) counts.push(Number(COUNT_LINE.exec(line)![1]));
    else if (withChecks && checkHead(line)) checks.push(checkLine(line, at));
    else if (criteria && criterionHead(line)) {
      const c = criterionLine(line, at, criteria);
      // The same criterion proved twice must be proved one way.
      if (states.has(c.n) && states.get(c.n) !== c.state) refuse(`the reply proves criterion ${c.n} both ${states.get(c.n)} and ${c.state}`);
      states.set(c.n, c.state);
    }
    else {
      const s = SUMMARY_LINE.exec(line);
      if (s && plain(s[1])) summary.push(plain(s[1]));
    }
  });
  return { verdicts, findings, checks, summary, counts, criteria: states };
}

// One CRITERION line: the criterion's number as the brief numbers it, met,
// unmet or deferred, then how it was proved — the proof is the point of the
// line, so a line without one is refused rather than read as a bare met. The
// pattern takes an empty proof so the refusal can name the missing proof,
// not the line's shape. It consumes the closing formatting around the word
// (**, __, backticks) and the separator before the proof, and the check
// counts none of the markers, separators or whitespace left in what it takes
// as proof either, so only the proof's words are.
function criterionLine(line: string, at: string, of: number): { n: number; state: CriterionState } {
  const m = CRITERION_LINE.exec(line);
  if (!m) refuse(`${at}: a CRITERION line gives the criterion's number, met, unmet or deferred, and how it was proved`);
  const n = Number(m[1]);
  if (n < 1 || n > of) refuse(`${at}: CRITERION ${n} is not one of the ${of} acceptance criteria the brief numbers`);
  if (!plain(m[3]).replace(/[*_`\s:–—-]/g, "")) refuse(`${at}: a CRITERION line ends with how the criterion was proved`);
  const word = m[2].toLowerCase();
  return { n, state: word === "met" ? "met" : word === "deferred" ? "deferred" : "unmet" };
}

// One CHECK line: the criterion, who checks it after deploy, and the check.
function checkLine(line: string, at: string): PostDeployCheck {
  const m = CHECK_LINE.exec(line);
  if (!m) refuse(`${at}: a CHECK line gives the criterion (criterion-N), owner or orchestrator, and what is checked after deploy`);
  const text = plain(m[3]);
  if (!text.replace(/[*_`\s:–—-]/g, "")) refuse(`${at}: a CHECK line ends with why the builder cannot verify the criterion and what is checked after deploy`);
  return { criterion: criterionFrom(m[1], at), by: checkByFrom(m[2], at), text: clip(text, VERDICT_LIMITS.text) };
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
