import type { Item, ProjectPolicy } from "../rules.ts";
import { assertEligible, DEFAULT_OWNER, modelKey, RuleError } from "../rules.ts";
import { latestNote, noteLine, type ModelEntry } from "./pool.ts";
import { buildReliability, outcomesOf, reliabilityLine, tiebreak, type ProjectEvents, type RunReport } from "./reliability.ts";
import { paidPerToken, type Choice } from "../plans/route.ts";
import { servedActor, servedBy } from "./served.ts";

export interface SuggestionRecords { sources: ProjectEvents[]; runs: RunReport[] }
type Task = Pick<Item, "id" | "title" | "brief" | "scope" | "owner" | "pushActors">;
export interface SuggestionInput extends SuggestionRecords {
  item: Task;
  project: string;
  pool: readonly ModelEntry[];
  policy: ProjectPolicy;
  owner?: string;
  frontierRequired?: boolean;
}
const actorOf = (m: ModelEntry) => `${m.harness}/${m.id}`;
const keysOf = (m: ModelEntry) => new Set([m.id, ...m.aliases].map(modelKey));
export const frontier = (m: ModelEntry) => [m.id, ...m.aliases].some((id) => /(?:^|[-/])(fable|opus)(?:[-.]|$)|^gpt-6-astra(?:[-.:]|$)/i.test(id));
export const sensitive = (item: Task) => /\b(security|auth(?:entication|orization)?|concurren\w*|race|locking|locks?|leases?|gates?)\b/i.test([item.title, item.brief, ...item.scope].join(" "));

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
  const why = rejections >= 2 ? "Two rejections require a frontier builder." : strict ? "Security, concurrency or gate work requires a frontier builder." : "Eligible pool models ranked by recorded successful and failed outcomes.";
  const excluded: string[] = [];
  for (const { entry, score, reason } of ranked(input)) {
    const actor = actorOf(entry);
    let refusal = "";
    if (constraints.model && ![entry.id, ...entry.aliases].includes(String(constraints.model))) continue;
    if (constraints.to && constraints.to !== "any" && constraints.to !== entry.where) continue;
    if (strict && !frontier(entry)) refusal = "not frontier";
    else if (stalledBuilder(entry, input)) refusal = "two consecutive stalled builds; no successful build since";
    else if (entry.status?.state === "refused") refusal = "provider refused";
    else if (paidPerToken(entry)) refusal = "per-token spending is not authorized";
    else { try { assertEligible(actor, input.policy, input.owner); } catch (e) { if (!(e instanceof RuleError)) throw e; refusal = e.message; } }
    if (refusal) { excluded.push(`${actor}: ${refusal}`); continue; }
    const note = latestNote(entry, input.project, input.item.id);
    return { actor, where: entry.where, reasons: [why, `Outcome score ${score.toFixed(3)}. ${reason}`, ...(note ? [noteLine(note)] : []), ...excluded.map((s) => `Passed over ${s}.`)] };
  }
  throw new RuleError("no_builder", `${why} No eligible builder in the pool. ${excluded.join("; ")}`, 409);
}
