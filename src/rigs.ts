// Rigs (t608; PAVI chose "A, signal box" on 2026-11-09, docs/design/rigs/mockup/a-yard.html): one page at
// /rigs that shows each machine a runner polls from as a yard. A yard has a rig head (the machine's load,
// memory and test slots, from the readings runners send with each poll, src/runners/machine.ts) and one
// track per live runner: a lamp, a rail of the five stages Today draws (TRACK in src/today.ts), a chip for
// each model the runner offers and, for a runner with a current job, a train at the task's stage. A task
// dispatched to a model no live runner offers waits at a red signal below the yards, with the reason
// `atelier status` gives it.
//
// buildRigs is pure, like buildToday: it reads the same inputs Today reads and the live offers, so a task of
// a project Today could not read is not drawn, and the page and the tests see one model. renderRigs draws it
// in full without script; live.js (src/live.ts) refetches the page every RIGS_REFRESH seconds.
import { describe, liveOffers, unclaimed, waitingDispatch, type SeenOffer } from "./dispatch/rules.ts";
import { isPrivateProject } from "./dispatch/private.ts";
import { vendorOf } from "./graph.ts";
import { buildNow, EASTERN } from "./now.ts";
import { hostOf, MACHINE_NAMES } from "./runner-names.ts";
import { machineReadings, type HostReading, type MachineReading } from "./runners/machine.ts";
import { age, todayLanes, TRACK, type TodayInputs, type TodayLane } from "./today.ts";
import { escapeText as e, page, type Live } from "./ui";
import rigsCss from "./rigs.css";

// How often live.js refetches the page (data-live-refresh).
export const RIGS_REFRESH = 10;
// The project whose runners fill the yards; the others' runners stand under "Project sidings".
export const HOME_PROJECT = "atelier";
// The 1-minute load over cores at which the dial turns to caution and to fault.
export const DIAL_CAUTION = 0.6;
export const DIAL_FAULT = 0.9;

type Offer = SeenOffer & { machine?: MachineReading };

export interface RigTrain {
  id: string; title: string; project: string; model: string; actor: string; family: string;
  // The stage the task stands at (one of TRACK) and its place along the rail, 0 to 1.
  stage: string; step: number; at: number;
  job: string; onTrack: string; attempt: number;
  // A task of a private project is drawn without its id, title or model.
  hidden: boolean;
  href: string;
}
export interface RigModel { actor: string; model: string; family: string; working: boolean }
export interface RigTrack {
  runner: string; name: string; busy: boolean; projects: string[]; siding: boolean;
  models: RigModel[]; trains: RigTrain[];
}
export interface RigHead {
  // "none": no usable reading, so no dial and the words "no reading".
  dial: "ok" | "warm" | "hot" | "none";
  host: string; cores: number; load1: number; load15: number; ratio: number;
  memUsed: number; slots: { capacity: number; inUse: number } | null;
}
export interface RigYard { key: string; title: string; head: RigHead | null; tracks: RigTrack[] }
export interface RigSignal { id: string; title: string; project: string; asks: string; queued: string; reason: string; hidden: boolean }
export interface RigsView {
  at: string;
  dateText: string;
  yards: RigYard[];
  busy: number;
  total: number;
  signals: RigSignal[];
  // The runner offers could not be read: no yard is drawn, and the page says so rather than say none is live.
  unreadOffers: boolean;
}

// The machine a runner runs on, from its name: "studio" in "home:studio-atelier-build". A runner with no host
// part (cloud:atelier) is a machine of its own.
export function yardOf(runner: string): { key: string; title: string; rank: number; track: string } {
  const host = hostOf(runner);
  if (!host) return { key: runner.toLowerCase(), title: runner, rank: 99, track: runner };
  const known = Object.hasOwn(MACHINE_NAMES, host);
  return { key: host, title: known ? MACHINE_NAMES[host] : host, rank: known ? Object.keys(MACHINE_NAMES).indexOf(host) : 99, track: runner.replace(/^home:[a-z0-9]+-/i, "") };
}

const lower = (s: string) => s.toLowerCase();

function headOf(r: HostReading | undefined): RigHead | null {
  if (!r || r.stale) return { dial: "none", host: r?.host ?? "", cores: 0, load1: 0, load15: 0, ratio: 0, memUsed: 0, slots: null };
  const ratio = r.loadavg[0] / r.cpus;
  return {
    dial: ratio > DIAL_FAULT ? "hot" : ratio > DIAL_CAUTION ? "warm" : "ok",
    host: r.host, cores: r.cpus, load1: r.loadavg[0], load15: r.loadavg[2], ratio,
    memUsed: Math.round(100 - r.memFreePercent), slots: r.testSlots,
  };
}

