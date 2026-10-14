// Triage before the review (t475): atelier land asks one model to read the
// merged diff against the task's acceptance criteria before it asks for the
// independent review, so a change that plainly misses a criterion goes back
// to its holder without spending a review round. Triage is not a review. It
// is recorded as land.triage events, never in the reviews the gate counts
// (src/rules.ts), so it adds no approval, no rejection and no round, and
// src/review/needed.ts never reads it. Its only power is to stop a landing
// before the review request; passing it, or the owner bypassing it, hands
// the landing back to the review rules as they are.
//
// This module holds the pure parts the landing (cli/land.mjs) uses: which
// model triages (resolveTriage), whether that model may (triageModelRefusal),
// the brief and the reply format, the reading of the reply (parseTriage) and
// the decision (decideTriage), and the binding a result stands for: the
// pushed head, its merge base with the target and the criteria's hash
// (src/criteria.ts), so a result is used only while all three are the same.

import { criteriaOf, validBinding } from "../criteria.ts";
import { exactEntry, paidPerToken, storedActor, type ModelEntry } from "../models/pool.ts";
import { TEXT_CONTROLS } from "../text.ts";

export type TriageStatus = "met" | "not-met" | "unsure";

export interface TriageResult {
  n: number;                    // the criterion's number across the brief's lists, from 1
  status: TriageStatus;
  evidence: string;
  file: string | null;          // where the evidence is, when a location applies
  line: number | null;
  noLocation: string | null;    // why no location applies, when none is given
}

export type ParsedTriage =
  | { ok: true; results: TriageResult[]; unverified: string[] }
  | { ok: false; error: string };

// What a result stands for. A result is used only while the pushed head, its
// merge base with the target branch and the criteria binding are all the
// ones it was made at; a change to any of them triages again.
export interface TriageBinding {
  head: string;
  base: string;
  criteria: string;
}

export const sameBinding = (a: TriageBinding | null | undefined, b: TriageBinding | null | undefined): boolean =>
  !!a && !!b && a.head === b.head && a.base === b.base && a.criteria === b.criteria;

export const TRIAGE_LIMITS = { reply: 200_000, evidence: 2000, reason: 600, file: 512, unverified: 50 } as const;

// The harnesses whose adapters Atelier ships (bin/harness), and so the ones
// a triage model can run under on the owner's machine.
export const TRIAGE_HARNESSES = ["claude-code", "codex", "opencode", "antigravity"] as const;

const ACTOR = /^[^/\s]+\/[^/\s]+$/;

export type TriageChoice =
  | { mode: "model"; actor: string; source: "--triage" | "project.triage"; override: string | null }
  | { mode: "bypass"; reason: string }
  | { mode: "off" };

// Which triage a landing runs: --triage H/M, then the project's triage
// setting; neither is no triage. --no-triage REASON bypasses a configured
// triage, and --override-triage REASON lets a triage that stops be
// overridden; both are the owner's, and both need a reason. Conflicting
// flags are refused rather than one silently winning. Answers the choice, or
// the refusal as text.
export function resolveTriage(input: { triage?: unknown; noTriage?: unknown; override?: unknown; project?: unknown }): TriageChoice | { error: string } {
  const { triage, noTriage, override, project } = input;
  const reasonOf = (value: unknown) => (typeof value === "string" ? plain(value) : "");
  if (triage !== undefined && (typeof triage !== "string" || !ACTOR.test(triage))) return { error: "--triage needs harness/model, such as codex/gpt-6-astra: atelier land ID --triage H/M" };
  if (noTriage !== undefined && !reasonOf(noTriage)) return { error: "--no-triage needs the reason the triage is bypassed, which is recorded: atelier land ID --no-triage \"REASON\"" };
  if (override !== undefined && !reasonOf(override)) return { error: "--override-triage needs the reason a stopped triage is overridden, which is recorded: atelier land ID --override-triage \"REASON\"" };
  if (noTriage !== undefined && triage !== undefined) return { error: "--triage and --no-triage together say two things; name the triage model, or bypass the triage with a reason" };
  if (noTriage !== undefined && override !== undefined) return { error: "--no-triage and --override-triage together say two things: --no-triage skips the triage, --override-triage runs it and goes on past a stop; give one" };
  if (project !== undefined && project !== null && (typeof project !== "string" || !ACTOR.test(project))) {
    return { error: `the project's triage setting must be harness/model, such as codex/gpt-6-astra, not ${JSON.stringify(project)}` };
  }
  const actor = typeof triage === "string" ? triage : typeof project === "string" ? project : null;
  if (noTriage !== undefined) {
    if (!actor) return { error: "--no-triage bypasses a triage, and this landing has none (no --triage, and the project sets no triage); leave it out" };
    return { mode: "bypass", reason: clip(reasonOf(noTriage), TRIAGE_LIMITS.reason) };
  }
  if (!actor) {
    if (override !== undefined) return { error: "--override-triage overrides a triage that stops, and this landing has none (no --triage, and the project sets no triage); leave it out" };
    return { mode: "off" };
  }
  const harness = actor.slice(0, actor.indexOf("/"));
  if (!(TRIAGE_HARNESSES as readonly string[]).includes(harness)) return { error: `the triage model ${actor} runs under ${harness}, and Atelier ships adapters for ${TRIAGE_HARNESSES.join(", ")} only` };
  return { mode: "model", actor, source: typeof triage === "string" ? "--triage" : "project.triage", override: override === undefined ? null : clip(reasonOf(override), TRIAGE_LIMITS.reason) };
}

