// Standing decisions. The project owner settles some questions once, for the
// whole project: another company reviews everywhere, what the review bar is,
// what may be spent, that nothing overrides a review. Before t377 those lived
// in a private file only one orchestrating session read; an agent running
// another project, or a reviewer of this one, never saw them. Now each is a
// dated record on the project's Ledger: `atelier decide` records one with the
// owner's own words, `atelier decisions` lists them, and the owner withdraws
// one with a note, after which it stops appearing. Every review brief of the
// project and `atelier guide --role orchestrate` for it carry the standing
// ones, marked as decisions a reviewer must not overrule.
//
// The functions here hold the rules and the storage, as src/actions.ts does
// for protected actions. The Ledger (one per project) calls them, so a
// project's decisions are serialised with the rest of its record; the brief
// (src/review/brief.ts) and the CLI print them through `decisionLines`, so
// the two cannot say them differently.

import { RuleError } from "./rules.ts";
import { TEXT_CONTROLS } from "./text.ts";

export const DECISION_TEXT_MAX = 1000;
export const DECISION_QUOTE_MAX = 2000;
export const DECISION_NOTE_MAX = 500;
export const DECISION_ID = /^d\d{1,9}$/;

export interface Decision {
  id: string;            // d1, d2, ... in the order they were recorded
  text: string;          // the decision, as the orchestrator states it
  quote: string;         // the owner's own words it rests on
  by: string;
  at: string;
  withdrawn?: { by: string; at: string; note: string };
}

export type DecisionStatus = "standing" | "withdrawn";
export type DecisionView = Decision & { status: DecisionStatus };

// Text a person typed, kept to one line without control characters, so a
// decision can never carry a line that poses as part of a brief around it.
const line = (v: unknown) =>
  typeof v === "string" ? v.replace(TEXT_CONTROLS, " ").replace(/\s+/g, " ").trim() : "";

// What a decision says, checked before anything is written: the decision and
// the owner's words, both required, so a decision never stands on the
// orchestrator's own reading alone.
export function cleanDecisionInput(body: Record<string, unknown>): { text: string; quote: string } {
  if (body.text !== undefined && typeof body.text !== "string") throw new RuleError("bad_decision", "a decision is text", 400);
  if (body.quote !== undefined && typeof body.quote !== "string") throw new RuleError("bad_quote", "the owner's words are text", 400);
  const text = line(body.text), quote = line(body.quote);
  if (!text) throw new RuleError("bad_decision", "a decision needs text: what the owner decided", 400);
  if (text.length > DECISION_TEXT_MAX) throw new RuleError("too_long", `a decision is at most ${DECISION_TEXT_MAX} characters`, 400);
  if (!quote) throw new RuleError("bad_quote", "a decision needs the owner's words: --quote \"what the owner said\"", 400);
  if (quote.length > DECISION_QUOTE_MAX) throw new RuleError("too_long", `the owner's words are at most ${DECISION_QUOTE_MAX} characters`, 400);
  return { text, quote };
}

// The Ledger's side: its SQLite storage, the project owner's actor, and its
// event log. The table is made on first use, so a Ledger that never sees a
// decision never has one.
export interface DecisionStore {
  sql: SqlStorage;
  owner: string;
  log(kind: string, data: Record<string, unknown>): void;
}

function rows(sql: SqlStorage): Decision[] {
  sql.exec(`CREATE TABLE IF NOT EXISTS decisions (n INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, json TEXT NOT NULL)`);
  return sql.exec(`SELECT json FROM decisions ORDER BY n`).toArray().map((r) => JSON.parse(r.json as string) as Decision);
}

function ownerOnly(store: DecisionStore, actor: string, what: string): void {
  if (actor !== store.owner) throw new RuleError("not_project_owner", `only the project owner ${what}`, 403);
}

export const decisionStatus = (d: Decision): DecisionStatus => (d.withdrawn ? "withdrawn" : "standing");
const view = (d: Decision): DecisionView => ({ ...d, status: decisionStatus(d) });

