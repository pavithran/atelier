// Today (t562; PAVI chose redesign A on 2026-11-08): the one page at / that
// answers what waits for the developer, what is running, what merged and
// deployed today, and how each project is doing. It absorbs Home, Now and
// Decisions, and a needs-you card links to the task's page. Its one action is Land, on a card whose call is land or accept (t594).
//
// todayInputsOf reads each project's events once, back 14 days, and cuts them
// into the 48-hour slice buildNow takes and the 14-day slice buildPulse takes;
// the deploys are counted from that day's ship.recorded events in the same
// read, never from the ledger's newest-50 list. buildToday is pure: it reads
// no clock and no store, so the page and the tests see one model.
//
// Times are Eastern and "today" is the Eastern day, as on the Now page.
import { attentionFor, type Attention } from "./attention.ts";
import type { DeployRecord } from "./checkout-lease.ts";
import type { LedgerEvent } from "./ledger";
import { buildNow, EASTERN, readEvents, type NowProject, type NowRow, type NowView } from "./now.ts";
import { buildPulse } from "./pulse.ts";
import type { PostMergeRun } from "./post-merge.ts";
import type { InboxEntry, Item } from "./rules.ts";
import { STALL_MS, type ProgressRecord, type SituationFacts } from "./situation.ts";
import { splitActor } from "./floor.ts";
import { vendorOf } from "./graph.ts";
import { machineName, runnerNameOf } from "./runner-names.ts";
import { criteriaOf } from "./criteria.ts";
import { dayInZone } from "./time.ts";
import { answerBlock, landBlock, landStateOf, LAND_CALLS, overrideBlock } from "./page-actions.ts";
import { escapeText as e, page, type Live } from "./ui";
import todayCss from "./today.css";

export const NOW_WINDOW_MS = 48 * 3_600_000;
export const PULSE_WINDOW_MS = 14 * 24 * 3_600_000;
const PAGE = 500;
const LANES_SHOWN = 12;
const DOTS_SHOWN = 24;
// A run whose progress has not changed for this long is drawn quiet, not live.
export const QUIET_MS = 10 * 60_000;

// ── the reader ─────────────────────────────────────────────────────────────

// What Today asks of a project's ledger. The route passes the real one; the
// tests pass stubs, one of which throws.
export interface TodayLedger {
  ownerRead(now: string, pool: unknown): Promise<{ items: Item[]; inbox: InboxEntry[] | null }>;
  events(id?: string, limit?: number, before?: number): Promise<LedgerEvent[]>;
  situationFacts(tasks: string[]): Promise<Pick<SituationFacts, "items" | "stages" | "reviewRequests" | "landings"> & Partial<Pick<SituationFacts, "landJobs">> & { progress?: NowProject["progress"] }>;
  postMergeRun(item: string): Promise<Pick<PostMergeRun, "state"> | null>;
}

export interface TodaySource {
  projects: { name: string; title: string; ledger: TodayLedger }[];
  pool: unknown;
  offers: Parameters<typeof attentionFor>[3];
  // The actor that stands for the owner (the pulse counts the owner's decisions apart).
  owner: string;
}

// A review request as the ledger reports it; Today reads the head under review and the reviewer's runner when it has them.
type ReviewFacts = NowProject["reviewRequests"][number] & { head?: string; runner?: string | null };

export interface TodayProjectInput {
  // For buildNow: the events of the last 48 hours (and each task merged in them, whole).
  now: NowProject;
  // For buildPulse and the day's merges and deploys: the events of the last 14 days.
  pulseEvents: LedgerEvent[];
  // Every ship.recorded of those 14 days.
  ships: DeployRecord[];
  // The post-merge run state of each task a deploy of today shipped; null: no run recorded.
  postMerge: Record<string, PostMergeRun["state"] | null>;
  // The 14-day read stopped short of the ledger's start: a deploy with no earlier shipped deploy in it may have carried older merges.
  cutShort?: boolean;
  // The landings waiting in the queue (situationFacts), and the head and criteria binding of each task the owner is asked to land or accept: what a card's Land form carries (t594).
  landJobs?: { item: string; at: string; head?: string | null }[];
  heads?: Record<string, { head: string | null; criteria: string; fact?: boolean }>;
}

export interface TodayInputs {
  projects: TodayProjectInput[];
  // Projects whose ledger could not be read: named, never counted as empty.
  unread: string[];
  owner: string;
}

const isMerge = (ev: Pick<LedgerEvent, "kind">) => ev.kind === "item.merged" || ev.kind === "item.landed_fast";

