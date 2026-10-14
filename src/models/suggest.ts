import type { Item, ProjectPolicy } from "../rules.ts";
import { actorFamily, assertEligible, DEFAULT_OWNER, modelKey, RuleError, singleFamily } from "../rules.ts";
import { entryRuns, latestNote, noteLine, standingRefusal, type ModelEntry } from "./pool.ts";
import { buildReliability, outcomesOf, reliabilityLine, tiebreak, type ProjectEvents, type RunReport } from "./reliability.ts";
import { paidPerToken, type Choice } from "../plans/route.ts";
import { servedActor, servedBy } from "./served.ts";
import { aheadOfAssignments, applicableAssignments, FALLBACK, orderByAssignment, sensitiveText, type Assignment } from "./assignments.ts";
import { offering, type SeenOffer } from "../dispatch/rules.ts";

export interface SuggestionRecords { sources: ProjectEvents[]; runs: RunReport[] }
type Task = Pick<Item, "id" | "title" | "brief" | "scope" | "owner" | "pushActors">;
export interface SuggestionInput extends SuggestionRecords {
  item: Task;
  project: string;
  pool: readonly ModelEntry[];
  policy: ProjectPolicy;
  owner?: string;
  frontierRequired?: boolean;
  // The role assignments standing now (src/models/assignments.ts); those of
  // this project (by its key, `project`) and of every project bear here.
  assignments?: readonly Assignment[];
  // The runners' offers as the index recorded them. A model no live runner
  // offers is passed over, since no runner could claim its dispatch; with no
  // live runner, or none read, nothing is restricted (as plan routing does).
  offers?: readonly SeenOffer[] | null;
}
const actorOf = (m: ModelEntry) => `${m.harness}/${m.id}`;
const keysOf = (m: ModelEntry) => new Set([m.id, ...m.aliases].map(modelKey));
export const frontier = (m: ModelEntry) => [m.id, ...m.aliases].some((id) => /(?:^|[-/])(fable|opus)(?:[-.]|$)|^gpt-6-astra(?:[-.:]|$)/i.test(id));
export const sensitive = (item: Pick<Task, "title" | "brief" | "scope">) => sensitiveText([item.title, item.brief, ...item.scope]);

// A pair of consecutive stalled build outcomes latches the exclusion. A
// later refusal or timeout cannot clear it; a submitted or merged build can.
// Replay each project's holders separately: task ids repeat across projects.
export function stalledBuilder(entry: ModelEntry, records: SuggestionRecords): boolean {
  const keys = keysOf(entry);
  const outcomes: { at: string; stalled: boolean; success: boolean }[] = records.runs
    .filter((r) => r.role === "build" && keys.has(modelKey(r.actor)))
    .map((r) => ({ at: r.at, stalled: r.outcome === "stalled", success: false }));
  for (const source of records.sources) {
    const holders = new Map<string, string>();
    const served = servedBy(source.events);
    for (const e of [...source.events].sort((a, b) => a.seq - b.seq)) {
      if (!e.itemId) continue;
      if (e.kind === "item.claimed") holders.set(e.itemId, servedActor(e, served));
      if (e.kind === "item.handoff" && typeof e.data.to === "string") holders.set(e.itemId, e.data.to);
      const actor = e.kind === "item.submitted" ? servedActor(e, served) : holders.get(e.itemId);
      if ((e.kind === "item.submitted" || e.kind === "item.merged") && actor && keys.has(modelKey(actor))) outcomes.push({ at: e.at, stalled: false, success: true });
      if (["item.released", "item.abandoned", "item.merged"].includes(e.kind)) holders.delete(e.itemId);
    }
  }
  let consecutive = 0, blocked = false;
  for (const o of outcomes.sort((a, b) => a.at.localeCompare(b.at) || Number(b.success) - Number(a.success))) {
    if (o.success) { consecutive = 0; blocked = false; }
    else if (o.stalled) { if (++consecutive >= 2) blocked = true; }
    else consecutive = 0;
  }
  return blocked;
}

