// Model cards (t625): what a vendor claims about a model, as the developer
// read it, with its source and the conditions each figure was measured
// under. A card is the vendor's word, kept beside Atelier's own experience of
// the model so the two can be compared; it is never an Atelier measurement
// and nothing that routes or suggests a model reads it. Each claim is a
// ModelEvidence of kind "model-card" (cardEvidence), the registry's own type.
//
// Cards are records in the index ledger, beside the model notes: written by
// the developer, immutable, each with an id and the server's time. A
// correction or a supersession is a new card naming the one it replaces, and
// a withdrawal is a record naming the card it withdraws, so the history stays
// whole. Cards are stored under the model's canonical key (canonicalModel),
// so a model named by an alias, or run under several harnesses, has one set
// of cards, and taking a model out of the pool and back loses none.
//
// The registry's static priors (src/models/registry.ts, `prior: true`) are
// the older, supplied vendor descriptions; they stay there, labelled as
// priors, and are shown beside the cards, never stored as cards.

import { RuleError } from "../rules.ts";
import { HARNESSES, LOOKS_LIKE_KEY } from "./pool.ts";
import type { ModelEvidence } from "./registry.ts";

export interface CardConditions {
  harness?: string;    // the harness or scaffold the vendor ran it in: Claude Code, Codex, Terminus 2
  effort?: string;     // the reasoning effort or thinking budget: max, xhigh, 64k thinking
  details?: string[];  // anything else it was measured under: tools, attempts, context, runs averaged
}

export interface CardClaim {
  benchmark: string;   // SWE-bench Pro
  version?: string;    // the benchmark's version or subset, when the card names one
  score: number;
  unit: string;        // %, points, Elo
  taskKind: ModelEvidence["taskKind"];
  conditions: CardConditions;
}

export interface ModelCard {
  id: string;          // c12: the record's id, given by the server
  kind: "card";
  model: string;       // the canonical model key when it was recorded
  named: string;       // the model as the developer named it
  at: string;          // the server's time
  by: string;          // the developer
  vendor?: string;
  title?: string;      // the source's title
  source: string;      // the URL the claims were read at
  published: string | null; // YYYY-MM-DD, when the source gives one
  read: string;        // YYYY-MM-DD, the day the developer read it
  claims: CardClaim[];
  limitations: string[]; // what the vendor says the model does not do, or does badly
  corrects?: string;   // the card this one corrects: the same source, read wrongly
  supersedes?: string; // the card this one replaces: a newer card or version
  reason?: string;     // why, for a correction or a supersession
}

export interface CardWithdrawal {
  id: string;
  kind: "withdrawal";
  model: string;
  named: string;
  at: string;
  by: string;
  withdraws: string;   // the card withdrawn
  reason: string;
}

export type CardRecord = ModelCard | CardWithdrawal;
export type CardInput = Omit<ModelCard, "id" | "model" | "named" | "at" | "by">;
export type WithdrawalInput = Pick<CardWithdrawal, "kind" | "withdraws" | "reason">;

// A model's cards as the developer reads them, oldest first: each with its
// state, the cards that disagree under the same conditions, and the
// registry's priors for the model, labelled as priors.
export type CardState = "active" | "corrected" | "superseded" | "withdrawn";
export interface ShownCard extends ModelCard { state: CardState; endedBy?: string; endedAt?: string; endReason?: string }
export interface CardDisagreement {
  kind: "conflict" | "conditions-differ";
  benchmark: string;
  version?: string;
  unit: string;
  claims: { card: string; score: number; source: string; conditions: CardConditions }[];
}
export interface CardView {
  model: string;
  pool: string[];      // the pool entries, harness/id, that are this model
  cards: ShownCard[];
  withdrawals: CardWithdrawal[];
  disagreements: CardDisagreement[];
  priors: ModelEvidence[];
}