// A train for each of the runner's current tasks, from the lanes Today draws for the project (the same
// progress records and stages), keyed by the runner they name.
function trainsOf(inputs: TodayInputs, at: Date): Map<string, RigTrain[]> {
  const by = new Map<string, RigTrain[]>();
  for (const p of inputs.projects) {
    const dispatches = new Map(p.now.items.map((i) => [i.id, i.dispatch?.job ?? null] as const));
    const items = new Map(p.now.items.map((i) => [i.id, i] as const));
    for (const l of todayLanes(buildNow([p.now], at), { projects: [p], unread: [], owner: inputs.owner }, at) as TodayLane[]) {
      // A claimed build with no unfinished progress record yet (the runner claims before it prepares its workspace
      // and reports progress) stands at Claim, on the runner its claim records.
      const item = items.get(l.id), early = !l.run.runner && l.run.stage === "Branch" && item?.state === "claimed" && !!item.runner;
      const runner = early ? item!.runner : l.run.runner;
      // A task Today calls waiting still holds its runner while its progress record is unfinished (a pulse other than none).
      if (!runner || (!early && l.wait && l.run.pulse === "none")) continue;
      const step = early ? 0 : Math.max(0, TRACK.indexOf(l.run.stage as (typeof TRACK)[number]));
      const hidden = isPrivateProject(l.project);
      const actor = l.run.actor ?? l.holder;
      const train: RigTrain = {
        id: l.id, title: l.title, project: l.project, model: l.run.model ?? actor, actor, family: l.family,
        stage: TRACK[step], step, at: 0.1 + 0.2 * step + 0.01,
        job: dispatches.get(l.id) ?? (step === 3 ? "review" : "build"), onTrack: early ? "" : l.elapsed, attempt: early ? 0 : l.run.attempt ?? 1,
        hidden, href: l.href,
      };
      by.set(lower(runner), [...(by.get(lower(runner)) ?? []), train]);
    }
  }
  return by;
}

// Tasks dispatched to a model (or job) no live runner offers, each with the reason `atelier status` gives.
function signalsOf(inputs: TodayInputs, offers: readonly SeenOffer[], at: Date): RigSignal[] {
  const out: RigSignal[] = [];
  for (const p of inputs.projects) {
    for (const item of p.now.items) {
      const d = waitingDispatch(item);
      if (!d) continue;
      const why = unclaimed(item, { offers, project: p.now.name, now: at }).find((r) => r.kind === "unoffered");
      if (why) out.push({ id: item.id, title: item.title, project: p.now.name, asks: describe(d), queued: age(at.getTime() - Date.parse(d.at)), reason: why.line, hidden: isPrivateProject(p.now.name) });
    }
  }
  return out.sort((a, b) => a.project.localeCompare(b.project) || a.id.localeCompare(b.id, "en", { numeric: true }));
}

export function buildRigs(inputs: TodayInputs, offers: readonly Offer[] | null, at: Date): RigsView {
  const stamp = new Intl.DateTimeFormat("en-US", { timeZone: EASTERN, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).formatToParts(at);
  const part = (t: string) => stamp.find((x) => x.type === t)?.value ?? "";
  const view: RigsView = { at: at.toISOString(), dateText: `${part("weekday")} ${part("day")} ${part("month")} · ${part("hour")}:${part("minute")} ${part("timeZoneName")}`, yards: [], busy: 0, total: 0, signals: [], unreadOffers: offers === null };
  if (!offers) return view;
  const live = liveOffers(offers, at) as Offer[];
  const trains = trainsOf(inputs, at);
  const readings = new Map<string, HostReading>();
  for (const r of machineReadings(offers, at.getTime())) {
    const key = yardOf(r.runner).key, held = readings.get(key);
    if (!held || r.at > held.at) readings.set(key, r);
  }
  const yards = new Map<string, RigYard & { rank: number }>();
  for (const o of live) {
    const y = yardOf(o.runner);
    const yard = yards.get(y.key) ?? { key: y.key, title: y.title, rank: y.rank, head: headOf(readings.get(y.key)), tracks: [] };
    yards.set(y.key, yard);
    const mine = trains.get(lower(o.runner)) ?? [];
    // A private task's model stays unmarked, as its train is drawn without it.
    const working = new Set(mine.filter((t) => !t.hidden).map((t) => lower(t.actor)));
    const seen = new Set<string>();
    const models = o.agents.flatMap(({ agent, models }) => models.map((m) => ({ actor: `${agent}/${m}`, model: m })))
      .filter(({ actor }) => !seen.has(lower(actor)) && !!seen.add(lower(actor)))
      .map(({ actor, model }) => ({ actor, model, family: vendorOf(actor, inputs.owner), working: working.has(lower(actor)) }));
    const projects = (o.projects ?? []).filter((p) => p !== HOME_PROJECT);
    yard.tracks.push({ runner: o.runner, name: y.track, busy: mine.length > 0, projects, siding: !!o.projects && !o.projects.includes(HOME_PROJECT), models, trains: mine });
  }
  view.yards = [...yards.values()].sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key)).map(({ rank: _rank, ...y }) => ({
    ...y, tracks: y.tracks.sort((a, b) => Number(a.siding) - Number(b.siding) || a.name.localeCompare(b.name)),
  }));
  const tracks = view.yards.flatMap((y) => y.tracks);
  view.total = tracks.length;
  view.busy = tracks.filter((t) => t.busy).length;
  view.signals = signalsOf(inputs, live, at);
  return view;
}

