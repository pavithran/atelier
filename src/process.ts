// The Process tab (t558): the whole task flow as a flowchart, with the time
// tasks spend in each block and how often each loop runs. docs/process.md says
// what every block and loop measures. Nothing here recomputes a phase: the
// phases and rates are src/flow.ts's report (computeFlow) for the tasks filed
// in the window, the deploy bars are computeBars's, and the page only
// arranges those figures and counts the loop events the report does not hold.
// The approved mockup is docs/design/process-map/a-process-map.html.
import { computeBars, computeFlow, deployedMerges, midpoint, nearestRank, DEPLOY_MEDIAN_BAR, DEPLOY_P90_BAR, type BarEvent, type BarStatus, type FlowReport, type Phase } from "./flow.ts";
import { readEvents } from "./now.ts";
import { REVIEW_ROUND_CAP } from "./rules.ts";
import processCss from "./process.css";

export const PROCESS_CSS = processCss;

export type WindowId = "7d" | "30d";
export type Stat = "median" | "p90";
const DAY_MS = 86_400_000;
const WINDOW_DAYS: Record<WindowId, number> = { "7d": 7, "30d": 30 };

// Any other value is the default, so a stale or mistyped link still draws.
export const parseWindow = (value: string | null): WindowId => (value === "30d" ? "30d" : "7d");
export const parseStat = (value: string | null): Stat => (value === "p90" ? "p90" : "median");

// ── the model ──────────────────────────────────────────────────────────────

export interface Block {
  id: "criteriaReview" | "runnerWait" | "build" | "checks" | "reviewWait" | "landWait" | "merge";
  // The flow phases the block adds together.
  phases: Phase[];
  // Tasks that entered the block and whose time is known (an open stretch counts).
  tasks: number;
  median: number | null;
  p90: number | null;
  // The block's share of all measured time, as flow's phaseShares.
  share: number | null;
}
export interface Count { events: number; tasks: number }
export interface Card { value: number | null; previous: number | null; status?: BarStatus; target?: string; mean?: number | null }
export interface ProcessModel {
  project: string;
  windowId: WindowId;
  days: number;
  since: string;
  until: string;
  report: FlowReport;
  previous: FlowReport;
  blocks: Block[];
  loops: { fixRound: Count; checkFailed: Count; conflict: Count; criteriaRejected: Count; roundCap: Count };
  cards: { deployMedian: Card; deployP90: Card; toMerge: Card; rounds: Card };
  ship: { merges: number; deployed: number; median: number | null; p90: number | null; notDeployed: string[] };
}

const BLOCKS: Pick<Block, "id" | "phases">[] = [
  { id: "criteriaReview", phases: ["criteriaReview"] },
  { id: "runnerWait", phases: ["runnerWait"] },
  { id: "build", phases: ["build"] },
  { id: "checks", phases: ["checks"] },
  { id: "reviewWait", phases: ["reviewWait"] },
  { id: "landWait", phases: ["accept", "waitToLand"] },
  { id: "merge", phases: ["merge"] },
];

// The tasks whose creation falls in [from, to], each with its events in order.
// A task whose record starts later than its creation (a cut record) has no
// filing time and is left out.
function tasksFiled(events: readonly BarEvent[], from: number, to: number): { id: string; events: BarEvent[] }[] {
  const by = new Map<string, BarEvent[]>();
  for (const e of events) if (e.itemId) (by.get(e.itemId) ?? by.set(e.itemId, []).get(e.itemId)!).push(e);
  const out: { id: string; events: BarEvent[] }[] = [];
  for (const [id, list] of by) {
    list.sort((a, b) => a.seq - b.seq);
    const at = Date.parse(list[0].at);
    if (list[0].kind === "item.created" && at >= from && at <= to) out.push({ id, events: list });
  }
  return out;
}