// The ship records among events, as written by recordDeploy.
export function shipsOf(events: Pick<LedgerEvent, "kind" | "at" | "data">[]): DeployRecord[] {
  return events.filter((ev) => ev.kind === "ship.recorded" && typeof ev.data?.ship === "string")
    .map((ev) => ({ ...(ev.data as unknown as DeployRecord), at: typeof ev.data.at === "string" ? ev.data.at : ev.at }));
}

// The tasks each shipped deploy carried: a merge ships with the first shipped
// deploy at or after it, as the Now page's landed rows find it.
export function mergesShippedBy(events: Pick<LedgerEvent, "kind" | "at" | "itemId">[], ships: Pick<DeployRecord, "ship" | "result" | "at">[]): Map<string, string[]> {
  const merged = new Map<string, string>();
  for (const ev of events) if (isMerge(ev) && ev.itemId && (merged.get(ev.itemId) ?? "") < ev.at) merged.set(ev.itemId, ev.at);
  const shipped = ships.filter((s) => s.result === "shipped").sort((a, b) => a.at.localeCompare(b.at));
  const by = new Map<string, string[]>();
  for (const [id, at] of [...merged].sort((a, b) => a[1].localeCompare(b[1]))) {
    const s = shipped.find((d) => d.at >= at);
    if (s) by.set(s.ship, [...(by.get(s.ship) ?? []), id]);
  }
  return by;
}

// mergesShippedBy for a 14-day read: with the read cut short, the first shipped
// deploy in it has no known previous deploy, so its merges are not known: null,
// which is not the same as an empty list.
export function carriedIn(p: Pick<TodayProjectInput, "pulseEvents" | "ships" | "cutShort">): Map<string, string[] | null> {
  const carried: Map<string, string[] | null> = mergesShippedBy(p.pulseEvents, p.ships);
  const first = p.ships.filter((s) => s.result === "shipped").sort((a, b) => a.at.localeCompare(b.at))[0];
  if (p.cutShort && first) carried.set(first.ship, null);
  return carried;
}

const onDay = (at: string, today: string) => dayInZone(at, EASTERN) === today;

async function readProject(src: TodaySource, p: TodaySource["projects"][number], now: Date): Promise<TodayProjectInput> {
  const { ledger } = p;
  const { items, inbox } = await ledger.ownerRead(now.toISOString(), src.pool);
  const from14 = now.getTime() - PULSE_WINDOW_MS, from48 = now.getTime() - NOW_WINDOW_MS;
  // The one ledger-wide read: pages back until one reaches past 14 days.
  const read = await readEvents((before) => ledger.events(undefined, PAGE, before), PAGE, (last) => Date.parse(last.at) < from14);
  const pulseEvents = read.filter((ev) => Date.parse(ev.at) >= from14);
  const cutShort = read.length > pulseEvents.length;
  const events = pulseEvents.filter((ev) => Date.parse(ev.at) >= from48);
  const recent = [...new Set(events.filter((ev) => ev.kind === "item.merged" && ev.itemId).map((ev) => ev.itemId!))];
  // The reviewer and findings of a task merged today may be older than the window: its own record, to its start.
  const seen = new Set(events.map((ev) => ev.seq));
  for (const id of recent) {
    for (const ev of await readEvents((before) => ledger.events(id, PAGE, before), PAGE)) if (!seen.has(ev.seq)) { seen.add(ev.seq); events.push(ev); }
  }
  const facts = await ledger.situationFacts(recent);
  const ships = shipsOf(pulseEvents);
  const today = dayInZone(now, EASTERN);
  const shippedToday = ships.filter((s) => s.result === "shipped" && onDay(s.at, today));
  const carried = carriedIn({ pulseEvents, ships, cutShort });
  const postMerge: TodayProjectInput["postMerge"] = {};
  for (const id of new Set(shippedToday.flatMap((s) => carried.get(s.ship) ?? []))) postMerge[id] = (await ledger.postMergeRun(id))?.state ?? null;
  return {
    now: {
      name: p.name, title: p.title, items: facts.items, stages: facts.stages, owner: attentionFor(p.name, items, inbox, src.offers, now).owner,
      reviewRequests: facts.reviewRequests, landings: facts.landings, progress: facts.progress ?? {}, events, deploys: ships,
    },
    pulseEvents, ships, postMerge, cutShort,
    landJobs: facts.landJobs ?? [],
    heads: Object.fromEntries(items.map((i) => [i.id, { head: i.head ?? null, criteria: criteriaOf(i), fact: !!i.blocked?.fact }])),
  };
}