export const CARD_ID = /^c[1-9][0-9]{0,11}$/;
const TASK_KINDS: readonly ModelEvidence["taskKind"][] = [
  "mechanical-edit", "feature", "refactor", "tests", "docs", "ui", "research",
  "general", "tool-use", "repository", "objective-answers", "long-context",
];
const CARD_FIELDS = new Set(["vendor", "title", "source", "published", "read", "claims", "limitations", "corrects", "supersedes", "reason"]);
const CLAIM_FIELDS = new Set(["benchmark", "version", "score", "unit", "taskKind", "conditions"]);
const CONDITION_FIELDS = new Set(["harness", "effort", "details"]);
const MODEL_NAME = new RegExp(`^(?:(?:${HARNESSES.join("|")})/)?[a-z0-9][a-z0-9._:-]{0,63}$`, "i");

const bad = (detail: string) => new RuleError("bad_card", detail, 400);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// One line of plain text: control characters become spaces, runs of space
// one, and a key pasted by mistake is refused.
function text(v: unknown, what: string, max: number, required: boolean): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (required) throw bad(`${what} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw bad(`${what} must be text`);
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) { if (required) throw bad(`${what} is required`); return undefined; }
  if (s.length > max) throw bad(`${what} is at most ${max} characters`);
  if (LOOKS_LIKE_KEY.test(s)) throw bad(`${what} looks like it carries a key; a key belongs in the Keychain`);
  return s;
}

function texts(v: unknown, what: string, maxItems: number, max: number): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw bad(`${what} must be a list of text`);
  if (v.length > maxItems) throw bad(`${what} holds at most ${maxItems} entries`);
  return v.map((x, i) => text(x, `${what}[${i}]`, max, true)!);
}

function unknownFields(o: Record<string, unknown>, allowed: Set<string>, what: string): void {
  const extra = Object.keys(o).filter((k) => !allowed.has(k));
  if (extra.length) throw bad(`${what} has fields Atelier does not keep: ${extra.join(", ")}; it takes ${[...allowed].join(", ")}`);
}

// A calendar date, YYYY-MM-DD, that exists.
function day(v: unknown, what: string): string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad(`${what} is a date, YYYY-MM-DD`);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw bad(`${what} ${v} is not a calendar date`);
  return v;
}

// A source is a public https URL: no credentials in it, no other scheme, no
// local host, and nothing that looks like a key in its path or query.
export function cleanSource(v: unknown): string {
  const raw = text(v, "source", 500, true)!;
  let url: URL;
  try { url = new URL(raw); } catch { throw bad("source must be a URL, such as https://vendor.example/model-card"); }
  if (url.protocol !== "https:") throw bad("source must be an https URL");
  if (url.username || url.password) throw bad("source must not carry a user name or password");
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host === "localhost" || host.endsWith(".localhost") || /^[\d.]+$/.test(host) || host.startsWith("[")) {
    throw bad("source must name a public host by its domain name");
  }
  return url.toString();
}

function cleanConditions(v: unknown, what: string): CardConditions {
  if (v === undefined || v === null) return {};
  if (!isObject(v)) throw bad(`${what} must be an object with harness, effort and details`);
  unknownFields(v, CONDITION_FIELDS, what);
  const harness = text(v.harness, `${what}.harness`, 80, false);
  const effort = text(v.effort, `${what}.effort`, 80, false);
  const details = texts(v.details, `${what}.details`, 12, 200);
  return { ...(harness ? { harness } : {}), ...(effort ? { effort } : {}), ...(details.length ? { details } : {}) };
}

function cleanClaim(v: unknown, i: number): CardClaim {
  const what = `claims[${i}]`;
  if (!isObject(v)) throw bad(`${what} must be an object with benchmark, score and unit`);
  unknownFields(v, CLAIM_FIELDS, what);
  const benchmark = text(v.benchmark, `${what}.benchmark`, 120, true)!;
  const version = text(v.version, `${what}.version`, 60, false);
  if (typeof v.score !== "number" || !Number.isFinite(v.score)) throw bad(`${what}.score must be a finite number, such as 80.9`);
  const unit = text(v.unit, `${what}.unit`, 20, true)!;
  const taskKind = v.taskKind === undefined ? "general" : v.taskKind;
  if (!TASK_KINDS.includes(taskKind as ModelEvidence["taskKind"])) throw bad(`${what}.taskKind must be one of ${TASK_KINDS.join(", ")}`);
  return { benchmark, ...(version ? { version } : {}), score: v.score, unit, taskKind: taskKind as ModelEvidence["taskKind"], conditions: cleanConditions(v.conditions, `${what}.conditions`) };
}

// A card as the developer sends it, checked: the source and the day it was
// read are required, the publication date when the source gives one, and at
// least one claim, each a benchmark with a finite score and its unit.
// `today` is the server's date: a card is not read in the future.
export function cleanCard(body: Record<string, unknown>, today: string): CardInput {
  unknownFields(body, CARD_FIELDS, "a card");
  const source = cleanSource(body.source);
  const read = day(body.read, "read");
  if (read > today) throw bad(`read ${read} is after today, ${today}`);
  const published = body.published === undefined || body.published === null ? null : day(body.published, "published");
  if (published && published > read) throw bad(`published ${published} is after read ${read}`);
  if (!Array.isArray(body.claims) || !body.claims.length) throw bad("a card holds at least one claim");
  if (body.claims.length > 60) throw bad("a card holds at most 60 claims");
  const claims = body.claims.map(cleanClaim);
  const limitations = texts(body.limitations, "limitations", 30, 300);
  const vendor = text(body.vendor, "vendor", 80, false);
  const title = text(body.title, "title", 200, false);
  const ref = (k: "corrects" | "supersedes") => {
    if (body[k] === undefined || body[k] === null) return undefined;
    if (typeof body[k] !== "string" || !CARD_ID.test(body[k] as string)) throw bad(`${k} names a card by its id, such as c12`);
    return body[k] as string;
  };
  const corrects = ref("corrects");
  const supersedes = ref("supersedes");
  if (corrects && supersedes) throw bad("a card corrects one card or supersedes one, not both");
  const reason = text(body.reason, "reason", 300, false);
  if (reason && !corrects && !supersedes) throw bad("a reason goes with corrects or supersedes");
  return {
    kind: "card", ...(vendor ? { vendor } : {}), ...(title ? { title } : {}), source, published, read, claims, limitations,
    ...(corrects ? { corrects } : {}), ...(supersedes ? { supersedes } : {}), ...(reason ? { reason } : {}),
  };
}

export function cleanWithdrawal(body: Record<string, unknown>): WithdrawalInput {
  unknownFields(body, new Set(["withdraws", "reason"]), "a withdrawal");
  if (typeof body.withdraws !== "string" || !CARD_ID.test(body.withdraws)) throw bad("withdraws names a card by its id, such as c12");
  return { kind: "withdrawal", withdraws: body.withdraws, reason: text(body.reason, "reason", 300, true)! };
}

// The name a card is filed under: a model's id or alias, or harness/model.
export function cleanCardModel(named: string): string {
  if (!MODEL_NAME.test(named)) throw bad(`${named} is not a model's name: give its id or an alias, such as opus-5.5, or harness/model`);
  return named;
}