export function buildProcess(project: string, events: readonly BarEvent[], now: number, windowId: WindowId): ProcessModel {
  const days = WINDOW_DAYS[windowId];
  const since = now - days * DAY_MS;
  const filed = tasksFiled(events, since, now);
  const report = computeFlow(filed, now);
  const previous = computeFlow(tasksFiled(events, since - days * DAY_MS, since - 1), now);

  const blocks: Block[] = BLOCKS.map(({ id, phases }) => {
    const minutes: number[] = [];
    for (const t of report.tasks) {
      const known = phases.filter((p) => !t.phases[p].unknown);
      if (!known.some((p) => t.phases[p].ms > 0 || t.phases[p].open)) continue;
      minutes.push(known.reduce((sum, p) => sum + t.phases[p].ms, 0) / 60_000);
    }
    const shares = phases.map((p) => report.phaseShares[p]);
    return { id, phases, tasks: minutes.length, median: midpoint(minutes), p90: nearestRank(minutes, 0.9), share: shares.every((s) => s === null) ? null : shares.reduce<number>((sum, s) => sum + (s ?? 0), 0) };
  });

  const count = (of: (t: FlowReport["tasks"][number]) => number): Count => ({ events: report.tasks.reduce((n, t) => n + of(t), 0), tasks: report.tasks.filter((t) => of(t) > 0).length });
  const eventsOf = (kind: string): Count => {
    const per = filed.map((t) => t.events.filter((e) => e.kind === kind).length);
    return { events: per.reduce((a, b) => a + b, 0), tasks: per.filter((n) => n > 0).length };
  };

  const bars = (at: number) => computeBars([{ name: project, events }], at, undefined, days).scopes[0].bars;
  const bar = (list: ReturnType<typeof bars>, id: string) => list.find((b) => b.id === id)!;
  const nowBars = bars(now), thenBars = bars(since);
  const deploy = (id: string): Card => {
    const b = bar(nowBars, id);
    return { value: b.value, previous: bar(thenBars, id).value, status: b.status, target: b.target };
  };
  const submissions = report.tasks.filter((t) => t.complete).map((t) => t.submissions);

  const merges = deployedMerges(events, now, days);
  const times = merges.flatMap((m) => (m.mergeToDeployed === null ? [] : [m.mergeToDeployed]));
  return {
    project, windowId, days, since: new Date(since).toISOString(), until: new Date(now).toISOString(), report, previous, blocks,
    loops: {
      fixRound: count((t) => t.rejections),
      checkFailed: count((t) => t.checkFailures),
      conflict: count((t) => t.conflicts),
      criteriaRejected: eventsOf("criteria_review.rejected"),
      // The ledger logs review.round_cap once, when it holds the task for the developer.
      roundCap: eventsOf("review.round_cap"),
    },
    cards: {
      deployMedian: deploy("deployMedian"),
      deployP90: deploy("deployP90"),
      toMerge: { value: report.medianMinutesToMerge, previous: previous.medianMinutesToMerge },
      rounds: { value: report.medianReviewRounds, previous: previous.medianReviewRounds, mean: submissions.length ? submissions.reduce((a, b) => a + b, 0) / submissions.length : null },
    },
    ship: { merges: merges.length, deployed: times.length, median: midpoint(times), p90: nearestRank(times, 0.9), notDeployed: merges.filter((m) => !m.deployed).map((m) => m.key) },
  };
}

