// How many tasks a design plans (t601). A plan the developer approves is filed
// whole the same day; `atelier design NAME --planned N --quote WORDS` records
// the count as a design.planned event in the project's ledger, and Atelier
// shows the designs that fewer tasks name than were planned, so a planned task
// left unfiled does not go unseen. Pure: the Ledger reads its events and its
// tasks and passes them in, and index.ts and the CLI only wire.

import { RuleError } from "./rules.ts";
import { TEXT_CONTROLS } from "./text.ts";

export const DESIGN_NAME_MAX = 80;      // as a task's design is (src/rules.ts)
export const PLANNED_MAX = 50;
export const PLANNED_QUOTE_MAX = 2000;
export const PLANNED_EVENT = "design.planned";

export interface PlannedInput { name: string; planned: number; quote: string }
export interface DesignPlan extends PlannedInput { by: string; acting: string | null; at: string }
export interface DesignView { name: string; planned: number; filed: number; quote: string; at: string }

const flat = (v: string) => v.replace(TEXT_CONTROLS, " ").replace(/\s+/g, " ").trim();

// What a record says, checked before anything is written. The name must be one
// a task could name with --design: text on one line, at most DESIGN_NAME_MAX.
export function cleanPlanned(body: Record<string, unknown>): PlannedInput {
  const { name, planned, quote } = body;
  if (typeof name !== "string" || !name.trim() || flat(name) !== name || name.length > DESIGN_NAME_MAX)
    throw new RuleError("bad_design", `a design is a short name of one line, at most ${DESIGN_NAME_MAX} characters, as a task's --design gives it`, 400, "name the design as atelier edit --design does");
  if (typeof planned !== "number" || !Number.isInteger(planned) || planned < 1 || planned > PLANNED_MAX)
    throw new RuleError("bad_planned", `--planned is a whole number of tasks from 1 to ${PLANNED_MAX}`, 400, `give --planned a whole number from 1 to ${PLANNED_MAX}`);
  const words = typeof quote === "string" ? flat(quote) : "";
  if (!words) throw new RuleError("bad_quote", "a design's planned count needs the developer's words: --quote \"what the developer said\"", 400);
  if (words.length > PLANNED_QUOTE_MAX) throw new RuleError("too_long", `the developer's words are at most ${PLANNED_QUOTE_MAX} characters`, 400);
  return { name, planned, quote: words };
}

interface PlannedEvent { kind: string; at: string; seq: number; data: Record<string, unknown> }

// The latest record for each design name: the one with the highest seq.
export function plansOf(events: readonly PlannedEvent[]): DesignPlan[] {
  const latest = new Map<string, PlannedEvent>();
  for (const e of events) {
    if (e.kind !== PLANNED_EVENT || typeof e.data.name !== "string") continue;
    const was = latest.get(e.data.name);
    if (!was || e.seq > was.seq) latest.set(e.data.name, e);
  }
  return [...latest.values()].sort((a, b) => a.seq - b.seq).map((e) => ({
    name: String(e.data.name), planned: Number(e.data.planned), quote: String(e.data.quote ?? ""),
    by: String(e.data.by ?? ""), acting: typeof e.data.acting === "string" ? e.data.acting : null, at: e.at,
  }));
}

// A record equal to the latest in name, count and quote adds nothing, so a
// request resent after a timeout, or sent twice at once, is one event.
export const repeats = (latest: PlannedInput | undefined, next: PlannedInput): boolean =>
  !!latest && latest.name === next.name && latest.planned === next.planned && latest.quote === next.quote;

// Every design a record names, with K, the tasks naming it in any state.
// A design no record names is not listed.
export function designViews(plans: readonly DesignPlan[], items: readonly { design?: string | null }[]): DesignView[] {
  const filed = new Map<string, number>();
  for (const i of items) if (i.design) filed.set(i.design, (filed.get(i.design) ?? 0) + 1);
  return plans.map((p) => ({ name: p.name, planned: p.planned, filed: filed.get(p.name) ?? 0, quote: p.quote, at: p.at }));
}

export const unfiled = (views: readonly DesignView[]): DesignView[] => views.filter((v) => v.filed < v.planned);

export const unfiledLine = (v: Pick<DesignView, "name" | "planned" | "filed">): string =>
  `Design ${v.name}: ${v.filed} of ${v.planned} tasks filed`;