// Each record's state, read from the records after it: a card is active
// until a later card corrects or supersedes it, or a withdrawal names it.
function endings(records: readonly CardRecord[]): Map<string, { state: CardState; by: string; at: string; reason?: string }> {
  const ended = new Map<string, { state: CardState; by: string; at: string; reason?: string }>();
  for (const r of records) {
    const target = r.kind === "withdrawal" ? r.withdraws : r.corrects ?? r.supersedes;
    if (!target || ended.has(target)) continue;
    const state: CardState = r.kind === "withdrawal" ? "withdrawn" : r.corrects ? "corrected" : "superseded";
    ended.set(target, { state, by: r.id, at: r.at, ...(r.reason ? { reason: r.reason } : {}) });
  }
  return ended;
}

// What a new record does among the model's records, before it is stored:
// the record that already says the same thing (a retry, answered with it and
// stored again never), or a refusal when it names a card that is not the
// model's or has already ended. `records` are the model's, oldest first.
const content = (r: CardInput | ModelCard | WithdrawalInput | CardWithdrawal) => {
  const { id: _i, model: _m, named: _n, at: _a, by: _b, ...rest } = r as ModelCard;
  return JSON.stringify(rest);
};
export function admitCardRecord(records: readonly CardRecord[], input: CardInput | WithdrawalInput, model: string): CardRecord | null {
  const ended = endings(records);
  const same = records.find((r) => content(r) === content(input) && (r.kind === "withdrawal" || !ended.has(r.id)));
  if (same) return same;
  const target = input.kind === "withdrawal" ? input.withdraws : input.corrects ?? input.supersedes;
  if (!target) return null;
  const card = records.find((r): r is ModelCard => r.id === target && r.kind === "card");
  if (!card) throw new RuleError("no_card", `${target} is not a card of ${model}`, 404);
  const end = ended.get(target);
  if (end) throw new RuleError("card_ended", `${target} is already ${end.state} by ${end.by}; name ${end.state === "withdrawn" ? "an active card" : end.by} instead`, 409);
  return null;
}