// Every event the page needs, oldest first. The read of the project ledger
// stops at the start of the window before the one shown, so the tasks of the
// comparison are whole too; that keeps a long ledger fast. A task seen in that
// read whose filing lies further back is then read by itself, so its filed-to-
// deployed time is the one `atelier flow --bars` reports. The bound is the
// tasks in the window, never the age of an event.
export async function readProcessEvents<E extends BarEvent>(
  page: (before: number | undefined) => Promise<E[]>,
  task: (itemId: string) => Promise<E[]>,
  size: number, now: number, windowId: WindowId,
): Promise<E[]> {
  const from = now - 2 * WINDOW_DAYS[windowId] * DAY_MS;
  const bySeq = new Map<number, E>();
  for (const e of await readEvents(page, size, (last) => Date.parse(last.at) < from)) bySeq.set(e.seq, e);
  const filed = new Set<string>(), seen = new Set<string>();
  for (const e of bySeq.values()) if (e.itemId) { seen.add(e.itemId); if (e.kind === "item.created") filed.add(e.itemId); }
  for (const id of seen) {
    if (filed.has(id)) continue;
    for (const e of await task(id)) bySeq.set(e.seq, e);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

// ── words and numbers ──────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const trimZero = (s: string) => s.replace(/\.0$/, "");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Minutes as a reader wants them: under a minute is "<1", under 100 minutes
// stays minutes, anything longer is hours.
export function minutesText(minutes: number): { number: string; unit: "min" | "h" } {
  if (minutes < 1) return { number: "<1", unit: "min" };
  const digits = (n: number) => (n < 10 ? trimZero(n.toFixed(1)) : String(Math.round(n)));
  if (minutes < 100) return { number: digits(minutes), unit: "min" };
  return { number: digits(minutes / 60), unit: "h" };
}
const minutesLine = (minutes: number) => { const t = minutesText(minutes); return `${t.number} ${t.unit}`; };
const percent = (share: number) => (share < 0.01 ? "<1%" : `${Math.round(share * 100)}%`);
const plain = (n: number) => trimZero(n.toFixed(1));

function dates(since: string, until: string): string {
  const a = new Date(since), b = new Date(until);
  const month = (d: Date) => d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return a.getUTCMonth() === b.getUTCMonth() ? `${month(a)} ${a.getUTCDate()} – ${b.getUTCDate()}` : `${month(a)} ${a.getUTCDate()} – ${month(b)} ${b.getUTCDate()}`;
}

// ── the map ────────────────────────────────────────────────────────────────

interface Geo { w: number; h: number; track: number; trackDy: number; pctDx: number; pctDy: number }
const DESK: Geo = { w: 192, h: 124, track: 124, trackDy: 104, pctDx: 178, pctDy: 111 };
const PHONE: Geo = { w: 252, h: 128, track: 184, trackDy: 108, pctDx: 238, pctDy: 115 };

// The ten blocks in the order the mockup draws them: id, kicker word, colour class, name.
const NODES = [
  ["file", "start", "n-end", "File the task"],
  ["criteriaReview", "judge", "n-judge", "Criteria review"],
  ["runnerWait", "wait", "n-wait", "Dispatch, runner wait"],
  ["build", "work", "n-work", "Build"],
  ["checks", "work", "n-work", "Checks, clean clone"],
  ["reviewWait", "judge", "n-judge", "Code review"],
  ["landWait", "wait", "n-wait", "Accept, wait to land"],
  ["merge", "work", "n-work", "Land"],
  ["ship", "ship", "n-wait", "Ship"],
  ["live", "end", "n-end", "Live"],
] as const;
const DESK_AT: [number, number][] = [[0, 150], [232, 150], [464, 150], [696, 150], [928, 150], [928, 420], [696, 420], [464, 420], [232, 420], [0, 420]];
const PHONE_AT: [number, number][] = [10, 188, 366, 544, 722, 900, 1148, 1326, 1504, 1682].map((y) => [0, y]);

// Stroke width of a loop's arrow: heavier the more it happens, capped.
const loopWidth = (events: number) => Math.min(7, 1.5 + 0.8 * Math.sqrt(events)).toFixed(1);
const pillWidth = (chars: number) => Math.round((16 + 6.6 * chars) * 10) / 10;

interface View { model: ProcessModel; stat: Stat; empty: boolean; hot: string | null }

function node(v: View, g: Geo, at: [number, number], index: number): string {
  const [id, word, kind, name] = NODES[index];
  const [x, y] = at, m = v.model, other = v.stat === "median" ? "p90" : "median";
  const head = `<rect class="n-box" x="${x}" y="${y}" width="${g.w}" height="${g.h}" rx="12"/>
<text class="n-kick" x="${x + 14}" y="${y + 22}">${index + 1} · ${word}</text>
<text class="n-name" x="${x + 14}" y="${y + 42}">${name}</text>`;
  const big = (n: string, unit: string) => `<text x="${x + 14}" y="${y + 76}"><tspan class="n-big">${esc(n)}</tspan><tspan class="n-unit" dx="5">${esc(unit)}</tspan></text>`;
  const none = `<text class="n-none" x="${x + 14}" y="${y + 76}">no tasks</text>`;
  const sub = (text: string, dy = 95) => `<text class="n-sub" x="${x + 14}" y="${y + dy}">${esc(text)}</text>`;
  const group = (cls: string, inner: string) => `<g class="${cls} fade-in">\n${head}\n${inner}\n</g>`;

  if (id === "file") return group(kind, v.empty ? none : `${big(String(m.report.counted), "filed")}\n${sub("tasks with a full record")}`);
  if (id === "live") return group(kind, m.ship.merges === 0 ? none : `${big(String(m.ship.deployed), `of ${m.ship.merges}`)}\n${sub("merges deployed")}`);
  if (id === "ship") {
    const s = m.ship, value = s[v.stat], otherValue = s[other];
    if (s.merges === 0) return group(kind, none);
    if (value === null) return group(kind, `${big("none", "deployed")}\n${sub(`${plural(s.merges, "merge")} not deployed`)}`);
    const t = minutesText(value);
    return group(kind, `${big(t.number, `${t.unit} ${v.stat}`)}\n${sub(`${other} ${minutesLine(otherValue!)} · ${s.deployed} of ${s.merges} deployed`)}${s.notDeployed.length ? `\n${sub(`${s.notDeployed.length} merged, not deployed`, 112)}` : ""}`);
  }
  const b = m.blocks.find((k) => k.id === id)!;
  const cls = id === v.hot ? "n-hot" : kind;
  const value = b[v.stat];
  if (b.tasks === 0 || value === null || b.share === null) return group(cls, none);
  const t = minutesText(value);
  const holds = id === "runnerWait" ? `\n<text class="n-sub" x="${x + 14}" y="${y + 142}">incl. core-file holds</text>` : "";
  const fill = Math.max(2, Math.round(b.share * g.track * 10) / 10);
  return `${group(cls, `${big(t.number, `${t.unit} ${v.stat}`)}
${sub(`${other} ${minutesLine(b[other]!)} · ${plural(b.tasks, "task")}`)}
<rect class="n-track" x="${x + 14}" y="${y + g.trackDy}" width="${g.track}" height="6" rx="3"/>
<rect class="n-fill" x="${x + 14}" y="${y + g.trackDy}" width="${fill}" height="6" rx="3"/>
<text class="n-pct" x="${x + g.pctDx}" y="${y + g.pctDy}" text-anchor="end">${percent(b.share)}</text>`)}${holds}`;
}

// One loop: its dashed arrow and the pill that counts it. `place` gives the
// pill's x from its width.
function loop(v: View, mark: string, path: string, c: Count, label: string, y: number, place: (w: number) => number): string {
  if (v.empty) {
    const text = `${label} · no tasks`, w = pillWidth(text.length + 2);
    return `<path class="e-loop unmeasured" d="${path}" stroke-width="1.5" marker-end="url(#lhu-${mark})"/><g class="fade-in"><rect class="l-pill unmeasured" x="${place(w)}" y="${y}" width="${w}" height="26" rx="13"/><text x="${place(w) + 12}" y="${y + 17.5}"><tspan class="l-n" style="fill:var(--text-muted)">—</tspan><tspan class="l-t muted" dx="7">${esc(text)}</tspan></text></g>`;
  }
  const text = `${label} · ${plural(c.tasks, "task")}`, w = pillWidth(String(c.events).length + 1 + text.length);
  return `<path class="e-loop" d="${path}" stroke-width="${loopWidth(c.events)}" marker-end="url(#lh-${mark})"/><g class="fade-in"><rect class="l-pill" x="${place(w)}" y="${y}" width="${w}" height="26" rx="13"/><text x="${place(w) + 12}" y="${y + 17.5}"><tspan class="l-n">${c.events}</tspan><tspan class="l-t" dx="7">${esc(text)}</tspan></text></g>`;
}

const defs = (mark: string) => `<defs><marker id="ah-${mark}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path class="e-head" d="M0 0L8 4L0 8z"/></marker>
<marker id="lh-${mark}" viewBox="0 0 8 8" refX="6" refY="4" markerUnits="userSpaceOnUse" markerWidth="11" markerHeight="11" orient="auto"><path class="e-loop-head" d="M0 0L8 4L0 8z"/></marker>
<marker id="lhu-${mark}" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path fill="var(--line-bright)" d="M0 0L8 4L0 8z"/></marker></defs>`;
const arrow = (mark: string, d: string) => `<path class="e-flow" d="${d}" marker-end="url(#ah-${mark})"/>`;

// The round-cap box, below the code review block: tasks held for the developer.
function capBox(v: View, x: number, y: number, w: number, phone: boolean): string {
  const c = v.model.loops.roundCap;
  const n = v.empty ? "no tasks" : String(c.tasks);
  return `<g class="blocked fade-in"><rect class="n-box" x="${x}" y="${y}" width="${w}" height="${phone ? 52 : 58}" rx="12"/>
${v.empty ? `<text class="n-none" x="${x + 14}" y="${y + (phone ? 32 : 36)}">no tasks · round cap</text>` : `<text x="${x + 14}" y="${y + (phone ? 32 : 36)}"><tspan class="n-big" style="font-size:${phone ? 22 : 24}px">${esc(n)}</tspan><tspan class="n-unit" dx="6">${phone ? "blocked, round cap" : "blocked"}</tspan></text>`}${phone ? "" : `\n<text class="n-sub" x="${x + 14}" y="${y + 52}">at the round cap</text>`}</g>`;
}

function desk(v: View): string {
  const l = v.model.loops;
  const idx = NODES.findIndex((n) => n[0] === v.hot);
  const [hx, hy] = idx >= 0 ? DESK_AT[idx] : [0, 0];
  const callout = idx >= 1 && idx <= 4 && v.model.blocks.some((b) => b.id === v.hot)
    ? `<line class="callout-line" x1="${hx + 96}" y1="122" x2="${hx + 96}" y2="${hy - 4}"/><text class="callout" x="${idx === 4 ? 1120 : hx + 96}" y="118" text-anchor="${idx === 4 ? "end" : "middle"}">${percent(v.model.blocks.find((b) => b.id === v.hot)!.share!)} of measured time is spent here</text>`
    : "";
  return `<svg class="desk" viewBox="-4 40 1128 618" role="img" aria-label="The task process as a flowchart">${defs("d")}${[
    "M194 212.0H229", "M426 212.0H461", "M658 212.0H693", "M890 212.0H925", "M1024.0 276V417", "M926 482.0H891", "M694 482.0H659", "M462 482.0H427", "M230 482.0H195",
  ].map((d) => arrow("d", d)).join("")}${loop(v, "d", "M368.0 148C368.0 94 288.0 94 288.0 144", l.criteriaRejected, "criteria rejected", 71, () => 197.4)}${loop(v, "d", "M1024.0 148C1024.0 90 792.0 90 792.0 142", l.checkFailed, "check failed", 75, () => 814)}${loop(v, "d", "M962 418V365.0Q962 347.0 944 347.0H810.0Q792.0 347.0 792.0 329.0V282", l.fixRound, "rejected, fix round", 334, (w) => Math.round((806 - w) * 10) / 10)}${loop(v, "d", "M520.0 546C520.0 598 600.0 598 600.0 550", l.conflict, "conflict", 593, (w) => Math.round((560 - w / 2) * 10) / 10)}<path class="e-loop${v.empty ? " unmeasured" : ""}" d="M1024.0 546V584" stroke-width="${v.empty ? "1.5" : loopWidth(l.roundCap.tasks)}" marker-end="url(#${v.empty ? "lhu" : "lh"}-d)"/>${capBox(v, 928, 588, 192, false)}${callout}
${NODES.map((_, i) => node(v, DESK, DESK_AT[i], i)).join("\n")}</svg>`;
}

function phone(v: View): string {
  const l = v.model.loops;
  const links = PHONE_AT.slice(0, -1).map(([, y], i) => arrow("p", `M24 ${y + PHONE.h + 2}V${PHONE_AT[i + 1][1] - 3}`));
  const idx = NODES.findIndex((n) => n[0] === v.hot);
  const hot = idx >= 0 ? v.model.blocks.find((b) => b.id === v.hot) : undefined;
  const callout = hot?.share != null ? `<text class="callout" x="262" y="${PHONE_AT[idx][1] + 50}">${percent(hot.share)}</text><text class="n-sub" x="262" y="${PHONE_AT[idx][1] + 66}">of all</text><text class="n-sub" x="262" y="${PHONE_AT[idx][1] + 80}">time</text>` : "";
  return `<svg class="phone" viewBox="-2 0 334 1860" role="img" aria-label="The task process as a flowchart">${defs("p")}${links.join("")}${loop(v, "p", "M254 218C298 218 298 270 260 270", l.criteriaRejected, "criteria rejected", 328, () => 40)}${loop(v, "p", "M254 786.0C300 786.0 300 608.0 260 608.0", l.checkFailed, "check failed", 862, () => 40)}${loop(v, "p", "M254 964.0C346 964.0 346 608.0 260 608.0", l.fixRound, "rejected, fix round", 684, () => 40)}${capBox(v, 48, 1042, 204, true)}<path class="e-loop${v.empty ? " unmeasured" : ""}" d="M30 1030V1068H44" stroke-width="${v.empty ? "1.5" : loopWidth(l.roundCap.tasks)}" marker-end="url(#${v.empty ? "lhu" : "lh"}-p)"/>${loop(v, "p", "M254 1356C298 1356 298 1408 260 1408", l.conflict, "conflict", 1466, () => 40)}${callout}
${NODES.map((_, i) => node(v, PHONE, PHONE_AT[i], i)).join("\n")}</svg>`;
}

// ── the page ───────────────────────────────────────────────────────────────

const HOT_WORDS: Record<string, string> = { criteriaReview: "in criteria review", runnerWait: "waiting for a runner", build: "being built", checks: "in checks", reviewWait: "waiting for review", landWait: "waiting to land", merge: "landing" };
// A block is hot when it holds a third or more of the measured time.
const HOT_SHARE = 1 / 3;

function card(label: string, value: string, cls: string, meta: string, extra = "", small = ""): string {
  return `<div class="fig${cls ? ` ${cls}` : ""}"><dt>${label}</dt><dd>${value}${small ? `<small>${small}</small>` : ""}</dd>${extra}<p class="meta">${meta}</p></div>`;
}

export function renderProcess(m: ProcessModel, stat: Stat, base: string): string {
  const empty = m.report.tasks.length === 0;
  const ranked = m.blocks.filter((b) => b.share !== null && b.tasks > 0).sort((a, b) => b.share! - a.share!);
  const hot = ranked.length && ranked[0].share! >= HOT_SHARE ? ranked[0] : null;
  const v: View = { model: m, stat, empty, hot: hot?.id ?? null };
  const span = `the previous ${m.days} days`;
  const link = (since: WindowId, s: Stat, label: string, on: boolean) => `<a href="${base}?since=${since}&amp;stat=${s}"${on ? ' aria-current="true"' : ""}>${label}</a>`;

  const was = (value: number | null, show: (n: number) => string) => (value === null ? `no tasks ${span}` : `was ${show(value)} ${span}`);
  const deploy = (label: string, c: Card, limit: number) => {
    const target = `target ${c.target}`;
    if (c.value === null) return card(label, `<span class="none">${c.status === "unmeasured" ? "none deployed" : "no tasks"}</span>`, "", `${target} · ${was(c.previous, minutesLine)}`);
    const scale = Math.max(c.value, limit);
    const bar = `<span class="target"><i class="bar-in" style="width:${(c.value / scale * 100).toFixed(1)}%"></i><b style="left:${(limit / scale * 100).toFixed(1)}%"></b></span>`;
    return card(label, minutesLine(c.value), c.status === "fail" ? "over" : c.status === "pass" ? "good" : "", `${target} · ${was(c.previous, minutesLine)}`, bar);
  };
  const c = m.cards;
  const cards = [
    deploy("Filed to deployed, median", c.deployMedian, DEPLOY_MEDIAN_BAR),
    deploy("Filed to deployed, p90", c.deployP90, DEPLOY_P90_BAR),
    c.toMerge.value === null ? card("Filed to merged, median", `<span class="none">no tasks</span>`, "", was(c.toMerge.previous, minutesLine))
      : card("Filed to merged, median", minutesLine(c.toMerge.value), "", was(c.toMerge.previous, minutesLine)),
    c.rounds.value === null ? card("Review rounds per task, median", `<span class="none">no tasks</span>`, "", was(c.rounds.previous, plain))
      : card("Review rounds per task, median", plain(c.rounds.value), c.rounds.previous === null || c.rounds.value === c.rounds.previous ? "" : c.rounds.value < c.rounds.previous ? "good" : "over", was(c.rounds.previous, plain), "", `mean ${plain(c.rounds.mean!)}`),
  ].join("\n  ");

  const h1 = hot && hot.share! >= 0.5 ? `Most of a task's life is <em>${HOT_WORDS[hot.id]}</em>` : "Where a task's time goes";
  const notDeployed = m.ship.notDeployed.length ? `<p class="meta">${m.ship.notDeployed.length} merged, not deployed: ${m.ship.notDeployed.map((id) => esc(id)).join(", ")}.</p>` : "";
  return `<div class="dash"><header class="dash-head">
  <div><span class="kicker">${esc(m.project)} · tasks filed ${dates(m.since, m.until)} · from the ledger</span>
  <h1>${h1}</h1><p class="lead">Every block is one phase of the process, with how long tasks spend in it and its share of all measured time. Every dashed arrow is a loop, with how often it went round in the last ${m.days} days.</p></div>
  <div class="controls"><div class="seg" role="group" aria-label="Window">${link("7d", stat, "7 days", m.windowId === "7d")}${link("30d", stat, "30 days", m.windowId === "30d")}</div><div class="seg" role="group" aria-label="Statistic">${link(m.windowId, "median", "Median", stat === "median")}${link(m.windowId, "p90", "p90", stat === "p90")}</div></div>
</header><dl class="figs">
  ${cards}
</dl><ul class="legend"><li><i class="k-work"></i>Work</li><li><i class="k-wait"></i>Waiting</li><li><i class="k-judge"></i>Judgement</li><li><i class="k-loop"></i>Loop, drawn heavier the more it happens</li></ul>
<figure class="map card" style="padding:26px clamp(10px,2vw,24px) 18px">${desk(v)}${phone(v)}</figure>${notDeployed}
<p class="meta foot">Phases and loops: <code>atelier flow --json</code>, tasks filed in the window with a full record; minutes are each phase's total per task, medians and p90s over the tasks that entered it, and a share is the phase's part of all measured time. Failed checks, conflicts and fix rounds are counted as docs/flow.md counts them; criteria rejections are <code>criteria_review.rejected</code> events and the round cap is <code>review.round_cap</code>, in the same tasks. Deploy times: <code>atelier flow --bars</code>, over merges in the window. Ship is measured, from <code>item.merged</code> to the deploy step's <code>action.ran</code> of the ship that deployed it, over the merges in the window; merged tasks with no deploy yet are counted apart and named. Runner wait includes core-file holds: the ledger does not record them apart. Accept and wait to land are added together. See <code>docs/process.md</code>.</p></div>`;
}