// The project's triage setting as `atelier init --triage H/M` records it
// (ProjectPolicy.triage): a model under a harness Atelier ships an adapter
// for. Answers why it cannot be the setting, or null. Clearing it ("" or
// null) is the caller's to read before asking.
export function triageSettingRefusal(value: unknown): string | null {
  if (typeof value !== "string" || !ACTOR.test(value)) return "the triage model must be harness/model, such as codex/gpt-6-astra, or \"\" to clear it";
  const harness = value.slice(0, value.indexOf("/"));
  if (!(TRIAGE_HARNESSES as readonly string[]).includes(harness)) return `the triage model ${value} runs under ${harness}, and Atelier ships adapters for ${TRIAGE_HARNESSES.join(", ")} only`;
  return null;
}

// The model-access and cost rules a review outside a plan follows, applied
// to the triage model: it is in the pool, its status is not refused, and it
// is not paid per token, since nothing here approved paid models. Its family
// is not asked: triage is not the independent review, so a model of the
// builder's own company may triage. Answers why it may not, or null.
export function triageModelRefusal(actor: string, pool: readonly ModelEntry[], exact = false): string | null {
  // The triage model is an exact id when written since names are converted
  // where typed (`exact`: policy.exactNames lists triage, or a landing's
  // --triage converted at the API); one written before may be an alias, read
  // through storedActor (src/models/pool.ts, identity).
  const entry = exactEntry(pool, exact ? actor : storedActor(pool, actor));
  if (!entry) return `${actor} is not in the model pool (atelier models add)`;
  if (entry.status?.state === "refused") return `${actor}'s status is refused, reported by ${entry.status.by} at ${entry.status.at}${entry.status.detail ? `: ${entry.status.detail}` : ""}`;
  if (paidPerToken(entry)) return `${actor} is paid per token (${entry.provider}), and paid models are not allowed outside an approved plan`;
  return null;
}

// The reply format, the one statement of it, so the brief and parseTriage
// cannot drift apart.
export function triageFormat(count: number): string {
  return [
    "End your reply with one JSON object, on lines of its own, in this shape:",
    "",
    "{\"triage\": [",
    "  {\"criterion\": 1, \"status\": \"met\", \"evidence\": \"What you read or ran, and what it showed.\", \"file\": \"src/example.ts\", \"line\": 12},",
    "  {\"criterion\": 2, \"status\": \"unsure\", \"evidence\": \"What you could not establish, and why.\", \"noLocation\": \"Why no file or line applies.\"}",
    "], \"unverified\": [\"Runtime behaviour the change depends on that you could not verify here.\"]}",
    "",
    `Give exactly one entry for each of the ${count} criteria, numbered as the brief numbers them. status is met, not-met or unsure: met only when the evidence shows it; not-met when the change misses it; unsure when you cannot tell. Every entry gives its evidence and either the file (with the line, when one applies) the evidence lives in, or noLocation saying why no location applies. unverified lists every production behaviour the change relies on that cannot be checked from this workspace (a platform limit, a deployed service, a runtime the tests do not run); give an empty list when there is none.`,
    "Write no VERDICT, APPROVE or REJECT: this is a triage, not a review, and any closing instruction to write VERDICT, SUMMARY or FINDING lines does not apply to it. Only the JSON object is read.",
  ].join("\n");
}