// Two claims say the same thing when they name one benchmark, version and
// unit under the same conditions; then a different score is a conflict. The
// same benchmark under other conditions is a difference, not a conflict.
const fold = (s: string | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const conditionKey = (c: CardConditions) => JSON.stringify([fold(c.harness), fold(c.effort), (c.details ?? []).map(fold).sort()]);
export function cardDisagreements(cards: readonly ShownCard[]): CardDisagreement[] {
  const groups = new Map<string, CardDisagreement>();
  for (const card of cards) {
    if (card.state !== "active") continue;
    for (const c of card.claims) {
      const key = JSON.stringify([fold(c.benchmark), fold(c.version), fold(c.unit)]);
      const group = groups.get(key) ?? { kind: "conflict", benchmark: c.benchmark, ...(c.version ? { version: c.version } : {}), unit: c.unit, claims: [] };
      group.claims.push({ card: card.id, score: c.score, source: card.source, conditions: c.conditions });
      groups.set(key, group);
    }
  }
  const out: CardDisagreement[] = [];
  const scores = (claims: CardDisagreement["claims"]) => new Set(claims.map((c) => c.score)).size;
  for (const group of groups.values()) {
    if (new Set(group.claims.map((c) => c.card)).size < 2 || scores(group.claims) < 2) continue;
    const under = new Map<string, CardDisagreement["claims"]>();
    for (const c of group.claims) under.set(conditionKey(c.conditions), [...(under.get(conditionKey(c.conditions)) ?? []), c]);
    for (const claims of under.values()) if (scores(claims) > 1) out.push({ ...group, kind: "conflict", claims });
    if (under.size > 1) out.push({ ...group, kind: "conditions-differ" });
  }
  return out;
}

// A model's records as the developer reads them, oldest first.
export function cardView(model: string, pool: string[], records: readonly CardRecord[], priors: ModelEvidence[]): CardView {
  const ended = endings(records);
  const cards = records.filter((r): r is ModelCard => r.kind === "card").map((card): ShownCard => {
    const end = ended.get(card.id);
    return end ? { ...card, state: end.state, endedBy: end.by, endedAt: end.at, ...(end.reason ? { endReason: end.reason } : {}) } : { ...card, state: "active" };
  });
  return { model, pool, cards, withdrawals: records.filter((r): r is CardWithdrawal => r.kind === "withdrawal"), disagreements: cardDisagreements(cards), priors };
}

// Each claim as the registry's evidence: a model card, dated by its
// publication, sourced to its URL. Never "atelier-record": a vendor's figure
// is not a measurement Atelier made.
export const conditionText = (c: CardConditions) => [c.harness, c.effort && `${c.effort} effort`, ...(c.details ?? [])].filter(Boolean).join("; ");
export function cardEvidence(card: ModelCard): ModelEvidence[] {
  return card.claims.map((c) => {
    const under = conditionText(c.conditions);
    return {
      kind: "model-card", taskKind: c.taskKind,
      claim: `${c.benchmark}${c.version ? ` ${c.version}` : ""} ${c.score}${c.unit === "%" ? "%" : ` ${c.unit}`}${under ? ` (${under})` : ""}`,
      source: card.source, date: card.published,
    };
  });
}