export function ranked(input: SuggestionInput) {
  const record = buildReliability(input.sources, input.runs, input.owner ?? DEFAULT_OWNER);
  return input.pool.map((entry) => {
    const rows = [...keysOf(entry)].flatMap((key) => record.get(key) ?? []);
    const counts = rows.map(outcomesOf).reduce((a, b) => ({ good: a.good + b.good, bad: a.bad + b.bad }), { good: 0, bad: 0 });
    return { entry, score: tiebreak(counts), reason: rows.length ? rows.map(reliabilityLine).join(" ") : "No recorded outcomes; neutral score." };
  }).sort((a, b) => b.score - a.score || actorOf(a.entry).localeCompare(actorOf(b.entry)));
}

export function suggestBuilder(input: SuggestionInput, constraints: { to?: unknown; model?: unknown } = {}): Choice & { where: string } {
  const rejections = input.sources.filter((s) => s.project === input.project).flatMap((s) => s.events)
    .filter((e) => e.itemId === input.item.id && e.kind === "review.rejected").length;
  const strict = sensitive(input.item) || rejections >= 2;
  // Under single-family mode (t394) only the company's models build, so the
  // pick stays within the company: a dispatch naming another company's model
  // is refused by the ledger, and the suggestion never proposes one.
  const single = singleFamily(input.policy);
  const why = (rejections >= 2 ? "Two rejections require a frontier builder." : strict ? "Security, concurrency or gate work requires a frontier builder." : "Eligible pool models ranked by recorded successful and failed outcomes.")
    + (single ? ` This project runs in single-family mode (${single}), so only ${single}'s models are considered.` : "");
  const excluded: string[] = [];
  // gpt-6-astra's review of t622, finding 6: without the offers, a standing
  // assignment could suggest a model nobody can claim over a live one.
  // Offered for this very dispatch: a build, sent where the entry runs, as
  // the dispatch route sends it (gpt-6-astra's second review, finding 2).
  const offeredFor = (entry: ModelEntry) => (input.offers ? offering({ to: entry.where }, input.offers) : null);
  const refusalOf = (entry: ModelEntry): string => {
    const actor = actorOf(entry);
    const held = standingRefusal(entry, "build");
    if (held) return held;
    const offered = offeredFor(entry);
    if (offered && !offered.actors.has(actor.toLowerCase())) return `no live runner offers ${actor} for a build ${entry.where === "home" ? "at home" : "in the cloud"}, so no runner could claim its dispatch`;
    if (single && actorFamily(actor) !== single) return `not one of ${single}'s models (single-family mode)`;
    if (strict && !frontier(entry)) return "not frontier";
    if (stalledBuilder(entry, input)) return "two consecutive stalled builds; no successful build since";
    if (entry.status?.state === "refused") return "provider refused";
    if (paidPerToken(entry)) return "per-token spending is not authorized";
    try { assertEligible(actor, input.policy, input.owner); } catch (e) { if (!(e instanceof RuleError)) throw e; return e.message; }
    return "";
  };
  // The developer's explicit --model and --to narrow the candidates first;
  // a build assignment then puts its eligible choices ahead of the outcome
  // ranking (src/models/assignments.ts, precedence).
  const rows = ranked(input)
    .filter(({ entry }) => !(constraints.model && !entryRuns(entry, String(constraints.model))))
    .filter(({ entry }) => !(constraints.to && constraints.to !== "any" && constraints.to !== entry.where))
    .map((row) => ({ ...row, refusal: refusalOf(row.entry) }));
  const assigned = applicableAssignments(input.assignments ?? [], input.project, ["build"]);
  const byAssignment = orderByAssignment(rows, (r) => actorOf(r.entry), assigned, (r) => r.refusal || null, FALLBACK.build, input.pool);
  // A model the developer names with --model comes before every build
  // assignment, which is named as skipped for it.
  const said = (row: (typeof rows)[number]) => (constraints.model ? aheadOfAssignments(assigned, "the developer's --model").lines : byAssignment.reasons(row));
  for (const row of byAssignment.order) {
    const { entry, score, reason, refusal } = row;
    const actor = actorOf(entry);
    if (refusal) { excluded.push(`${actor}: ${refusal}`); continue; }
    const note = latestNote(entry, input.project, input.item.id);
    return { actor, where: entry.where, reasons: [why, ...said(row), `Outcome score ${score.toFixed(3)}. ${reason}`, ...(note ? [noteLine(note)] : []), ...excluded.map((s) => `Passed over ${s}.`)] };
  }
  throw new RuleError("no_builder", `${why} No eligible builder in the pool. ${excluded.join("; ")}`, 409);
}