export interface TriageBriefInput {
  project: string;
  id: string;
  title: string;
  brief: string;
  task: readonly string[];            // the task's own acceptance criteria
  part?: readonly string[] | null;    // a plan part's acceptance criteria, numbered after the task's
  binding: TriageBinding;
  target: string;                     // the branch the merge base is taken against
  changedPaths: readonly string[];
}

// The criteria as one list: the task's own first, then a part's, numbered
// across both as the reply numbers them.
export function triageCriteria(task: readonly string[], part?: readonly string[] | null): string[] {
  return [...task, ...(part ?? [])];
}

export function triageBrief(input: TriageBriefInput): string {
  const criteria = triageCriteria(input.task, input.part);
  const { head, base, criteria: hash } = input.binding;
  return [
    `Triage of ${input.project}/${input.id}: ${input.title}`,
    "",
    "You are triaging a change before its independent review. Judge each acceptance criterion against the change as it is at the head below, and say met, not-met or unsure for each. You may read files and run the project's tests in this folder; edit nothing, do not push, and run no atelier command.",
    "",
    `Head: ${head}`,
    `Merge base with ${input.target}: ${base}`,
    `Criteria binding: ${hash}`,
    `Changed paths (${input.changedPaths.length}): ${input.changedPaths.slice(0, 200).join(", ") || "none"}`,
    "",
    "The task's brief:",
    input.brief.trim() || "(no brief)",
    "",
    "Acceptance criteria:",
    ...criteria.map((c, i) => `${i + 1}. ${c}${input.part?.length && i >= input.task.length ? " (the plan's criterion for this part)" : ""}`),
    "",
    "How to judge:",
    "- Trace each relevant production request path end to end: from where a request or command enters (a route, a CLI command, a Workflow step) through every function the change touches to what it writes or answers. A criterion met only in a test, or only on a path production never takes, is not met.",
    "- Name every runtime behaviour the change depends on that you could not verify here (a platform limit, a deployed service, a clock, a network), in unverified, and mark a criterion unsure where its being met turns on one.",
    "- Point at the evidence: a file and line where the behaviour lives or is tested, or say why no location applies.",
    "",
    triageFormat(criteria.length),
  ].join("\n");
}

// Read as own properties only: a status such as "constructor" or
// "__proto__" names nothing here, not something Object.prototype has.
const STATUSES: Readonly<Record<string, TriageStatus>> = Object.freeze(Object.assign(Object.create(null), {
  met: "met", "not-met": "not-met", "not met": "not-met", not_met: "not-met", notmet: "not-met", unmet: "not-met", unsure: "unsure",
}));
const statusOf = (value: unknown): TriageStatus | undefined => {
  if (typeof value !== "string") return undefined;
  const key = value.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(STATUSES, key) ? STATUSES[key] : undefined;
};

class Refusal extends Error {}
function refuse(message: string): never { throw new Refusal(message); }
const plain = (s: string) => s.replace(TEXT_CONTROLS, " ").replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Reads a triage reply against the number of criteria the brief numbered.
// Nothing is guessed: no JSON object, two that differ, a criterion missing,
// repeated or out of range, a status not one of the three, an entry with no
// evidence or with neither a location nor a reason none applies, and an
// unverified that is not a list, are each refused with the reason.
export function parseTriage(text: unknown, count: number): ParsedTriage {
  try { return { ok: true, ...read(text, count) }; }
  catch (err) {
    if (err instanceof Refusal) return { ok: false, error: err.message };
    throw err;
  }
}