// ── the page ───────────────────────────────────────────────────────────────

const num = (n: number) => (Math.round(n * 10) / 10).toString();
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The 15-minute load in words, against the machine's cores.
function loadWords(h: RigHead): string {
  const r = h.load15 / h.cores;
  return `over 15 minutes the load averaged ${num(h.load15)} on ${plural(h.cores, "core")}, ${r > DIAL_FAULT ? "overloaded" : r > DIAL_CAUTION ? "busy" : "light"}`;
}

// A half-circle dial: the arc from the left to the point the ratio reaches, and the needle to the same point.
function dial(h: RigHead): string {
  const p = Math.min(1, Math.max(0, h.ratio)), a = Math.PI * (1 - p);
  const pt = (r: number) => `${(46 + r * Math.cos(a)).toFixed(1)} ${(46 - r * Math.sin(a)).toFixed(1)}`;
  const label = `load ${num(h.load1)} on ${plural(h.cores, "core")}`;
  return `<svg class="gauge ${h.dial === "ok" ? "" : h.dial}" data-dial="${h.dial}" viewBox="0 0 92 54" width="92" role="img" aria-label="${e(label)}"><path d="M8 46 A38 38 0 0 1 84 46" class="g-bg"/>`
    + (p > 0 ? `<path d="M8 46 A38 38 0 0 1 ${pt(38)}" class="g-on"/>` : "")
    + `<line x1="46" y1="46" x2="${pt(28).split(" ")[0]}" y2="${pt(28).split(" ")[1]}" class="needle"/><circle cx="46" cy="46" r="3.5" class="hub"/></svg>`;
}

function headHtml(h: RigHead | null): string {
  if (!h || h.dial === "none") {
    return `<div class="meters" data-reading="none"><div class="m"><div class="mv">no reading</div><div class="ml">${h?.host ? `${e(h.host)} has not reported lately` : "no runner here has reported the machine's load"}</div></div></div>`;
  }
  const slots = h.slots
    ? `<div class="plats" aria-hidden="true">${Array.from({ length: h.slots.capacity }, (_, i) => `<i${i < h.slots!.inUse ? ' class="on"' : ""}></i>`).join("")}</div><div class="ml">test slots ${h.slots.inUse} of ${h.slots.capacity}</div>`
    : `<div class="plats"><span class="dim">—</span></div><div class="ml">no test pool on this machine</div>`;
  return dial(h) + `<div class="meters" data-reading="ok">`
    + `<div class="m"><div class="mv">${num(h.load1)}<span>/ ${h.cores}</span></div><div class="ml">load, 1 min · ${e(loadWords(h))}</div></div>`
    + `<div class="m"><div class="bar2" role="img" aria-label="memory ${h.memUsed}% used"><i style="width:${h.memUsed}%"></i></div><div class="ml">memory ${h.memUsed}% used</div></div>`
    + `<div class="m">${slots}</div></div>`;
}

