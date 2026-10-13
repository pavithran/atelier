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
// whole. Cards are stored under the key the model's name gives (modelKey,
// src/rules.ts), so a model named by a registry alias, or run under several
// harnesses, has one set of cards, and taking a model out of the pool and
// back loses none. Pool aliases are never read (cardFiling says why).
//
// The registry's static priors (src/models/registry.ts, `prior: true`) are
// the older, supplied vendor descriptions; they stay there, labelled as
// priors, and are shown beside the cards, never stored as cards.

import { modelKey, RuleError } from "../rules.ts";
import { HARNESSES, LOOKS_LIKE_KEY, type ModelEntry } from "./pool.ts";
import { MODEL_PROFILES, type ModelEvidence } from "./registry.ts";

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
  model: string;       // the key the cards are stored and listed under (modelKey)
  known?: boolean;     // whether the registry or a pool entry's id gives that key
  pool: string[];      // the pool entries, harness/id, whose id gives that key
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
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
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

// A source is a public https URL, written plainly, checked on one parse. The
// URL is parsed once (new URL) and every check reads the parsed result: its
// protocol, its user name and password, and its host. The typed text is then
// held to that parse: it must be "https://", in any letter case, then the
// parsed host exactly as the parser gives it back (letter case aside), then
// "/", "?", "#" or the end. So the host the parser reads is the host as
// typed, and the key check on the typed text (text()) covers it; any
// spelling the parser decodes, folds or skips (%-escapes, full-width letters,
// a backslash or a third slash, an empty user name, a default port) makes
// the two differ and is refused. Every review round of t625 (2026-10-13)
// found such a spelling; the fifth (Astra's, finding 1) found that a string
// pre-check of the authority read "https:////host" as an empty authority
// while the parser found the host, so no pre-check of the typed text decides
// what the host is. The host must then be a domain name of plain labels,
// neither local, private nor numeric, kept lowercased and without its one
// trailing dot. The path, query and fragment are scanned decoded, so
// percent-encoding hides no key there.
const PRIVATE_HOST = /(?:^|\.)(?:localhost|local|localdomain|internal|intranet|lan|home|corp|private|home\.arpa)$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const PLAIN_SOURCE = "source must be an https URL starting https:// with its host right after, written in plain ASCII as the parser reads it: no %-escape, user name, extra slash or backslash";
export function cleanSource(v: unknown): string {
  const raw = text(v, "source", 500, true)!;
  let url: URL;
  try { url = new URL(raw); } catch { throw bad(PLAIN_SOURCE); }
  if (url.protocol !== "https:") throw bad(PLAIN_SOURCE);
  if (url.username || url.password) throw bad("source must not carry a user name or password");
  // Compared in ASCII letter case only: String.toLowerCase folds non-ASCII
  // letters (the Kelvin sign K, U+212A) to ASCII as the parser does, so the
  // typed authority must be plain ASCII before it is compared (Astra's and
  // gemini-4-argon's sixth reviews of t625, 2026-10-13).
  const typed = `https://${url.host}`;
  const prefix = raw.slice(0, typed.length);
  if (!/^[\x21-\x7e]*$/.test(prefix) || asciiLower(prefix) !== asciiLower(typed) || !/^(?:[/?#]|$)/.test(raw.slice(typed.length))) throw bad(PLAIN_SOURCE);
  if (raw.includes("\\")) throw bad(PLAIN_SOURCE);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes(".") || !host.split(".").every((l) => LABEL.test(l))
    || PRIVATE_HOST.test(host) || /^[\d.]+$/.test(host)) {
    throw bad("source must name a public host by its domain name");
  }
  url.hostname = host;
  let decoded: string;
  try {
    decoded = [url.pathname, url.search, url.hash].map((part) => decodeURIComponent(part.replace(/\+/g, " "))).join(" ");
  } catch { throw bad("source has malformed percent-encoding"); }
  // The key check also reads the host and the URL as they are stored, after
  // the parser lowercased them: "SK-…" typed is "sk-…" kept (gemini-4-argon's
  // sixth review of t625, 2026-10-13).
  const stored = url.toString();
  if ([decoded, host, stored].some((s) => LOOKS_LIKE_KEY.test(s))) throw bad("source looks like it carries a key; a key belongs in the Keychain");
  return stored;
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
// A key pasted as the name is refused with the pool's own check, since the
// name is stored in every record (Astra's second review of t625, 2026-10-13,
// finding 3). Every other text a card keeps passes the same check in text().
// The check reads the key the name is stored under (modelKey lowercases it)
// as well as the name as given: "SK-…" would be kept as "sk-…"
// (gemini-4-argon's sixth review of t625, 2026-10-13).
export function cleanCardModel(named: string): string {
  if (LOOKS_LIKE_KEY.test(named) || LOOKS_LIKE_KEY.test(modelKey(named))) throw bad("the model's name looks like it carries a key; a key belongs in the Keychain");
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

// Two rules, so no change to the pool can move a card or bring a withdrawn
// one back. Four rounds of review of t625 (2026-10-13) found every reading of
// pool aliases could; cards no longer read them at all.
//
// A card belongs to the model its name gives by modelKey (src/rules.ts), the
// key computed from the name alone: the harness cut off, and a name the
// registry knows given as the registry's id. It is stored when the card is
// written and the card is listed by it, so pool aliases, removals and
// re-additions never change a card's key or where it is listed. A name
// neither the registry nor the pool knows is kept under its own normalised
// key, and the answer says so (CardView.known).
//
// A card's state is read from every record in the table that names its id
// (endings): a correction, supersession or withdrawal names the card id, is
// accepted only from the model the card belongs to, and is stored under the
// same key.
export interface CardFiling { model: string; listed: ModelCard[]; reachable: Set<string> }
export function cardFiling(all: readonly CardRecord[], named: string): CardFiling {
  const model = modelKey(named);
  const listed = all.filter((r): r is ModelCard => r.kind === "card" && r.model === model);
  return { model, listed, reachable: new Set(listed.map((c) => c.id)) };
}

// What a new record does, before it is stored: the record that already says
// the same thing (a retry, answered with it and stored again never, whatever
// has happened to it since: a replay neither brings back a withdrawn card nor
// is refused for a later ending, Astra's review of t625, 2026-10-13, finding
// 2), or a refusal when it names a card the model does not reach or one
// already ended. Otherwise the key to file it under: the model's for a new
// card, the named card's for a record that names one.
const content = (r: CardInput | ModelCard | WithdrawalInput | CardWithdrawal) => {
  const { id: _i, model: _m, named: _n, at: _a, by: _b, ...rest } = r as ModelCard;
  return JSON.stringify(rest);
};
export function admitCardRecord(all: readonly CardRecord[], input: CardInput | WithdrawalInput, filing: CardFiling): { existing: CardRecord } | { fileAs: string } {
  const same = all.find((r) => filing.reachable.has(r.kind === "withdrawal" ? r.withdraws : r.id) && content(r) === content(input));
  if (same) return { existing: same };
  const target = input.kind === "withdrawal" ? input.withdraws : input.corrects ?? input.supersedes;
  if (!target) return { fileAs: filing.model };
  const card = all.find((r): r is ModelCard => r.id === target && r.kind === "card");
  if (!card || !filing.reachable.has(card.id)) throw new RuleError("no_card", `${target} is not a card of ${filing.model}`, 404);
  const end = endings(all).get(target);
  if (end) throw new RuleError("card_ended", `${target} is already ${end.state} by ${end.by}; name ${end.state === "withdrawn" ? "an active card" : end.by} instead`, 409);
  return { fileAs: card.model };
}

// Two claims say the same thing when they name one benchmark, version and
// unit under the same conditions; then a different score is a conflict. The
// same benchmark under other conditions is a difference, not a conflict.
// The benchmark, version and unit are compared in any letter case; the
// conditions only with their spacing evened, never case-folded, since a
// condition may name something whose case matters, such as a dataset's
// directory (/datasets/Hard and /datasets/hard are two; Astra's seventh
// review of t625, 2026-10-13).
const spaced = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const fold = (s: string | undefined) => spaced(s).toLowerCase();
const conditionKey = (c: CardConditions) => JSON.stringify([spaced(c.harness), spaced(c.effort), (c.details ?? []).map(spaced).sort()]);
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

// A model's cards as the developer reads them, oldest first, each with the
// state every record in the table gives it, and the withdrawals of them.
export function cardView(filing: CardFiling, all: readonly CardRecord[], pool: string[], priors: ModelEvidence[]): CardView {
  const ended = endings(all);
  const cards = filing.listed.map((card): ShownCard => {
    const end = ended.get(card.id);
    return end ? { ...card, state: end.state, endedBy: end.by, endedAt: end.at, ...(end.reason ? { endReason: end.reason } : {}) } : { ...card, state: "active" };
  });
  const ids = new Set(cards.map((c) => c.id));
  const withdrawals = all.filter((r): r is CardWithdrawal => r.kind === "withdrawal" && ids.has(r.withdraws));
  return { model: filing.model, pool, cards, withdrawals, disagreements: cardDisagreements(cards), priors };
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

// A model's cards as the routes answer them: its filing in the whole table,
// the pool entries that are this model now, and the registry's priors for it.
export function modelCardView(all: readonly CardRecord[], pool: readonly Pick<ModelEntry, "id" | "harness">[], named: string): CardView {
  const filing = cardFiling(all, named);
  const entries = pool.filter((m) => modelKey(`${m.harness}/${m.id}`) === filing.model).map((m) => `${m.harness}/${m.id}`);
  const profiles = MODEL_PROFILES.filter((p) => modelKey(p.id) === filing.model);
  const priors = profiles.flatMap((p) => p.evidence.filter((e) => e.prior));
  return { ...cardView(filing, all, entries, priors), known: profiles.length > 0 || entries.length > 0 };
}

// A record about to be added: the one already stored that says the same, or
// the record to store, filed as admitCardRecord says.
export type StoredCardRecord = Omit<ModelCard, "id"> | Omit<CardWithdrawal, "id">;
export function newCardRecord(all: readonly CardRecord[], named: string, input: CardInput | WithdrawalInput, by: string, at: string): { existing: CardRecord } | { store: StoredCardRecord } {
  const admitted = admitCardRecord(all, input, cardFiling(all, named));
  if ("existing" in admitted) return admitted;
  return { store: { ...input, model: admitted.fileAs, named, at, by } as StoredCardRecord };
}