function read(raw: unknown, count: number): { results: TriageResult[]; unverified: string[] } {
  if (typeof raw !== "string") refuse("the reply is not text");
  if (raw.length > TRIAGE_LIMITS.reply) refuse(`the reply is ${raw.length} characters, over the ${TRIAGE_LIMITS.reply} a triage needs`);
  const found = jsonObjects(raw).filter((o) => Object.keys(o).some((k) => k.toLowerCase() === "triage"));
  if (!found.length) refuse("the reply has no JSON object with a \"triage\" list");
  if (new Set(found.map((o) => JSON.stringify(o))).size > 1) refuse(`the reply has ${found.length} triage objects that differ`);
  const o = found[0];
  const list = o[Object.keys(o).find((k) => k.toLowerCase() === "triage")!];
  if (!Array.isArray(list)) refuse("\"triage\" must be a list, one entry per criterion");
  const results = list.map((entry, i) => resultFrom(entry, `entry ${i + 1}`, count));
  const seen = new Set<number>();
  for (const r of results) {
    if (seen.has(r.n)) refuse(`criterion ${r.n} is triaged more than once`);
    seen.add(r.n);
  }
  const missing = Array.from({ length: count }, (_, i) => i + 1).filter((n) => !seen.has(n));
  if (missing.length) refuse(`${missing.length === 1 ? "criterion" : "criteria"} ${missing.join(", ")} ${missing.length === 1 ? "has" : "have"} no triage entry`);
  const rawUnverified = o.unverified;
  if (!Array.isArray(rawUnverified) || !rawUnverified.every((u) => typeof u === "string")) refuse("\"unverified\" must be a list of the runtime behaviour that could not be verified, empty when there is none");
  if (rawUnverified.length > TRIAGE_LIMITS.unverified) refuse(`"unverified" has ${rawUnverified.length} entries, over the limit of ${TRIAGE_LIMITS.unverified}`);
  const unverified = rawUnverified.map((u) => clip(plain(u), TRIAGE_LIMITS.evidence)).filter(Boolean);
  return { results: results.sort((a, b) => a.n - b.n), unverified };
}

function resultFrom(entry: unknown, at: string, count: number): TriageResult {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) refuse(`${at} is not an object`);
  const o = entry as Record<string, unknown>;
  const n = o.criterion ?? o.n;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1 || n > count) refuse(`${at}: "criterion" must be a number from 1 to ${count}`);
  const status = statusOf(o.status);
  if (!status) refuse(`${at}: "status" must be met, not-met or unsure, not ${JSON.stringify(o.status ?? null)}`);
  const evidence = typeof o.evidence === "string" ? plain(o.evidence) : "";
  if (!evidence) refuse(`${at} (criterion ${n}) gives no evidence`);
  const file = typeof o.file === "string" ? o.file.trim().replace(/^\.\//, "") : null;
  if (o.file !== undefined && o.file !== null && !file) refuse(`${at} (criterion ${n}): "file" must name a file`);
  if (file && (file.length > TRIAGE_LIMITS.file || /[\u0000-\u001f\u007f-\u009f]/.test(file))) refuse(`${at} (criterion ${n}) names a file Atelier cannot record`);
  let line: number | null = null;
  if (o.line !== undefined && o.line !== null) {
    if (!file) refuse(`${at} (criterion ${n}) gives a line without a file`);
    if (typeof o.line !== "number" || !Number.isSafeInteger(o.line) || o.line < 1) refuse(`${at} (criterion ${n}): "line" must be a positive whole number`);
    line = o.line;
  }
  const noLocation = typeof o.noLocation === "string" ? plain(o.noLocation) : "";
  if (!file && !noLocation) refuse(`${at} (criterion ${n}) gives neither a file nor noLocation saying why no location applies`);
  return { n, status, evidence: clip(evidence, TRIAGE_LIMITS.evidence), file, line, noLocation: file ? null : clip(noLocation, TRIAGE_LIMITS.evidence) };
}

// Every JSON object in the text that parses, outermost first; braces inside
// strings are skipped, and a brace that opens no valid object is passed.
function jsonObjects(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let i = text.indexOf("{"); i !== -1;) {
    const end = closingBrace(text, i);
    if (end !== -1) {
      try {
        const value: unknown = JSON.parse(text.slice(i, end + 1));
        if (value && typeof value === "object" && !Array.isArray(value)) {
          out.push(value as Record<string, unknown>);
          i = text.indexOf("{", end + 1);
          continue;
        }
      } catch { /* not JSON from this brace */ }
    }
    i = text.indexOf("{", i + 1);
  }
  return out;
}