// One rail for each train, so two tasks of a runner at the same stage do not stand on each other; a track with no train has one bare rail.
function railHtml(t: RigTrack): string {
  const one = (x?: RigTrain) => {
    const stations = TRACK.map((s, i) => `<span class="st${x && x.step > i ? " pass" : ""}${x && x.step === i ? " here" : ""}" style="--i:${i}"><em>${s}</em></span>`).join("");
    const car = !x ? "" : x.hidden ? `<span class="car">private task</span>` : `<span class="car"><b>${e(x.id)}</b> ${e(x.model)}</span>`;
    const train = !x ? "" : `<div class="train${x.hidden ? " private" : ""}" data-task="${x.hidden ? "" : e(x.id)}" data-project="${e(x.project)}" data-stage="${x.stage}" style="--fam:var(--m-${e(x.family)});--at:${x.at.toFixed(3)}">${car}</div>`;
    return `<div class="rail">${stations}${train}</div>`;
  };
  return `<div class="rails">${t.trains.length ? t.trains.map(one).join("") : one()}</div>`;
}

function underHtml(x: RigTrain): string {
  if (x.hidden) return `<div class="under dim">${e(x.project)} · private project, details hidden</div>`;
  return `<div class="under"><span class="tt"><a href="${e(x.href)}">${e(x.title)}</a></span><span class="mono dim"><span class="proj">${e(x.project)}</span> ${e(x.job)} · ${e(x.stage)} · ${x.attempt ? `${e(x.onTrack)} on track · attempt ${x.attempt}` : "no progress reported yet"}</span></div>`;
}

function trackHtml(t: RigTrack): string {
  const chips = t.models.map((m) => `<span class="liv${m.working ? " on" : ""}" style="--fam:var(--m-${e(m.family)})" title="${e(m.actor)}"><i></i>${e(m.model)}</span>`).join("");
  const tags = t.projects.map((p) => `<span class="proj${isPrivateProject(p) ? " priv" : ""}">${e(p)}</span>`).join("");
  return `<div class="ytrack ${t.busy ? "has" : "free"}" data-runner="${e(t.runner)}" data-lamp="${t.busy ? "busy" : "clear"}">`
    + `<div class="yname"><span class="lamp ${t.busy ? "busy" : "clear"}" role="img" aria-label="${t.busy ? "busy" : "clear"}"></span><span class="mono" title="${e(t.runner)}">${e(t.name)}</span>${tags}</div>`
    + railHtml(t) + `<div class="ylivs">${chips || '<span class="dim">offers no model</span>'}</div>${t.trains.length ? `<div class="unders">${t.trains.map(underHtml).join("")}</div>` : ""}</div>`;
}

function yardHtml(y: RigYard): string {
  const home = y.tracks.filter((t) => !t.siding), sidings = y.tracks.filter((t) => t.siding);
  const side = sidings.length ? `<details class="sidings" open><summary>Project sidings</summary>${sidings.map(trackHtml).join("")}</details>` : "";
  return `<section class="yard" data-yard="${e(y.key)}"><div class="yhead"><div><h2>${e(y.title)}</h2><div class="mono dim">${e(y.head?.host || y.key)} · ${plural(y.tracks.length, "track")}</div></div>${headHtml(y.head)}</div>`
    + home.map(trackHtml).join("") + side + `</section>`;
}

function signalHtml(s: RigSignal): string {
  const who = s.hidden ? `<b class="mono">private task</b>` : `<b class="mono">${e(s.id)}</b>`;
  const what = s.hidden ? `${e(s.project)} · private project, details hidden` : `${e(s.title)} · asks ${e(s.asks)} · queued ${e(s.queued)} · ${e(s.project)}`;
  return `<section class="signal-wait" data-task="${s.hidden ? "" : e(s.id)}" data-project="${e(s.project)}"><div class="sig" aria-hidden="true"><i></i><i class="red"></i></div><div><div class="tt">${who} waits at the signal</div>`
    + `<div class="dim">${what}</div>${s.hidden ? "" : `<div class="why">${e(s.reason)}</div>`}</div></section>`;
}

export function rigsBody(v: RigsView): string {
  const lede = `<p class="lede">Each rig is a yard; each track runs Claim to Land. A train is the task on that track, in its model's livery, standing at its stage.</p>`;
  const head = `<div class="date">${e(v.dateText)}</div><h1>Rigs <em>${v.busy} of ${v.total}</em> tracks busy</h1>`;
  const body = v.unreadOffers ? `<p class="empty">The runners' offers could not be read, so no rig is drawn. Refresh to try again.</p>`
    : v.yards.length ? v.yards.map(yardHtml).join("") : `<p class="empty">No runner is live.</p>`;
  return `<div class="rigs">${head}${lede}${body}${v.signals.map(signalHtml).join("")}</div>`;
}

export function renderRigs(v: RigsView, ownerName: string | null, live: Live): string {
  return page("Rigs", rigsBody(v), "Rigs", ownerName, 0, false, live, { css: rigsCss });
}