// Every project once, in parallel. A project whose ledger throws is named in
// `unread` and left out of the figures.
export async function todayInputsOf(src: TodaySource, now: Date): Promise<TodayInputs> {
  const unread: string[] = [];
  const read = await Promise.all(src.projects.map(async (p) => {
    try { return await readProject(src, p, now); } catch { unread.push(p.name); return null; }
  }));
  return { projects: read.filter((p): p is TodayProjectInput => p !== null), unread: unread.sort(), owner: src.owner };
}

// ── the model ──────────────────────────────────────────────────────────────

export interface TodayTile {
  // null: no project could be read, so there is no figure to give.
  value: number | null;
  // Said under the figure: what it counts, or what it leaves out.
  note: string;
}
export interface TodayCard {
  id: string; project: string; title: string; href: string; call: string; why: string; family: string; age: string;
  // Set for an owner call of land or accept: the head and criteria the Land form binds to, and whether a landing already waits at that head (t594).
  land?: { head: string; criteria: string; queuedAt: string | null; failedStep: string | null; movedFrom: string | null };
  // Set for an owner call of unblock that is not a fact (Answer), or of override where the project allows it (Override): the head and criteria the form binds to (t596).
  answer?: { head: string; criteria: string };
  override?: { head: string; criteria: string };
}
// What a Running row says of its run, from the task's progress record (or, for a review, its request). A field the
// record does not hold is null and the page leaves it out.
export interface TodayRun {
  // The actor behind the row (the builder, or the reviewer), its model and its company, which colours the row's edge.
  actor: string | null; model: string | null; company: Company;
  // The model's family, for the dot beside its name.
  family: string;
  // The runner id as recorded, the machine it names and the runner's own name after the host.
  runner: string | null; machine: string | null; runnerName: string | null;
  attempt: number | null;
  // live: changed under QUIET_MS ago; quiet: longer; stalled: STALL_MS quiet with no child process alive; none: no progress to judge by.
  pulse: "live" | "quiet" | "stalled" | "none";
  pulseTitle: string;
  stage: string;
  // What the run is doing, in three parts so the command can be set apart: "" + Bash + "running 40 s", "last" + Edit + "3 min ago", "" + null + "sends no commands · changed 2 min ago".
  how: { before: string; command: string | null; after: string };
  quiet: string | null;
  // How long the run has gone, from its record's start; null without a record (the row then says how long its stage has).
  started: string | null;
  counts: string | null;
}
export type Company = "anthropic" | "openai" | "google" | "other";
export interface TodayLane { id: string; project: string; title: string; href: string; family: string; holder: string; step: number; wait: boolean; run: TodayRun; elapsed: string; stuck: boolean }
export interface TodayEvent { kind: "merge" | "deploy" | "failed"; at: string; time: string; title: string; sub: string; family: string; passed?: boolean }
export interface TodayProjectCard { name: string; title: string; unread: boolean; need: number; running: number; lastMerge: string; days: number[]; family: string }
export interface TodayView {
  at: string;
  dateText: string;
  tiles: { need: TodayTile; running: TodayTile; merged: TodayTile; deploys: TodayTile };
  // The family of each dot under the Need you and Running tiles; the merged tile's bars by Eastern hour; the deploys' squares.
  dots: { need: string[]; running: string[] };
  hours: number[];
  ships: { shipped: boolean }[];
  cards: TodayCard[];
  lanes: TodayLane[];
  lanesMore: number;
  timeline: TodayEvent[];
  projects: TodayProjectCard[];
  unread: string[];
  now: NowView;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// "12 min", "3 h", "2 d".
export function age(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}

const eastern = (at: string | Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: EASTERN, ...o }).formatToParts(new Date(at));
const part = (ps: Intl.DateTimeFormatPart[], t: string) => ps.find((p) => p.type === t)?.value ?? "";
const clockText = (at: string) => { const ps = eastern(at, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); return `${part(ps, "hour")}:${part(ps, "minute")}`; };
const hourOf = (at: string) => Number(part(eastern(at, { hour: "2-digit", hourCycle: "h23" }), "hour"));
const dateText = (at: Date) => {
  const ps = eastern(at, { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" });
  return `${part(ps, "weekday")} ${part(ps, "day")} ${part(ps, "month")} · ${part(ps, "hour")}:${part(ps, "minute")} ${part(ps, "timeZoneName")}`;
};

// The five lane stages (Claim, Branch, Prove, Review, Land), as a map from the
// ledger's stages: how many are done, so the next is current.
export const TRACK = ["Claim", "Branch", "Prove", "Review", "Land"] as const;
const STEP: Record<string, number> = { filed: 0, agreed: 0, queued: 0, building: 1, blocked: 1, built: 2, checked: 3, reviewed: 4, landable: 4, landed: 5, shipped: 5 };
export const stepOf = (stage: string): number => STEP[stage] ?? 0;

// What a deploy reads for its post-merge checks: passed only when every merge
// it carried has a complete run, else the state of the first that has not, or
// that none is recorded. Unknown membership (null) is never passed.
export function postMergeText(merges: string[] | null, states: Record<string, PostMergeRun["state"] | null>): { text: string; passed: boolean } {
  if (!merges) return { text: "post-merge run not recorded", passed: false };
  for (const id of merges) {
    const state = states[id] ?? null;
    if (state !== "complete") return { text: state ? `post-merge run ${state}` : "post-merge run not recorded", passed: false };
  }
  return merges.length ? { text: "post-merge checks passed", passed: true } : { text: "post-merge run not recorded", passed: false };
}

// "40 s", "12 min", "3 h": a duration the way a Running row reads it.
const span = (ms: number) => ms < 60_000 ? `${Math.max(1, Math.floor(ms / 1000))} s` : age(ms);
// Whole minutes without a change, as the quiet marker names them.
const quietFor = (ms: number) => ms < 120 * 60_000 ? `${Math.floor(ms / 60_000)} min` : age(ms);
const companyOf = (actor: string | null, owner: string): Company => {
  const v = actor ? vendorOf(actor, owner) : "other";
  return v === "anthropic" || v === "openai" || v === "google" ? v : "other";
};

// The run behind a Running row. A building task with a record of a run that has not ended is read from that record;
// a review from its request (its head, its reviewer's runner); anything else, a record of an earlier run included,
// has no progress to show, and only its stage and holder are said.
function runOf(r: NowRow, p: TodayProjectInput, holder: string | null, owner: string, at: Date): TodayRun {
  const stage = TRACK[Math.min(stepOf(r.stage), 4)];
  const rec: ProgressRecord | undefined = r.stage === "building" ? p.now.progress[r.id] : undefined;
  const review = r.group === "running" && r.stage !== "building"
    ? (p.now.reviewRequests as ReviewFacts[]).find((q) => q.item === r.id && q.state === "claimed" && q.claimedBy) : undefined;
  if (rec && !rec.endedAt) return recordRun(rec, stage, owner, at);
  const actor = review?.claimedBy ?? holder;
  const runner = review?.runner ?? null;
  const head = review?.head ? review.head.slice(0, 8) : null;
  return {
    actor, model: actor ? splitActor(actor).model : null, company: companyOf(actor, owner), family: actor ? vendorOf(actor, owner) : "other",
    runner, machine: runner ? machineName(runner) : null, runnerName: runner ? runnerNameOf(runner) : null,
    attempt: null, pulse: "none", pulseTitle: review ? "review running" : "no progress reported yet", stage,
    how: { before: "", command: null, after: review ? `Reviewing${head ? ` ${head}` : ""}` : r.waitingOn }, quiet: null, started: null, counts: null,
  };
}

function recordRun(rec: ProgressRecord, stage: string, owner: string, at: Date): TodayRun {
  const now = at.getTime(), quietMs = Math.max(0, now - Date.parse(rec.changedAt));
  const stalled = quietMs >= STALL_MS && rec.childAlive === false;
  const pulse = stalled ? "stalled" : quietMs >= QUIET_MS ? "quiet" : "live";
  const quiet = stalled ? `stalled: no change for ${quietFor(quietMs)}, no child process` : pulse === "quiet" ? `no change for ${quietFor(quietMs)}` : null;
  let how: TodayRun["how"] = { before: "", command: null, after: "no command reported yet" };
  if (rec.telemetry === false) how = { before: "", command: null, after: `${splitActor(rec.actor).harness || "this harness"} sends no commands · changed ${span(quietMs)} ago` };
  else if (rec.current) how = { before: "", command: rec.current.name, after: `running ${span(now - Date.parse(rec.current.since))}` };
  else if (rec.last) how = { before: rec.last.error ? "last, failed:" : "last", command: rec.last.name, after: `${span(now - Date.parse(rec.last.at))} ago` };
  const attempt = rec.attempt ?? rec.runs.length;
  const counts = [rec.commits ? plural(rec.commits, "commit") : "", rec.changedFiles ? plural(rec.changedFiles, "file") : ""].filter(Boolean).join(" · ");
  return {
    actor: rec.actor, model: splitActor(rec.actor).model, company: companyOf(rec.actor, owner), family: vendorOf(rec.actor, owner),
    runner: rec.runner, machine: machineName(rec.runner), runnerName: runnerNameOf(rec.runner),
    attempt: attempt > 1 ? attempt : null, pulse, pulseTitle: quiet ?? `last change ${span(quietMs)} ago`, stage,
    how, quiet, started: span(now - Date.parse(rec.startedAt)), counts: counts || null,
  };
}

export function buildToday(inputs: TodayInputs, at: Date): TodayView {
  const view = { ...buildNow(inputs.projects.map((p) => p.now), at), unread: inputs.unread };
  const today = dayInZone(at, EASTERN);
  const group = (key: string) => view.groups.find((g) => g.key === key)!.rows;
  const holders = new Map(inputs.projects.flatMap((p) => p.now.items.map((i) => [`${p.now.name}/${i.id}`, i.owner ?? null] as const)));
  const familyOf = (row: NowRow) => { const h = holders.get(`${row.project}/${row.id}`); return h ? vendorOf(h, inputs.owner) : "other"; };

  const needs = group("needs-you");
  const live = [...group("running"), ...group("waiting")];
  const landed = group("landed");
  const cards: TodayCard[] = needs.map((r) => {
    const p = inputs.projects.find((x) => x.now.name === r.project);
    const owned = p?.now.owner.find((t) => t.id === r.id);
    const call = owned?.call;
    const bound = p?.heads?.[r.id];
    // Answer takes the place of Unblock unless the block is a fact; Override is offered only where the project allows overrides (attention.ts words the forbidding case).
    const answer = call === "unblock" && bound && !bound.fact ? { head: bound.head ?? "", criteria: bound.criteria } : undefined;
    const override = call === "override" && bound?.head && !/forbids overrides/.test(owned?.why ?? "") ? { head: bound.head, criteria: bound.criteria } : undefined;
    const job = p?.landJobs?.find((j) => j.item === r.id);
    const land = call && LAND_CALLS.has(call) && bound?.head
      ? { head: bound.head, criteria: bound.criteria, ...landStateOf({ head: bound.head, job: job ? { at: job.at, head: job.head ?? null } : null, landing: p?.now.landings[r.id] ?? null }) }
      : undefined;
    return { id: r.id, project: r.project, title: r.title, href: r.href, call: r.waitingOn.replace(/^you: /, ""), why: r.next, family: familyOf(r), age: age(at.getTime() - Date.parse(r.since)), ...(land ? { land } : {}), ...(answer ? { answer } : {}), ...(override ? { override } : {}) };
  });
  const lanes: TodayLane[] = live.map((r) => {
    const run = runOf(r, inputs.projects.find((p) => p.now.name === r.project)!, holders.get(`${r.project}/${r.id}`) ?? null, inputs.owner, at);
    const waited = age(at.getTime() - Date.parse(r.since));
    return {
      id: r.id, project: r.project, title: r.title, href: r.href, family: familyOf(r), holder: holders.get(`${r.project}/${r.id}`) ?? "no builder yet",
      step: stepOf(r.stage), wait: r.group === "waiting", run, elapsed: run.started ?? (r.stuck ? `${waited} · stuck` : waited), stuck: !!r.stuck,
    };
  });
  // Running rows first. Of the waiting rows, a stalled run comes first, then a silent run a machine still reports
  // on, then a task stuck at its stage, then the rest, so the twelve shown are the ones to look at.
  const rank = (l: TodayLane) => (l.run.pulse === "stalled" ? 3 : l.run.pulse !== "none" ? 2 : l.stuck ? 1 : 0);
  lanes.sort((a, b) => Number(a.wait) - Number(b.wait) || (a.wait ? rank(b) - rank(a) : 0));

  // Deploys of the Eastern day, from each project's ship.recorded events.
  const deploys = inputs.projects.flatMap((p) => {
    const carried = carriedIn(p);
    return p.ships.filter((s) => onDay(s.at, today)).map((s) => ({ p, s, merges: carried.get(s.ship) ?? (carried.has(s.ship) ? null : []) }));
  }).sort((a, b) => a.s.at.localeCompare(b.s.at) || a.s.ship.localeCompare(b.s.ship));
  const shipped = deploys.filter((d) => d.s.result === "shipped");
  const latest = deploys.at(-1);
  const latestState = latest && (latest.s.result === "shipped" ? postMergeText(latest.merges, latest.p.postMerge).text : `deploy failed${latest.s.step ? ` at ${latest.s.step}` : ""}`);

  const timeline: TodayEvent[] = [
    ...landed.map((r): TodayEvent => ({
      kind: "merge", at: r.since, time: clockText(r.since), title: `${r.id} ${r.title}`, family: familyOf(r),
      sub: [r.project, holders.get(`${r.project}/${r.id}`), r.reviewer ? `reviewed by ${r.reviewer}` : null, r.findingsFixed ? `${plural(r.findingsFixed, "finding")} fixed` : null].filter(Boolean).join(" · "),
    })),
    ...deploys.map(({ p, s, merges }): TodayEvent => {
      if (s.result !== "shipped") return { kind: "failed", at: s.at, time: clockText(s.at), title: `Deploy of ${p.now.name} failed${s.step ? ` at ${s.step}` : ""}`, sub: s.note ?? "nothing shipped", family: "other" };
      const state = postMergeText(merges, p.postMerge);
      return { kind: "deploy", at: s.at, time: clockText(s.at), title: `Deployed ${p.now.name} at ${s.head.slice(0, 8)}`, sub: `${merges ? `${plural(merges.length, "merge")} shipped` : "merges shipped: not recorded"} · ${state.text}`, family: "other", passed: state.passed };
    }),
  ].sort((a, b) => b.at.localeCompare(a.at));

  const hours = Array.from({ length: 24 }, (_, h) => landed.filter((r) => hourOf(r.since) === h).length);
  const everyRead = inputs.projects.length > 0;
  const left = inputs.unread.length ? `not counting ${inputs.unread.join(", ")}` : "";
  const tile = (value: number, note: string): TodayTile => (everyRead ? { value, note: [note, left].filter(Boolean).join(" · ") } : { value: null, note: "no project was read" });

  const projects: TodayProjectCard[] = inputs.projects.map((p) => {
    const pulse = buildPulse(p.pulseEvents, inputs.owner, at);
    const merges = p.pulseEvents.filter(isMerge).map((ev) => ev.at).sort().at(-1);
    const top = Object.entries(pulse.byVendor).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0]?.[0] ?? "other";
    return {
      name: p.now.name, title: p.now.title, unread: false, need: needs.filter((r) => r.project === p.now.name).length, running: live.filter((r) => r.project === p.now.name).length,
      lastMerge: merges ? `last merge ${age(at.getTime() - Date.parse(merges))} ago` : "no merge in 14 days", days: pulse.days.map((d) => d.moves), family: top,
    };
  }).sort((a, b) => b.need - a.need || b.running - a.running || a.title.localeCompare(b.title));
  for (const name of inputs.unread) projects.push({ name, title: name, unread: true, need: 0, running: 0, lastMerge: "", days: [], family: "other" });

  return {
    at: at.toISOString(), dateText: dateText(at),
    tiles: {
      need: tile(needs.length, ""), running: tile(live.length, `${group("running").length} building or reviewing`),
      merged: tile(view.header.mergesToday, ""),
      deploys: everyRead ? { value: shipped.length, note: [latestState ?? "no deploy yet today", left].filter(Boolean).join(" · ") } : { value: null, note: "no project was read" },
    },
    dots: { need: cards.map(() => "owner"), running: lanes.map((l) => l.family) },
    hours, ships: deploys.map((d) => ({ shipped: d.s.result === "shipped" })),
    cards, lanes: lanes.slice(0, LANES_SHOWN), lanesMore: Math.max(0, lanes.length - LANES_SHOWN), timeline, projects, unread: inputs.unread, now: view,
  };
}

// ── the page ───────────────────────────────────────────────────────────────

const fig = (t: TodayTile) => (t.value === null ? "not read" : String(t.value));
const dots = (families: string[]) => `<div class="today-dots">${families.slice(0, DOTS_SHOWN).map((f) => `<i style="--fam:var(--m-${e(f)})"></i>`).join("")}</div>`;
const chip = (text: string, kind = "") => `<span class="today-chip${kind ? ` ${kind}` : ""}">${e(text)}</span>`;
const famDot = (f: string) => `<span class="today-fam" style="--fam:var(--m-${e(f)})"></span>`;

function tiles(v: TodayView): string {
  const one = (name: string, label: string, href: string, t: TodayTile, extra: string, cls = "") =>
    `<a class="today-tile${cls ? ` ${cls}` : ""}" data-tile="${name}" href="${href}"><span class="n">${fig(t)}</span><span class="l">${label}</span>${extra}${t.note ? `<span class="today-note">${e(t.note)}</span>` : ""}</a>`;
  const max = Math.max(1, ...v.hours);
  const bars = `<div class="today-spark" aria-hidden="true">${v.hours.map((n) => `<i style="--h:${Math.round((n / max) * 100)}%"${n ? "" : ' class="none"'}></i>`).join("")}</div>`;
  const ships = `<div class="today-ships" aria-hidden="true">${v.ships.slice(0, 12).map((s) => `<i class="${s.shipped ? "" : "bad"}"></i>`).join("")}</div>`;
  return `<div class="today-tiles">${one("need", "Need you", "#needs-you", v.tiles.need, dots(v.dots.need), "you")}${one("running", "Running now", "#running", v.tiles.running, dots(v.dots.running))}${one("merged", "Merged today", "#merged", v.tiles.merged, bars)}${one("deploys", "Deploys today", "#merged", v.tiles.deploys, ships)}</div>`;
}

function headline(v: TodayView): string {
  const need = v.tiles.need.value, run = v.tiles.running.value;
  if (need === null || run === null) return `<h1>Nothing could be read.</h1>`;
  const first = need ? `<em>${plural(need, "thing")}</em> ${need === 1 ? "waits" : "wait"} for you.` : `<em>Nothing</em> needs you.`;
  return `<h1>${first}<br>${run ? `${plural(run, "task")} ${run === 1 ? "is" : "are"} running.` : "No task is in motion."}</h1>`;
}

const section = (id: string, title: string, count: string, body: string, more = "") =>
  `<section id="${id}" aria-labelledby="${id}-h"><div class="today-sh"><h2 id="${id}-h">${title}</h2><span class="today-c">${e(count)}</span>${more}</div>${body}</section>`;

function cardHtml(c: TodayCard, act: TodayAct | undefined): string {
  const land = c.land ? `<div class="today-land">${landBlock({ project: c.project, id: c.id, head: c.land.head, criteria: c.land.criteria, back: "today", act: act ?? null, queuedAt: c.land.queuedAt, failedStep: c.land.failedStep, movedFrom: c.land.movedFrom })}</div>` : "";
  const answer = c.answer && act ? `<div class="today-answer">${answerBlock({ project: c.project, id: c.id, ...c.answer, back: "today", act })}</div>` : "";
  const override = c.override && act ? `<div class="today-answer">${overrideBlock({ project: c.project, id: c.id, ...c.override, act })}</div>` : "";
  return `<div class="today-ask"><div class="today-t"><a class="today-title" href="${e(c.href)}">${e(c.title)}</a></div><div class="today-meta"><span class="mono">${e(c.project)} · ${e(c.id)}</span>${chip(c.call, "you")}<span>${famDot(c.family)}waiting ${e(c.age)}</span></div><div class="today-why">${e(c.why)}</div>${land}${answer}${override}<a class="today-open" href="${e(c.href)}" aria-label="Open ${e(c.id)}">Open →</a></div>`;
}

// The machine glyphs of the chosen mockup (docs/design/today-running/a-running.html), by display name.
const MACHINE_GLYPH: Record<string, string> = {
  "Mac Studio": '<rect x="2.5" y="4" width="11" height="8" rx="2"/><path d="M5 9.5h1.5"/>',
  "Mac mini": '<rect x="1.5" y="6.5" width="13" height="4.5" rx="1.6"/><path d="M4 9h1"/>',
  "MacBook Pro": '<rect x="3" y="3.5" width="10" height="7" rx="1"/><path d="M1.5 12.5h13"/>',
};
const glyph = (machine: string) => MACHINE_GLYPH[machine] ? `<span class="today-mg"><svg viewBox="0 0 16 16" aria-hidden="true">${MACHINE_GLYPH[machine]}</svg></span>` : "";
const sep = `<span class="today-sep"></span>`;

function laneHtml(l: TodayLane): string {
  const { run } = l;
  const cells = TRACK.map((_, i) => `<i class="${i < l.step ? "done" : i === l.step ? (l.wait ? "wait" : "now") : ""}"></i>`).join("");
  const where = run.runner ? `<span class="today-where" title="${e(run.runner)}">${glyph(run.machine!)}${e(run.machine!)}${run.runnerName ? `<span class="today-rn">${e(run.runnerName)}</span>` : ""}</span>` : "";
  const who = run.model ? `<span class="today-who">${famDot(run.family)}${e(run.model)}</span>` : `<span class="today-who">${e(l.holder)}</span>`;
  const meta = [`<span class="mono">${e(l.project)} · ${e(l.id)}</span>`, where, who, run.attempt ? `<span class="today-att">attempt ${run.attempt}</span>` : ""].filter(Boolean).join(sep);
  const how = `${run.how.before ? `${e(run.how.before)} ` : ""}${run.how.command ? `<b>${e(run.how.command)}</b> ` : ""}${e(run.how.after)}`;
  const counts = (cls: string) => run.counts ? `<span class="${cls}">${e(run.counts)}</span>` : "";
  const attrs = `data-task="${e(l.id)}" data-project="${e(l.project)}" data-pulse="${run.pulse}" data-company="${run.company}"${run.runner ? ` data-runner="${e(run.runner)}"` : ""}`;
  return `<div class="today-lane co-${run.company}${l.stuck ? " stuck" : ""}${run.pulse === "quiet" || run.pulse === "stalled" ? " quiet" : ""}" ${attrs}><span class="today-pulse ${run.pulse}" title="${e(run.pulseTitle)}"></span>`
    + `<div><div class="today-t"><a class="today-title" href="${e(l.href)}">${e(l.title)}</a></div><div class="today-sub">${meta}</div></div>`
    + `<div class="today-trk"><div class="today-track" aria-hidden="true">${cells}</div><div class="today-st"><span class="today-stg">${e(run.stage)}</span><span class="today-how">${how}</span>${run.quiet ? `<span class="today-quiet">${e(run.quiet)}</span>` : ""}${counts("today-cnt2")}</div></div>`
    + `<div class="today-el"><span class="today-big">${e(l.elapsed)}</span>${counts("today-cnt")}</div></div>`;
}

function eventHtml(ev: TodayEvent): string {
  return `<div class="today-ev ${ev.kind}" style="--fam:var(--m-${e(ev.family)})"><span class="today-tm">${e(ev.time)}</span><div><div class="today-t">${e(ev.title)}</div><div class="today-sub">${e(ev.sub)}</div></div></div>`;
}

function projectHtml(p: TodayProjectCard): string {
  if (p.unread) return `<div class="today-proj unread"><h3>${e(p.title)}</h3><div class="today-k">not read</div></div>`;
  const max = Math.max(1, ...p.days);
  const k = [p.need ? `${p.need} ${p.need === 1 ? "needs" : "need"} you` : "", p.running ? `${p.running} running` : "", p.lastMerge].filter(Boolean).join(" · ");
  return `<a class="today-proj" href="/p/${encodeURIComponent(p.name)}" style="--fam:var(--m-${e(p.family)})"><h3>${e(p.title)}</h3><div class="today-k">${e(k)}</div><div class="today-bars" aria-hidden="true">${p.days.map((n) => `<i style="--h:${Math.round((n / max) * 100)}%"${n ? "" : ' class="none"'}></i>`).join("")}</div></a>`;
}

export function todayBody(v: TodayView, act?: TodayAct): string {
  const blind = v.projects.every((p) => p.unread);
  const empty = (line: string) => `<p class="today-empty">${blind ? "Not read." : line}</p>`;
  const merges = v.timeline.filter((ev) => ev.kind === "merge").length, ships = v.ships.filter((s) => s.shipped).length;
  const unread = v.unread.length ? `<p class="today-unread" role="alert">Not read: ${e(v.unread.join(", "))}. Their figures are not in the totals below.</p>` : "";
  const running = v.lanes.length ? `<div class="today-runlist">${v.lanes.map(laneHtml).join("")}</div>` + (v.lanesMore ? `<p class="meta">and ${v.lanesMore} more · <a href="/flow">Flow</a></p>` : "") : empty("No task is running.");
  return `<div class="today"><div class="today-date">${e(v.dateText)}</div>${headline(v)}${unread}${tiles(v)}`
    + section("needs-you", "Needs you", String(v.cards.length), v.cards.length ? v.cards.map((c) => cardHtml(c, act)).join("") : empty("Nothing waits for you."))
    + section("running", "Running", String(v.tiles.running.value ?? 0), running, `<a href="/flow">Flow →</a>`)
    + section("merged", "Merged and deployed today", `${merges} · ${plural(ships, "deploy")}`, v.timeline.length ? `<div class="today-landed">${v.timeline.map(eventHtml).join("")}</div>` : empty("Nothing has merged or deployed today."), `<a href="/history">History →</a>`)
    + section("projects", "Projects", `${v.projects.length}`, v.projects.length ? `<div class="today-projects">${v.projects.map(projectHtml).join("")}</div>` : `<p class="today-empty">No project is registered.</p>`)
    + `<p class="meta today-zone">Times are Eastern.</p></div>`;
}

// The Land forms are drawn only when the entry's page-action guard lets the request act (src/page-actions.ts).
export type TodayAct = { newId: () => string; nonce?: string };

// Today follows the device's colour scheme, as Now does. The page draws no
// form or button but Land, so it is drawn without the owner menu's sign-out form
// (page's signedIn = false).
export function renderToday(v: TodayView, ownerName: string | null = null, live?: Live, act?: TodayAct): string {
  return page("Today", todayBody(v, act), "Today", ownerName, 0, false, live, { css: todayCss });
}