function closingBrace(text: string, start: number): number {
  let depth = 0, inString = false;
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

// Only every criterion met goes on to the review: each status must be met,
// so a status that is neither not-met nor unsure stops too. Anything else
// stops the landing, naming the criteria not met and those the model was
// unsure of, and any whose status is none of the three as not met.
export function decideTriage(results: readonly TriageResult[]): { proceed: boolean; notMet: number[]; unsure: number[] } {
  const unsure = results.filter((r) => r.status === "unsure").map((r) => r.n);
  const notMet = results.filter((r) => r.status !== "met" && r.status !== "unsure").map((r) => r.n);
  return { proceed: results.length > 0 && results.every((r) => r.status === "met"), notMet, unsure };
}

// One line per criterion, as the landing prints a triage's findings.
export function triageLines(results: readonly TriageResult[], criteria: readonly string[]): string[] {
  return results.map((r) => {
    const where = r.file ? `${r.file}${r.line ? `:${r.line}` : ""}` : `no location: ${r.noLocation}`;
    const text = criteria[r.n - 1] ?? "";
    return `  ${r.n}. ${r.status} — ${clip(plain(text), 120)}\n     ${r.evidence} (${where})`;
  });
}

// The land.triage record the landing keeps on the ledger, as the server's
// land step takes it (src/ledger.ts): the binding, the triage model, the
// outcome, each criterion's status and, for a bypass or an override, the
// owner's reason. The ledger records who made it.
export type TriageOutcome = "passed" | "stopped" | "bypassed" | "overridden";

export function triageRecord(binding: TriageBinding, outcome: TriageOutcome, extra: { triager?: string | null; statuses?: readonly TriageResult[]; reason?: string }): Record<string, unknown> {
  return {
    head: binding.head, base: binding.base, criteria: binding.criteria, outcome,
    ...(extra.triager ? { triager: extra.triager } : {}),
    ...(extra.statuses ? { statuses: extra.statuses.map((r) => `${r.n}:${r.status}`) } : {}),
    ...(extra.reason ? { reason: clip(plain(extra.reason), 500) } : {}),
  };
}

// A triage recorded earlier at the same binding, read from the item's
// land.triage events, newest last: a pass by the same model stands, so a
// landing run again at the same head, base and criteria does not ask the
// model twice; a stop is what --override-triage overrides.
export interface TriageEvent { kind: string; seq?: number; data?: Record<string, unknown> }

export function recordedTriage(events: readonly TriageEvent[], binding: TriageBinding, outcome: TriageOutcome, triager?: string): TriageEvent | null {
  const at = events.filter((e) => e.kind === "land.triage" && e.data?.outcome === outcome
    && sameBinding({ head: String(e.data?.head ?? ""), base: String(e.data?.base ?? ""), criteria: String(e.data?.criteria ?? "") }, binding)
    && (triager === undefined || String(e.data?.triager ?? "").toLowerCase() === triager.toLowerCase()));
  return at.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).at(-1) ?? null;
}

// The outcomes that let a landing go on to the submission and the review:
// every criterion met, or the owner's recorded bypass or override.
const GOES_ON: readonly TriageOutcome[] = ["passed", "bypassed", "overridden"];

// Whether a triage still stands for a landing about to submit or to ask for
// the review, as the landing Workflow asks it from the Ledger (t475): the
// task's head is the triaged head, its criteria are the triaged criteria,
// and a land.triage record at that whole binding (head, merge base and
// criteria) let the landing go on. Answers why it does not stand, or null.
export function triageStandsRefusal(item: { head?: string | null; accept?: readonly string[] | null; partAccept?: readonly string[] | null }, events: readonly TriageEvent[], binding: Partial<TriageBinding> | null | undefined): string | null {
  if (!binding || typeof binding.head !== "string" || typeof binding.base !== "string" || !validBinding(binding.criteria)) return "the workspace reported no triage binding (head, merge base and criteria) for this landing";
  const bound = binding as TriageBinding;
  if (item.head !== bound.head) return `the head moved from the triaged ${bound.head.slice(0, 8)} to ${String(item.head ?? "none").slice(0, 8)}`;
  const now = criteriaOf(item);
  if (now !== bound.criteria) return `the acceptance criteria changed since the triage (binding ${bound.criteria.slice(0, 8)}, now ${now.slice(0, 8)})`;
  if (!GOES_ON.some((outcome) => recordedTriage(events, bound, outcome))) return `no triage that lets the landing go on (passed, bypassed or overridden) is recorded at ${bound.head.slice(0, 8)} with merge base ${bound.base.slice(0, 8)} and criteria ${bound.criteria.slice(0, 8)}`;
  return null;
}