// Every decision, oldest first, each with its status.
export function listDecisions(store: DecisionStore): DecisionView[] {
  return rows(store.sql).map(view);
}

// The decisions that stand, oldest first: what the briefs and the guide carry.
export function standingDecisions(store: DecisionStore): Decision[] {
  return rows(store.sql).filter((d) => !d.withdrawn);
}

// The owner records one decision, dated now. The same text standing already
// is refused, so one decision is never listed twice.
export function recordDecision(store: DecisionStore, actor: string, body: Record<string, unknown>, now: string): DecisionView {
  ownerOnly(store, actor, "records a standing decision");
  const { text, quote } = cleanDecisionInput(body);
  const all = rows(store.sql);
  const same = all.find((d) => !d.withdrawn && d.text === text);
  if (same) throw new RuleError("already_decided", `${same.id} already records that decision, on ${same.at.slice(0, 10)}. To change it, withdraw it first: atelier decisions withdraw ${same.id} --note "…"`, 409);
  const n = all.length + 1;
  const decision: Decision = { id: `d${n}`, text, quote, by: actor, at: now };
  store.sql.exec(`INSERT INTO decisions (n, id, json) VALUES (?, ?, ?)`, n, decision.id, JSON.stringify(decision));
  store.log("decision.recorded", { id: decision.id, text, quote });
  return view(decision);
}

// The owner withdraws one, with a note saying why; it stops appearing in the
// briefs and the guide, and the list shows it only when asked for all.
export function withdrawDecision(store: DecisionStore, actor: string, id: string, note: unknown, now: string): DecisionView {
  ownerOnly(store, actor, "withdraws a standing decision");
  if (note !== undefined && typeof note !== "string") throw new RuleError("bad_note", "a note is text", 400);
  const why = line(note);
  if (!why) throw new RuleError("bad_note", "withdrawing a decision needs a note saying why: --note \"…\"", 400);
  if (why.length > DECISION_NOTE_MAX) throw new RuleError("too_long", `the note is at most ${DECISION_NOTE_MAX} characters`, 400);
  const d = rows(store.sql).find((x) => x.id === id);
  if (!d) throw new RuleError("no_decision", `no decision ${id}; atelier decisions lists them`, 404);
  if (d.withdrawn) throw new RuleError("not_standing", `${id} was withdrawn on ${d.withdrawn.at.slice(0, 10)}, so there is nothing to withdraw`, 409);
  d.withdrawn = { by: actor, at: now, note: why };
  store.sql.exec(`UPDATE decisions SET json = ? WHERE id = ?`, JSON.stringify(d), d.id);
  store.log("decision.withdrawn", { id, text: d.text, note: why });
  return view(d);
}

// What a brief or the guide says above the decisions: they are the owner's,
// they bind every agent, and a reviewer must not overrule one.
export const DECISIONS_HEADING = "Standing decisions";
export const DECISIONS_RULE = "These are the project owner's standing decisions for this project, recorded with atelier decide and withdrawn only by the owner. They bind every agent and are not open to review: a reviewer must not overrule one, so a finding that contests a decision, or asks for what a decision rules out, is neither blocking nor a follow-up, and a change that does what a decision says is not at fault for doing so.";
export const NO_DECISIONS = "The project owner has recorded no standing decision for this project.";

// One line per standing decision, oldest first: its id, its date, the
// decision and the owner's words. The text was kept to one line when it was
// recorded, so each decision is one line here too.
export function decisionLines(decisions: readonly Pick<Decision, "id" | "text" | "quote" | "at">[]): string[] {
  return decisions.map((d) => `- ${d.id} (${d.at.slice(0, 10)}): ${d.text} The owner's words: “${d.quote}”`);
}

// The section as the guide prints it and the brief carries it: the heading,
// the rule, and the decisions.
export function decisionsSection(decisions: readonly Pick<Decision, "id" | "text" | "quote" | "at">[]): string {
  return [`## ${DECISIONS_HEADING}`, "", DECISIONS_RULE, "", ...(decisions.length ? decisionLines(decisions) : [NO_DECISIONS])].join("\n");
}
