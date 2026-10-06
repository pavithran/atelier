import { sessionNoteText, type SessionNote } from "./sessions.ts";
// Server-rendered pages. Every action is a plain form post and every page
// reads fully without script; the Studio refreshes itself with a meta
// refresh. A page given a `Live` nonce also carries Atelier's own script,
// which refreshes and animates it and nothing more (src/live.ts).
// Colours, type, spacing and radii come from the portfolio theme (theme.css);
// layout.css only arranges them.

import { TEXT_CONTROLS } from "./text.ts";
import { appliesText, checkClasses, classText, type CheckClass } from "./checks.ts";
import theme from "./theme.css";
import layout from "./layout.css";
import type { ProjectRecord, LedgerEvent } from "./ledger";
import type { FileChange, ItemDiff } from "./diff";
import { ago, position, splitActor, staggers, type Bench, type Floor, type MarkKind } from "./floor";
import { briefFor, submission, type Verdict } from "./brief";
import { describe as describeDispatch } from "./dispatch/rules";
import { drawImported, laneColour } from "./import/draw";
import { NO_AGENT, type ImportedHistory } from "./import/history";
import { HARNESSES, PROVIDERS, type ModelEntry } from "./models/pool";
import type { ModelRecord } from "./models/record";
import { reliabilityLine, roundsPerMerge, type Cause, type ModelReliability, type Reliability } from "./models/reliability.ts";
import { clockTime, dayOf, shortStamp, stamp, weekdayOf, zoneLabel } from "./time";
import type { MainPreview } from "./preview/merge";
import { addTally, buildStory, drawStory, emptyTally, isLocalRun, vendorOf as vendorFor, VENDOR_NAMES, type Story, type Tally, type Vendor } from "./graph";
import { buildPulse, buildTimeline, byDay, PULSE_DAYS, type Pulse } from "./pulse";

// A page that carries the live script (src/live.ts): the request's nonce,
// which the script tag and the policy both name, and how often the page
// refreshes itself, in seconds, or nothing for the scrubber alone.
export interface Live { nonce: string; refresh?: number }
import {
  DEFAULT_OWNER, decisionFor, evidenceAt, latestReviews, mergedChecksAt, OVERRIDE_REASON_MAX, overrideAt, REASON_MAX, stateLabel, modelOf, modelKey,
  type Evidence, type Gate, type InboxEntry, type Item, type MergedCheckView, type ProjectPolicy, type Review,
} from "./rules";

// What a page calls a project: its title when it has one, else its name. Links,
// forms and commands always use the name.
export const titleOf = (p: { name: string; title?: string }) => p.title || p.name;
// A project's display title as stored: one line of plain text, at most 80
// characters, or nothing. No control or zero-width character survives: C0 and
// C1 controls, U+00AD, U+061C, all Bidi_Control characters and all
// Default_Ignorable_Code_Point characters are replaced with a space.
export function cleanTitle(v: unknown): string | undefined {
  const s = String(v ?? "").replace(TEXT_CONTROLS, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return s || undefined;
}
const titleMap = (ps: ProjectRecord[]) => new Map(ps.map((p) => [p.name, titleOf(p)]));

export function escapeText(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
const e = escapeText;
const short = (sha: string | null) => (sha ? sha.slice(0, 8) : "—");
const when = (iso: string | null) => (iso ? stamp(iso) : "—");
const clock = (iso: string) => clockTime(iso);
const href = (...p: string[]) => "/" + p.map(encodeURIComponent).join("/");
const selectedHref = (project: string, task: string) =>
  `/decisions?project=${encodeURIComponent(project)}&task=${encodeURIComponent(task)}#review`;
const tag = (label: string, tone = "") => `<span class="tag ${tone}">${e(label)}</span>`;

const ICONS: Record<string, string> = {
  decisions: '<path d="M7 3h8l4 4v14H5V3h2Zm7 0v5h5M9 12h6m-6 4h6"/>',
  studio: '<path d="M3 20h18M5 20V9l7-5 7 5v11M9 20v-6h6v6"/>',
  projects: '<path d="M3 6h7l2 3h9v11H3V6Z"/>',
  history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/>',
  models: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><path d="M16.5 13v7M13 16.5h7"/>',
  usage: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="m12 17 4-6"/><circle cx="12" cy="17" r="1.2"/>',
  flow: '<path d="M3 6h18"/><path d="M6 6c3 0 2 6 5 6h7c3 0 2-6 5-6M6 6c3 0 2 12 5 12h4"/>',
  arrow: '<path d="m9 6 6 6-6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.1 11.5 3.3 3.3 0 0 0 7 18Z"/>',
  laptop: '<path d="M4 6h16v10H4zM2 19h20"/>',
};
const icon = (name: string) =>
  `<svg aria-hidden="true" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ""}</svg>`;

const NAV: [string, string, string][] = [
  ["Decisions", "/decisions", "decisions"],
  ["Flow", "/flow", "flow"],
  ["Studio", "/studio", "studio"],
  ["Models", "/models", "models"],
  ["Usage", "/usage", "usage"],
  ["Projects", "/projects", "projects"],
  ["History", "/history", "history"],
];

const FONTS = "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700;12..96,800&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&family=IBM+Plex+Mono:wght@400;500&display=swap";

// `signedIn` draws the sign-out form in the rail; the sign-in page has none.
// `live` adds the script under its nonce; with a refresh, <main> says how
// often, and a note the script reveals says when this copy was drawn.
export function page(title: string, body: string, active = "Decisions", ownerName: string | null = null, refreshSeconds = 0, signedIn = true, live?: Live): string {
  const nav = NAV.map(([label, url, glyph]) =>
    `<a href="${url}"${label === active ? ' aria-current="page"' : ""}>${icon(glyph)}<span>${label}</span></a>`).join("");
  const liveAttr = live?.refresh ? ` data-live-refresh="${live.refresh}"` : "";
  const liveNote = live?.refresh
    ? `<p class="meta live-note" hidden><span class="pulse" aria-hidden="true"></span>Live: this copy is from ${e(clock(new Date().toISOString()))}; it refreshes every ${live.refresh} seconds.</p>`
    : "";
  const script = live ? `\n<script nonce="${e(live.nonce)}" src="/live.js" defer></script>` : "";
  return `<!doctype html><html lang="en" data-theme="night"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">${refreshSeconds ? `\n<meta http-equiv="refresh" content="${refreshSeconds}">` : ""}
<title>${e(title)} · Atelier</title><style>${theme}\n${layout}</style></head><body>
<a class="skip" href="#main">Skip to content</a>
<aside class="rail">
  <a class="brand" href="/">Atelier</a>
  <nav aria-label="Main navigation">${nav}</nav>
  <div class="rail-foot"><span class="avatar">${e((ownerName || "P").slice(0, 1))}</span><strong>${e(ownerName || "Project owner")}</strong>
  <p>Many agents, one owner per task.<br>Decisions with evidence.</p>${signedIn ? `
  <form method="post" action="/logout" class="signout"><button type="submit" class="quiet">Sign out</button></form>` : ""}</div>
</aside>
<main id="main"${liveAttr}>${liveNote}${body}</main>${script}</body></html>`;
}

// The shell of the pages anyone can read: no rail, and no link into a signed-in
// page. `main` is the inner HTML of <main>; `css` is appended after the site's.
export function publicPage(o: { title: string; description: string; brand: string; nav: [label: string, url: string][]; mainClass: string; main: string; css?: string }): string {
  const nav = o.nav.map(([label, url]) => `<a href="${url}">${e(label)}</a>`).join("");
  return `<!doctype html><html lang="en" data-theme="night"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="description" content="${e(o.description)}">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<title>${e(o.title)}</title><style>${theme}\n${layout}${o.css ? `\n${o.css}` : ""}</style></head><body class="public">
<header class="public-bar"><a class="brand" href="${o.brand}">Atelier</a><nav aria-label="Elsewhere">${nav}</nav></header>
<main id="main" class="${o.mainClass}">${o.main}</main></body></html>`;
}

export interface Detail {
  ownerActor?: string;
  item: Item;
  policy: ProjectPolicy;
  evidence: Evidence[];
  reviews: Review[];
  gate: Gate;
  events: LedgerEvent[];
}
export interface ReviewContext { project: ProjectRecord; detail: Detail; diff: ItemDiff | "unavailable" | null; thread?: boolean }
// `events` is the project's recent record, newest first, when the page reads
// it (Projects and History); `cut` says it was read up to a limit.
export interface ProjectView { project: ProjectRecord; items: Item[]; unavailable?: boolean; events?: LedgerEvent[]; cut?: boolean }

const KIND: Record<InboxEntry["kind"], [string, string]> = {
  accept: ["Ready to accept", "go"],
  merge: ["Ready to merge", "go"],
  assess: ["Review required", "ask"],
  blocked: ["Blocked", "ask"],
  scope: ["Scope changed", "ask"],
  stale: ["Needs a handoff", "ask"],
  overlap: ["Overlapping work", "ask"],
  failing: ["Checks failed", "bad"],
  "approve-plan": ["Plan to approve", "ask"],
  "plan-blocked": ["Plan blocked", "bad"],
};

// ── where evidence came from ───────────────────────────────────────────────
// The distinction between a check Atelier ran in a Cloudflare container and one
// an agent's own machine ran is the point of graded evidence, so every summary
// that says "passed" also says where.

const WHERE: Record<"sandbox" | "runner", [string, string]> = {
  sandbox: ["in a Cloudflare container", "cloud"],
  runner: ["on the agent's machine", "laptop"],
};

function whereChip(where: "sandbox" | "runner" | undefined): string {
  const [label, glyph] = WHERE[where ?? "runner"];
  return `<span class="where ${where === "sandbox" ? "cloud" : "local"}">${icon(glyph)}${e(where === "sandbox" ? "Cloudflare" : "Agent's machine")}<span class="visually-hidden"> (${e(label)})</span></span>`;
}

function trustLine(checks: { grade: string; passed: boolean | null; where?: "sandbox" | "runner" }[]): string {
  if (!checks.length || !checks.every((c) => c.grade === "observed" && c.passed)) return "";
  const places = new Set(checks.map((c) => c.where ?? "runner"));
  const where = places.size > 1 ? "partly in a Cloudflare container, partly on the agent's machine" : WHERE[[...places][0]][0];
  return `${icon("check")}<span>Checks passed ${e(where)}</span><span aria-hidden="true">·</span>`;
}

// ── sign in ────────────────────────────────────────────────────────────────

// `backdrop` draws the portfolio's activity dimmed behind the form: the same
// anonymised stories the showcase page draws, so nothing private is on the
// sign-in page. It is decoration, hidden from assistive technology, no mark
// in it takes focus, and it is clipped to the viewport and capped at a dozen
// threads so the page stands one screen tall.
export function renderLogin(error?: string, showcase = false, backdrop?: { stories: Story[]; owner: string; who: string }): string {
  let left = 12;
  const drawn = (backdrop?.stories ?? []).map((s) => {
    const threads = s.threads.slice(0, left);
    left -= threads.length;
    return { ...s, threads };
  }).filter((s) => s.threads.length);
  const graph = drawn.length
    ? `<div class="login-backdrop" aria-hidden="true">${drawn.map((s) => drawStory(s, backdrop!.owner, { replaySeconds: 12, ownerLabel: backdrop!.who })).join("").replace(/ tabindex="0"/g, "")}</div>`
    : "";
  return publicPage({
    title: "Sign in · Atelier",
    description: "Sign in to Atelier, a Git platform for many coding agents: one owner per task, evidence observed, another model family reviews, the owner decides.",
    brand: "/",
    nav: [["How it works", "/how"], ["Source on GitHub", REPO_URL]],
    mainClass: "login-page",
    main: `<section class="login${graph ? " over-graph" : ""}">${graph}
  <h1>Many agents.<br>One decision at a time.</h1>
  <p class="lead">Atelier gives every task one owner, grades its evidence, and brings you only what needs a person.</p>
  <form method="post" action="/login" class="login-form">
    <h2>Sign in to Atelier</h2>
    ${error ? `<p role="alert" class="error">${e(error)}</p>` : ""}
    <label for="token">Server token</label>
    <input id="token" type="password" name="token" autocomplete="current-password" required>
    <p class="meta">Use the token stored in your Keychain as <code>atelier.API_TOKEN</code>.</p>
    <button class="primary">Sign in</button>
  </form>
  <p class="meta">${showcase ? 'Not the owner? <a href="/showcase">See the public showcase</a>, or read ' : "Read "}<a href="/how">how Atelier works</a>.</p>
</section>`,
  });
}

// ── decisions ──────────────────────────────────────────────────────────────

function floorStrip(floor: Floor | undefined, now: Date): string {
  if (!floor?.benches.length) return "";
  const rows = floor.benches.slice(0, 4).map((b) => `<li><a href="/studio#${e(b.project)}-${e(b.item.id)}">
    <span class="pulse" aria-hidden="true"></span><strong>${e(b.model)}</strong><span class="meta strip-harness">${e(b.harness)}</span>
    <span class="strip-task">${e(b.item.id)} · ${e(b.item.title)}</span><span class="meta strip-ago">${e(ago(b.lastActivity, now))}</span></a></li>`).join("");
  const more = floor.benches.length > 4 ? `<li class="meta">and ${floor.benches.length - 4} more</li>` : "";
  return `<section class="floor-strip" aria-label="Agents at work">
  <h2 class="section-title"><a href="/studio">On the floor</a></h2>
  <ul>${rows}${more}</ul>
</section>`;
}

// The task's own thread: just its events, as a story of one. Nothing is drawn
// when the record holds no claim for it (an older record cut at the read limit).
function taskStory(project: string, d: Detail): Story | null {
  const s = buildStory(project, [d.item], d.events.filter((ev) => ev.itemId === d.item.id), d.ownerActor ?? DEFAULT_OWNER);
  return s.threads.length ? s : null;
}

// A waiting decision as a card: the row that selects it, the brief in one line,
// the task's thread in miniature with each review as an edge, and a link to the task page.
// A plan's own entry (approve-plan, plan-blocked) carries its decision in its
// reason, which the card shows in place of the item's brief: the brief reads
// the plan item as a task, and knows nothing of its proposal or its parts.
function decisionCard(row: string, project: string, d: Detail, lead?: InboxEntry): string {
  const brief = briefFor(d, d.events);
  const b = lead && (lead.kind === "approve-plan" || lead.kind === "plan-blocked")
    ? { ...brief, recommendation: { verdict: "decide" as const, reason: lead.reason } } : brief;
  const owner = d.ownerActor ?? DEFAULT_OWNER;
  const story = taskStory(project, d);
  const thread = story
    ? `<div class="stage-scroll card-thread">${drawStory(story, owner, { mini: true, replaySeconds: 0, href: taskHref(project) })}</div>`
    : "";
  return `<li class="decision-card" data-task="${e(project)}/${e(d.item.id)}">${row}
    <div class="card-body">
      <p class="card-brief">${tag(b.recommendation.verdict, VERDICT_TONE[b.recommendation.verdict])}<span>${e(b.recommendation.reason)}</span></p>
      ${thread}
      <p class="meta card-links"><a href="${href("p", project, d.item.id)}">Open the task page</a></p>
    </div></li>`;
}

export function renderInbox(
  entries: InboxEntry[],
  projects: ProjectRecord[],
  ownerName: string | null = null,
  selected?: ReviewContext,
  projectViews: ProjectView[] = [],
  floor?: Floor,
  now = new Date(),
  queued: { project: ProjectRecord; item: Item }[] = [],
  latest?: { story: Story; owner: string },
  details: Map<string, Detail> = new Map(),
  live?: Live,
): string {
  const names = titleMap(projects);
  const groups = new Map<string, InboxEntry[]>();
  for (const x of entries) {
    const key = `${x.project}/${x.itemId}`;
    groups.set(key, [...(groups.get(key) ?? []), x]);
  }
  const rows = [...groups.values()].map(([lead, ...more]) => {
    const [label, tone] = KIND[lead.kind];
    const current = selected?.project.name === lead.project && selected.detail.item.id === lead.itemId;
    const extra = more.length ? `<span class="meta">${more.map((m) => e(KIND[m.kind][0])).join(" · ")}</span>` : "";
    const row = `<a class="decision-row${current ? " selected" : ""}" href="${selectedHref(lead.project, lead.itemId)}"${current ? ' aria-current="true"' : ""}>
      ${icon("decisions")}<span><strong>${e(lead.title)}</strong><span class="meta">${e(names.get(lead.project) ?? lead.project)} · ${e(lead.itemId)}</span>${extra}</span>${tag(label, tone)}${icon("arrow")}</a>`;
    const detail = details.get(`${lead.project}/${lead.itemId}`);
    return detail ? decisionCard(row, lead.project, detail, lead) : `<li>${row}</li>`;
  }).join("");

  const needs = new Set(entries.map((x) => `${x.project}/${x.itemId}`));
  const working = projectViews.flatMap(({ project, items }) =>
    items.filter((i) => i.state === "claimed" && !needs.has(`${project.name}/${i.id}`)).map((item) => ({ project, item })));
  const workingList = working.length
    ? `<h2 class="section-title">Working</h2><ul class="decision-list">${working.map(({ project, item }) =>
        `<li><a class="decision-row" href="${href("p", project.name, item.id)}">${icon("decisions")}<span><strong>${e(item.title)}</strong><span class="meta">${e(titleOf(project))} · ${e(item.owner ?? "Unassigned")}</span></span>${icon("arrow")}</a></li>`).join("")}</ul>`
    : "";

  const lead = groups.size
    ? `${groups.size} decision${groups.size === 1 ? " needs" : "s need"} your attention.`
    : "Nothing is waiting on you.";
  const queue = `<section class="queue">
  <header><h1>Decisions</h1><p class="lead">${lead}</p></header>
  ${floorStrip(floor, now)}
  <h2 class="section-title">Needs your attention</h2>
  ${rows ? `<ul class="decision-list">${rows}</ul>` : `<div class="empty"><h3>You’re clear.</h3><p>New reviews and blockers will appear here. <a href="/studio">Watch the studio</a>.</p></div>`}
  ${workingList}
  ${queued.length ? `<h2 class="section-title">Waiting for a runner</h2><ul class="decision-list">${queued.map(({ project, item }) =>
    `<li><a class="decision-row" href="${href("p", project.name, item.id)}">${icon("studio")}<span><strong>${e(item.title)}</strong><span class="meta">${e(titleOf(project))} · ${e(item.id)} · for ${e(describeDispatch(item.dispatch!))}</span></span>${icon("arrow")}</a></li>`).join("")}</ul>` : ""}
  ${projectViews.some((p) => p.unavailable) ? '<p role="status" class="error">Some projects could not be read. Refresh to try again; this list may be incomplete.</p>' : ""}
  ${!projects.length ? '<div class="empty"><h3>Bring your first project.</h3><p>In its checkout, run <code>atelier init</code> to register it.</p></div>' : ""}
</section>`;
  const sheet = selected
    ? `<section class="review-sheet" id="review" aria-label="Selected task">${reviewBody(selected)}</section>`
    : latest?.story.threads.length
      ? `<section class="review-sheet resting has-graph" aria-label="Latest work">${restingGraph(latest.story, latest.owner)}</section>`
      : `<section class="review-sheet resting"><div>${icon("check")}<h2>Space to focus.</h2><p>Select a decision to see the changes, the evidence, and your next action.</p><a href="/studio">Watch the studio</a></div></section>`;
  return page("Decisions", `<div class="desk">${queue}${sheet}</div>`, "Decisions", ownerName, 0, true, live);
}

// ── flow ───────────────────────────────────────────────────────────────────
// The work as a graph, with the tally that says who did what. Numbers here are
// counted from the Ledger's events by graph.ts; nothing is estimated.

const taskHref = (project: string) => (th: { id: string }) => href("p", project, th.id);
// The owner's label at the start of a sentence.
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

const LOCAL_KEY = '<li><i style="--c:var(--text-muted);border:1.5px dotted currentColor;border-radius:50%;background:var(--shell)"></i>dotted: ran locally</li>';

function legendLine(vendors: Vendor[], hasLocal: boolean, who = "You"): string {
  const items = VENDOR_NAMES.filter(([v]) => vendors.includes(v) || v === "owner")
    .map(([v, label]) => `<li><i style="--c:var(--m-${v})"></i>${e(v === "owner" ? who : label)}</li>`);
  const local = hasLocal ? LOCAL_KEY : "";
  return `<ul class="legend-line" aria-label="Colours"><li><i style="--c:var(--main-line)"></i>main</li>${items.join("")}${local}<li><i style="--c:var(--fault)"></i>sent back</li><li class="meta">times in ${e(zoneLabel())}</li></ul>`;
}

function vendorsIn(stories: Story[]): Vendor[] {
  return [...new Set(stories.flatMap((s) => Object.keys(s.tally.byVendor) as Vendor[]))];
}

function tallyBlock(t: Tally, who = "You"): string {
  const total = t.agentMoves + t.decisions || 1;
  const bar = VENDOR_NAMES.filter(([v]) => v !== "owner" && t.byVendor[v])
    .map(([v]) => `<span style="--c:var(--m-${v});width:${((t.byVendor[v]! / total) * 100).toFixed(2)}%"></span>`).join("")
    + `<span style="--c:var(--m-owner);width:${((t.decisions / total) * 100).toFixed(2)}%"></span>`;
  return `<div class="tally"><div class="tally-bar" aria-hidden="true">${bar}</div><dl>
  <div><dt>agent moves</dt><dd>${t.agentMoves}</dd></div>
  <div class="you"><dt>${who === "You" ? "your" : e(`${who}'s`)} decisions</dt><dd>${t.decisions}</dd></div>
  <div class="cloud"><dt>checks run on a clean copy${t.inCloud ? `, ${t.inCloud} in Cloudflare` : ""}</dt><dd>${t.checks}</dd></div>
  <div class="catch"><dt>times a model sent work back</dt><dd>${t.sentBack}</dd></div>
</dl></div>`;
}

function headline(t: Tally, who = "You"): string {
  const agents = t.agents.length;
  return `<span class="you">${e(cap(who))} made ${plural(t.decisions, "decision")}.</span> <span class="them">${
    agents ? `${plural(agents, "agent")} did the other ${t.agentMoves} moves${t.sentBack ? `, and sent work back ${plural(t.sentBack, "time")}` : ""}.` : "No agent has started yet."}</span>`;
}

function restingGraph(s: Story, owner: string): string {
  const t = s.tally;
  return `<div class="resting-graph">
  <span class="kicker">${e(s.title)} · the work so far${s.partial ? " · the most recent part of the record" : ""}</span>
  <h2><span class="you">You made ${plural(t.decisions, "decision")}.</span> ${plural(t.agents.length, "agent")} made ${t.agentMoves} moves.</h2>
  <p>Nothing is waiting on you. Each thread is a task an agent took off main; it flows back only when you accept it.</p>
  ${legendLine(Object.keys(t.byVendor) as Vendor[], t.localRuns > 0)}
  <div class="stage-scroll">${drawStory(s, owner, { compact: true, replaySeconds: 6, href: taskHref(s.project) })}</div>
  <a href="/flow">See the whole flow</a>
</div>`;
}

const MOMENT_COLOUR = (m: Story["moments"][number], owner: string) =>
  m.tone === "catch" ? "var(--fault)" : m.tone === "merge" ? "var(--main-line)" : m.actor === owner ? "var(--m-owner)" : `var(--m-${vendorFor(m.actor, owner)})`;

// A page's numbers count only the projects whose threads it draws, so the
// headline and the picture agree. Callers' totals are not used.
const drawnTotal = (stories: Story[]) => stories.filter((s) => s.threads.length).reduce((acc, s) => addTally(acc, s.tally), emptyTally());

interface FlowParts { stages: string; columns: string; shown: Story[] }

// The parts Flow and the public showcase share. `where` is the page the replay
// link reloads; `href` links a task, or nothing on the public page.
// A project's history before Atelier, read from git: drawn below its
// threads, framed and labelled as imported, never counted in the tally.
function importedBlock(h: ImportedHistory | undefined, owner: string, title: string, project: string): string {
  if (!h?.total) return "";
  const named = h.lanes.filter((l) => l.label !== NO_AGENT).length;
  return `<div class="imported-box" id="before-${e(project)}">
  <div class="imported-head"><h3>Before Atelier · imported from git</h3><span class="meta">${h.total.toLocaleString("en")} commits${h.complete ? "" : " (the most recent part of the history)"}, ${h.attributed.toLocaleString("en")} naming ${plural(named, "agent")}</span></div>
  <p class="meta">Who took part is read from each commit message's Co-Authored-By and Agent lines. It is what the commits say, not evidence Atelier observed.</p>
  <div class="stage-scroll">${drawImported(h, owner, title)}</div>
</div>`;
}

// A project with no Atelier task at all: none drawn, none planned, and a
// record read in full. A planned task nobody has claimed draws no thread but
// is still a task.
const noTasks = (s: Story) => !s.threads.length && !s.tally.planned && !s.partial;

// Dates as the owner reads them, in the owner's zone: "4 Sept to 5 Oct", with
// years only when the two ends fall in different years.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"];
function dayLabel(at: string | number, year: boolean): string {
  return keyLabel(dayOf(at), year);
}
// The same label from a day already in the owner's zone, "2026-10-05".
function keyLabel(key: string, year: boolean): string {
  const [y, m, d] = key.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}${year ? ` ${y}` : ""}`;
}
export function spanLabel(from: number, to: number): string {
  const a = dayOf(from * 1000), b = dayOf(to * 1000);
  const year = a.slice(0, 4) !== b.slice(0, 4);
  return a === b ? dayLabel(from * 1000, false) : `${dayLabel(from * 1000, year)} to ${dayLabel(to * 1000, year)}`;
}

// Below this many imported commits, a project's own "before" is too thin a
// contrast to hang the comparison on, and the page prefers whichever shown
// project is known only from its git history, the one with the largest of
// those histories.
const SAME_MIN = 50;

// What the comparison draws. `same` is a project with both commits from
// before its first task and tasks since, shown on both sides as itself, but
// only when its imported history is substantial or no other shown project is
// known only from git; otherwise `before` is that git-only project with the
// largest imported history, and the record Atelier kept of the shown
// projects' tasks stands against it.
function comparePick(stories: Story[], imported: Map<string, ImportedHistory>): { same?: Story; before?: Story } {
  const total = (s: Story) => imported.get(s.project)?.total ?? 0;
  const same = stories.filter((s) => s.threads.length && total(s) > 0).sort((a, b) => b.threads.length - a.threads.length)[0];
  const before = stories.filter((s) => noTasks(s) && total(s) > 0).sort((a, b) => total(b) - total(a))[0];
  if (same && (total(same) >= SAME_MIN || !before)) return { same };
  return before ? { before } : {};
}

// Before and with Atelier, side by side. When one project holds both a
// substantial history from before its first task and tasks since, that
// project is shown on both sides: its own git history beside its own
// Atelier record. Otherwise the git-only project with the largest imported
// history stands before the record Atelier kept of the shown projects'
// tasks. `href` names where each card links, the showcase's portfolio cards.
export function compareBlock(stories: Story[], imported: Map<string, ImportedHistory>, t: Tally, owner: string, who: string, href?: (s: Story) => string): string {
  const pick = comparePick(stories, imported);
  const same = pick.same;
  const before = same ?? pick.before;
  const withs = same ? [same] : stories.filter((s) => s.threads.length);
  if (!before || !withs.length || (!same && !t.claims)) return "";
  if (same) t = same.tally;
  const h = imported.get(before.project)!;
  const named = h.lanes.filter((l) => l.label !== NO_AGENT);
  const bar = h.lanes.map((l) => `<span style="--c:${laneColour(l.label, owner)};width:${((l.count / h.lanes.reduce((n, x) => n + x.count, 0)) * 100).toFixed(2)}%"></span>`).join("");
  const total = t.agentMoves + t.decisions || 1;
  const ours = VENDOR_NAMES.filter(([v]) => v !== "owner" && t.byVendor[v])
    .map(([v]) => `<span style="--c:var(--m-${v});width:${((t.byVendor[v]! / total) * 100).toFixed(2)}%"></span>`).join("")
    + `<span style="--c:var(--m-owner);width:${((t.decisions / total) * 100).toFixed(2)}%"></span>`;
  const row = (n: number | string, label: string, dim = false) => `<li${dim ? ' class="none"' : ""}><b>${typeof n === "number" ? n.toLocaleString("en") : e(n)}</b> ${e(label)}</li>`;
  const withTitle = withs.map((s) => e(s.title)).join(" and ");
  const tasks = withs.reduce((n, s) => n + s.threads.length, 0);
  const reviews = t.approvals + t.sentBack;
  // A share that rounds to 0% or 100% without being exactly that says so.
  const pct = (n: number, d: number) => {
    const p = Math.round((n / d) * 100);
    return p === 0 && n > 0 ? "<1%" : p === 100 && n < d ? ">99%" : `${p}%`;
  };
  // Dates for the same-project card. The commits' span is from the messages'
  // own times; the Atelier side starts at the first thing the record shows.
  const began = same ? [...same.moments].sort((a, b) => a.at.localeCompare(b.at))[0]?.at : undefined;
  const beforeDates = same
    ? `<p class="meta compare-dates">${e(spanLabel(h.first, h.last))}${h.complete ? "" : " · only the most recent part of the history was read"}</p>` : "";
  const withDates = same && began
    ? `<p class="meta compare-dates">since ${e(dayLabel(began, false))}${same.partial ? " · only the most recent part of the record was read" : ""} · the same project</p>` : "";
  const link = (s: Story, beforeSide: boolean) => href ? href(s) : `#${beforeSide && same ? "before-" : ""}${s.project}`;
  return `<section class="compare" aria-label="Before and with Atelier">
  <a class="compare-card before" href="${link(before, true)}">
    <span class="kicker">Before Atelier · from git</span>
    <h2>${e(before.title)}</h2>
    ${beforeDates}
    <div class="tally-bar" aria-hidden="true">${bar}</div>
    <p class="compare-lead"><b>${e(pct(h.attributed, h.total))}</b> of commits name an agent. Git itself keeps no record of what was checked, reviewed or decided.</p>
    <ul>${row(h.total, `commits${h.complete ? "" : " (the most recent part)"}`)}${row(h.attributed, `name ${plural(named.length, "agent")} in their messages`)}${row("—", "checks tied to a revision", true)}${row("—", "reviews by another model", true)}${row("—", `decisions by ${who}`, true)}</ul>
    <p class="meta">Git keeps what each commit message claims. It cannot say whether the checks passed on that revision, which model reviewed it, or who decided it should land.</p>
  </a>
  <a class="compare-card with" href="${link(withs[0], false)}">
    <span class="kicker">With Atelier · observed</span>
    <h2>${withTitle}</h2>
    ${withDates}
    <div class="tally-bar" aria-hidden="true">${ours}</div>
    ${reviews ? `<p class="compare-lead"><b>${e(pct(t.sentBack, reviews))}</b> of reviews sent the work back: ${t.sentBack.toLocaleString("en")} of ${reviews.toLocaleString("en")}.</p>` : ""}
    <ul>${row(tasks, `${tasks === 1 ? "task" : "tasks"} taken, each by one agent on its own fork`)}${row(t.checks, `checks run on a clean copy of the exact revision`)}${row(reviews, `reviews, ${t.sentBack} sending work back`)}${row(t.decisions, `decisions by ${who}`)}${row(t.merges, "merged, with their record attached")}</ul>
    <p class="meta">Atelier records each step as it happens: who held the task, what ran on which revision, who reviewed it, and the decision that let it land.</p>
  </a>
</section>`;
}

function flowParts(stories: Story[], t: Tally, owner: string, where: string, href?: (s: Story) => (th: { id: string }) => string, who = "You", imported: Map<string, ImportedHistory> = new Map()): FlowParts {
  const shown = stories.filter((s) => s.threads.length || imported.get(s.project)?.total);
  const moments = shown
    .flatMap((s) => s.moments.map((m) => ({ ...m, project: s.title })))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 14);
  const many = shown.length > 1;
  const stages = shown.map((s) => `<section class="stage" id="${e(s.project)}" aria-label="${e(s.title)}">
  <div class="stage-head"><h2>${e(s.title)}</h2><span class="meta">${s.threads.length
    ? `${plural(s.threads.length, "task")} taken · ${s.tally.merges} merged · ${plural(s.tally.agents.length, "agent")}${s.partial ? " · the most recent part of the record" : ""}`
    : noTasks(s) ? "History imported from git · no Atelier tasks yet" : `${plural(s.tally.planned, "task")} planned, none taken yet${s.partial ? " · the most recent part of the record" : ""}`}</span>
  ${s.threads.length ? `<a class="replay" href="${where}${where.includes("?") ? "&amp;" : "?"}replay=${Date.now().toString(36)}#${e(s.project)}">▶ Replay</a>` : ""}</div>
  ${s.threads.length ? `<div class="stage-scroll">${drawStory(s, owner, { ...(href ? { href: href(s) } : {}), ...(who === "You" ? {} : { ownerLabel: who }) })}</div>` : imported.get(s.project)?.total ? "" : `<p class="meta stage-empty">No Atelier tasks yet.</p>`}
  ${importedBlock(imported.get(s.project), owner, s.title, s.project)}
</section>`).join("");
  const yours = who === "You" ? "your" : `${who}'s`;
  const journey = [
    ["Planned", `${cap(who)} ${who === "You" ? "describe" : "describes"} an outcome; it becomes a task with a scope.`, `${plural(t.planned, "task")} planned`, "var(--main-line)"],
    ["Claimed", "One agent takes it and gets its own fork in Cloudflare Artifacts. Nobody else can write there.", `${plural(t.claims, "claim")}, ${plural(t.handoffs, "handoff")}`, "var(--m-anthropic)"],
    ["Worked", `The agent commits and pushes to its fork, never to ${yours} checkout.`, `${plural(t.pushes, "push", "pushes")}`, "var(--m-openai)"],
    ["Checked", "The project's checks run on a clean copy of the exact revision: in a Cloudflare container, or, where the project allows it, on the agent's machine.", `${plural(t.checks, "check")} observed${t.inCloud ? `, ${t.inCloud} in Cloudflare` : ""}`, "var(--observed)"],
    ["Reviewed", `Changes to protected files need an approval from a model of another family than every contributor; ${yours} own approval does not count. Without one, ${who === "You" ? "you" : who} can accept only by recording an override with its reason.`, `${plural(t.approvals, "approval")}, ${t.sentBack} sent back`, "var(--m-zai)"],
    ["Decided", `${cap(who)} ${who === "You" ? "see" : "sees"} the diff, the evidence and the reviews, and ${who === "You" ? "accept" : "accepts"} one revision.`, `${plural(t.accepts, "acceptance")}`, "var(--m-owner)"],
    ["Merged", `It merges into main on ${yours} machine, with its whole history attached as a git note.`, `${t.merges} merged`, "var(--main-line)"],
  ].map(([b, p, n, c]) => `<li style="--c:${c}"><b>${e(b)}</b><p>${e(p)}</p><span class="n">${e(n)}</span></li>`).join("");
  const columns = `<div class="flow-cols">
  <section aria-label="What happened"><h2>What happened</h2><ol class="moments">${moments.map((m) =>
    `<li class="${m.tone}"><span class="dot" style="--c:${MOMENT_COLOUR(m, owner)}"></span><time datetime="${e(m.at)}">${e(shortStamp(m.at))}</time><p>${many ? `<span class="meta">${e(m.project)} · </span>` : ""}${e(m.text)}</p></li>`).join("")}</ol></section>
  <section aria-label="How a task travels"><h2>How a task travels</h2><ol class="journey">${journey}</ol></section>
</div>`;
  return { stages, columns, shown };
}

export function renderFlow(stories: Story[], _total: Tally, owner: string, ownerName: string | null = null, unavailable = false, imported: Map<string, ImportedHistory> = new Map(), sinceParam = "all", familyParam?: string, familiesPresent: string[] = [], live?: Live): string {
  const t = drawnTotal(stories);
  // Replay keeps the filters in force, so it replays what is shown.
  const filtered = [sinceParam !== "all" ? `since=${e(sinceParam)}` : "", familyParam ? `family=${e(familyParam)}` : ""].filter(Boolean).join("&amp;");
  const { stages, columns, shown } = flowParts(stories, t, owner, filtered ? `/flow?${filtered}` : "/flow", (s) => taskHref(s.project), "You", imported);
  const body = shown.length
    ? `${legendLine(vendorsIn(shown), shown.some(s => s.tally.localRuns > 0))}${stages}${columns}`
    : `<div class="empty"><h3>No work yet.</h3><p>When an agent claims a task, its thread appears here, from claim to merge.</p></div>`;
  
  const link = (s: string, f: string | undefined) => `?since=${e(s)}${f ? `&amp;family=${e(f)}` : ''}`;
  const sinceLinks = [["1d", "last day"], ["7d", "last week"], ["all", "all time"]]
    .map(([val, label]) => `<a href="${link(val, familyParam)}"${sinceParam === val ? ' aria-current="page"' : ''}>${e(label)}</a>`).join("");
  
  const fams = VENDOR_NAMES.filter(([v]) => familiesPresent.includes(v));
  const familyLinks = fams.map(([v, label]) => `<a href="${link(sinceParam, v)}"${familyParam === v ? ' aria-current="page"' : ''} style="color:var(--m-${v})">${e(label)}</a>`).join("");
  const allFamiliesLink = `<a href="${link(sinceParam, undefined)}"${!familyParam ? ' aria-current="page"' : ''}>all families</a>`;
  
  const filters = `<nav class="repo-tabs" aria-label="Filters">
    <span class="meta" style="align-self: center; margin-right: 8px">Time:</span>${sinceLinks}
    ${familiesPresent.length > 0 ? `<span class="meta" style="align-self: center; margin: 0 8px 0 16px">Family:</span>${allFamiliesLink}${familyLinks}` : ''}
  </nav>`;

  return page("Flow", `<div class="page-width flow">
  <header class="flow-hero">
    <div><span class="kicker">Atelier · every project · from the ledger</span>
      <h1>${headline(t)}</h1>
      <p class="lead">Each coloured thread is a task an agent took off main: its pushes, its checks, the reviews from other models, and your decision. Hover over a mark for what happened; select a task to open it.</p></div>
    ${tallyBlock(t)}
  </header>
  ${filters}
  ${unavailable ? '<p role="status" class="error">Some projects could not be read; the flow may be incomplete.</p>' : ""}
  ${body}
</div>`, "Flow", ownerName, 0, true, live);
}

// ── showcase ───────────────────────────────────────────────────────────────
// The public page: the portfolio the owner chose to show, read only. Stories
// arrive redacted (graph.ts), and for a project shown anonymously they arrive
// anonymised as well: titled by a neutral label from the project's kind, each
// task titled by its kind of work, so no project name, task title, path,
// commit message, review note, person or address reaches the HTML.

export const REPO_URL = "https://github.com/pavithran/atelier";

// One shown project as the portfolio draws it: the project's record (for its
// title when named), how it is shown, its story, and its two weeks of moves
// for the card's bar graph when the events were read.
export interface ShownProject {
  project: ProjectRecord;
  mode: "named" | "anonymous";
  story: Story;
  pulse?: Pulse;
}

// The task stories under the cards: two or three threads from different shown
// projects, the ones with the most recorded moves, each drawn alone.
function taskStories(cards: ShownProject[]): { card: ShownProject; thread: Story["threads"][number]; one: Story }[] {
  const best = new Map<ShownProject, Story["threads"][number]>();
  for (const { card, thread } of cards.flatMap((card) => card.story.threads.map((thread) => ({ card, thread })))
    .sort((a, b) => b.thread.beads.length - a.thread.beads.length)) {
    if ([...best.keys()].some((other) => other.story.project === card.story.project)) continue;
    if (!best.has(card)) best.set(card, thread);
    if (best.size >= 3) break;
  }
  return [...best].map(([card, thread]) => ({ card, thread, one: { ...card.story, threads: [thread] } }));
}

// A card's label: the project's title when named, its neutral kind otherwise.
const shownLabel = (c: ShownProject) => (c.mode === "anonymous" ? cap(c.story.title) : c.story.title);

export function renderShowcase(stories: Story[], _total: Tally, owner: string, ownerName: string | null, unavailable = false, imported: Map<string, ImportedHistory> = new Map(), shown?: ShownProject[]): string {
  // Without the server's portfolio view (a direct render), the stories stand
  // as the portfolio themselves, shown named.
  const cards = shown ?? stories.map((s): ShownProject => ({ project: { name: s.project, repo: s.project, policy: { checks: [], protected: [] }, createdAt: "" }, mode: "named", story: s }));
  const total = drawnTotal(stories);
  const who = ownerName || "the owner";
  const { columns, shown: drawn } = flowParts(stories, total, owner, "/showcase", undefined, who, imported);
  const body = drawn.length
    ? `${legendLine(vendorsIn(drawn), drawn.some(s => s.tally.localRuns > 0), cap(who))}${columns}`
    : `<div class="empty"><h3>Nothing to show yet.</h3><p>The projects shown here have no claimed tasks yet.</p></div>`;
  // Each card is where a comparison card lands, so the cards come first in
  // the page and the comparison links up to them.
  const anchor = (s: Story) => `#card-${Math.max(1, cards.findIndex((c) => c.story.project === s.project) + 1)}`;
  const cardList = cards.map((c, i) => {
    const t = c.story.tally;
    const inProgress = c.story.threads.filter((th) => th.end === null && ["claimed", "submitted", "accepted"].includes(th.state)).length;
    const families = VENDOR_NAMES.filter(([v]) => v !== "owner" && t.byVendor[v])
      .map(([v, label]) => `<li><i style="--c:var(--m-${v})"></i>${e(label)}</li>`).join("");
    return `<li class="show-card" id="card-${i + 1}">
    <h2>${e(shownLabel(c))}</h2>
    ${c.pulse ? pulseGraph(c.pulse) : ""}
    <p class="card-tally"><span><b>${t.merges}</b>merged</span><span><b>${t.sentBack}</b>sent back</span><span><b>${inProgress}</b>in progress</span></p>
    ${families ? `<ul class="legend-line" aria-label="Families that worked on it">${families}</ul>` : '<p class="meta">No agent has worked here yet.</p>'}
  </li>`;
  }).join("");
  const picks = taskStories(cards);
  const storyList = picks.map((p, n) => `<figure class="show-story" id="story-${n + 1}">
    <figcaption><strong>${e(cap(p.thread.title))}</strong> <span class="meta">from ${e(shownLabel(p.card))}, drawn as it happened</span></figcaption>
    <div class="stage-scroll">${drawStory(p.one, owner, { replaySeconds: 9, ...(who === "You" ? {} : { ownerLabel: who }) })}</div>
  </figure>`).join("");
  return publicPage({
    title: "Atelier · public showcase",
    description: "Atelier: several coding agents on one codebase, one owner per task, graded evidence, and the owner's decision. A Git platform on Cloudflare Workers and Artifacts.",
    brand: "/showcase",
    nav: [["How it works", "/how"], ["Source on GitHub", REPO_URL], ["Sign in", "/login"]],
    mainClass: "page-width flow",
    main: `
  <header class="flow-hero">
    <div><span class="kicker">Public showcase · read only · from the ledger</span>
      <h1>A Git platform for many coding agents</h1>
      <p class="lead">One owner per task, evidence observed, another model family reviews, the owner decides. Each card below is a project ${e(who)} chose to show, with its real two weeks of activity; under them, task stories drawn as threads, from claim to merge.</p>
      <p class="subhead">${headline(total, who)}</p></div>
    ${tallyBlock(total, who)}
  </header>
  ${unavailable ? '<p role="status" class="error">A project could not be read just now; this page may be incomplete.</p>' : ""}
  <section aria-label="The portfolio" id="cards">
    <h2 class="section-title">The portfolio</h2>
    <ul class="show-cards">${cardList}</ul>
  </section>
  ${picks.length ? `<section aria-label="Task stories" id="stories">
    <h2 class="section-title">Task stories</h2>
    ${storyList}
  </section>` : ""}
  ${compareBlock(stories, imported, total, owner, who, anchor)}
  ${body}
  <p class="meta public-note">Shown read only. Projects the owner names are named; the others are shown anonymised, with no project name, task title, path, commit message or address in them. Review notes, reports and diffs stay private in every case.</p>
`,
  });
}

// ── models ─────────────────────────────────────────────────────────────────
// The pool: every model the owner has made available, where it runs, how it
// is reached, what the runner last found, and what the record says it did.

const STATUS_TONE: Record<string, string> = { available: "go", refused: "bad", slow: "ask", unknown: "" };

export function renderModels(entries: ModelEntry[], record: ModelRecord, ownerName: string | null = null, error = "", window: { events: number; unread: string[] } = { events: 1000, unread: [] }, reliability: Reliability = new Map()): string {
  const card = (m: ModelEntry) => {
    const actors = [m.id, ...m.aliases].map((id) => `${m.harness}/${id}`);
    // The entry's model across every project and harness, by modelKey; an
    // alias the registry reads as another model shows as its own line.
    const across = [...new Set(actors.map(modelKey))].flatMap((k) => reliability.get(k) ?? []);
    const r = actors.map((a) => record.get(a)).filter(Boolean).reduce((acc, x) => ({
      claimed: acc.claimed + x!.itemsClaimed, merges: acc.merges + x!.merges, pass: acc.pass + x!.checkPasses,
      fail: acc.fail + x!.checkFailures, back: acc.back + x!.reviewsRejected,
    }), { claimed: 0, merges: 0, pass: 0, fail: 0, back: 0 });
    const status = m.status
      ? `${tag(m.status.state, STATUS_TONE[m.status.state])}<span class="meta">checked by ${e(m.status.by ?? "a runner")} ${e(when(m.status.at))}${m.status.served && m.status.served !== m.id ? `, served as <code>${e(m.status.served)}</code>` : ""}${m.status.detail ? `, ${e(m.status.detail)}` : ""}</span>`
      : `${tag("not checked yet")}<span class="meta">the runner reports here once it has tried this model</span>`;
    const how = [e(m.harness), e(m.provider), m.endpoint ? `<code>${e(m.endpoint)}</code>` : "", m.keychain ? `key in Keychain <code>${e(m.keychain)}</code>` : ""].filter(Boolean).join(" · ");
    return `<li class="model" style="--c:var(--m-${m.family})">
  <div class="model-head"><strong class="mono">${e(m.id)}</strong>${m.family === "other" ? tag("family not recognised", "ask") : `<span class="meta">${e(m.family)}</span>`}</div>
  <p class="meta">${how}</p>
  ${m.aliases.length ? `<p class="meta">Also known as ${m.aliases.map((a) => `<code>${e(a)}</code>`).join(", ")}</p>` : ""}
  <p class="model-status">${status}</p>
  <p class="meta">${r.claimed ? `Took ${plural(r.claimed, "task")}, merged ${r.merges}; checks ${r.pass} passed, ${r.fail} failed; sent back ${plural(r.back, "time")}.` : "No work recorded yet."}</p>
  ${across.map((x) => `<p class="meta">Across projects${across.length > 1 ? ` as <code>${e(x.model)}</code>` : ""}: ${e(reliabilityLine(x))}</p>`).join("")}
  ${m.note ? `<p class="meta">${e(m.note)}</p>` : ""}
  <form method="post" action="/models/remove" class="inline"><input type="hidden" name="id" value="${e(m.id)}"><button class="quiet">Remove</button></form>
</li>`;
  };
  const group = (where: "home" | "cloud", title: string, none: string) => {
    const list = entries.filter((m) => m.where === where);
    return `<h2 class="section-title">${title} · ${list.length}</h2>${list.length ? `<ul class="model-grid">${list.map(card).join("")}</ul>` : `<p class="empty">${none}</p>`}`;
  };
  const opts = (values: readonly string[]) => values.map((v) => `<option>${e(v)}</option>`).join("");
  return page("Models", `<div class="page-width">
  <header><h1>Models</h1><p class="lead">${plural(entries.length, "model")} in the pool. The runner on your machine checks each one and reports what it found.</p>
  <p class="meta">Each model's record counts the most recent ${window.events.toLocaleString("en")} events of every project${window.unread.length ? `; ${window.unread.map(e).join(", ")} could not be read just now, so ${window.unread.length === 1 ? "its" : "their"} work is not counted` : ""}.</p></header>
  ${error ? `<p role="alert" class="error">${e(error)}</p>` : ""}
  ${group("home", "At home", "No home models yet. Add one served by your Studio or another local server.")}
  ${group("cloud", "In the cloud", "No cloud models yet. Add one reached through a harness sign-in or an API key in your Keychain.")}
  ${reliabilitySection(reliability, ownerName, window)}
  <details class="new-task"${entries.length ? "" : " open"}><summary>Add a model</summary>
    <form method="post" action="/models/add" class="stack">
      <label>Model id, as the harness names it<input name="id" required maxlength="128" placeholder="gemini-3.1-pro, GLM-5.3-Flash-4_8bit"></label>
      <label>Harness<select name="harness">${opts(HARNESSES)}</select></label>
      <label>Where it runs<select name="where"><option>home</option><option>cloud</option></select></label>
      <label>Provider<select name="provider">${opts(PROVIDERS)}</select></label>
      <label>Endpoint, for an OpenAI-compatible server<input name="endpoint" type="url" placeholder="http://10.0.0.110:8000/v1"></label>
      <label>Keychain entry holding its key<input name="keychain" maxlength="100" placeholder="gemini.API_KEY"></label>
      <p class="meta">Atelier stores the entry's name, never the key. Create the entry yourself on the runner's machine.</p>
      <label>Other names for it, separated by commas<input name="aliases" maxlength="300"></label>
      <label>Note<input name="note" maxlength="300"></label>
      <button class="primary">Add to the pool</button>
    </form>
  </details>
</div>`, "Models", ownerName);
}

// ── reliability ────────────────────────────────────────────────────────────
// Each model's reliability across every project (src/models/reliability.ts),
// on the Models page and the Usage page alike: one row per model that has
// acted, pool or not, and under it the causes the record holds.

const CAUSES_SHOWN = 5;

function causeList(title: string, causes: Cause[]): string {
  if (!causes.length) return "";
  const rows = causes.slice(0, CAUSES_SHOWN).map((c) =>
    `<li><span class="meta">${e(c.project)}${c.item ? `/${e(c.item)}` : ""} · ${e(c.by)} · ${e(when(c.at))}</span> ${e(c.note || "no note")}</li>`).join("");
  const more = causes.length > CAUSES_SHOWN ? `<li class="meta">and ${causes.length - CAUSES_SHOWN} more</li>` : "";
  return `<h4>${e(title)} · ${causes.length}</h4><ul class="usage-notes">${rows}${more}</ul>`;
}

function reliabilityRow(r: ModelReliability, who: string): string {
  const rounds = roundsPerMerge(r);
  const merges = !r.merged ? '<span class="meta">none merged</span>'
    : rounds ? `${e(rounds)} each<span class="meta">over ${e(plural(r.mergedReviewed, "reviewed merge"))}${r.merged > r.mergedReviewed ? `, ${r.merged - r.mergedReviewed} merged without a model's review` : ""}</span>`
    : `${e(plural(r.merged, "merge"))}<span class="meta">none reviewed by a model</span>`;
  const owner = r.ownerApprovals;
  const causes = [
    causeList("Rejections of its work", r.rejections),
    causeList("Defects traced to its work", r.defects),
    causeList("Its approvals a defect contradicted", r.contradicted),
    causeList("Runs reported", r.runCauses),
  ].join("");
  return `<tr><th scope="row"><code>${e(r.model)}</code><span class="meta">${r.actors.map(e).join(", ")} · ${e(plural(r.projects.length, "project"))}</span></th>
  <td class="num">${r.firstReviews ? `${r.approvedFirst} of ${r.firstReviews}` : '<span class="meta">none reviewed</span>'}</td>
  <td class="num">${merges}</td>
  <td class="num">${r.rejections.length}<span class="meta">${e(plural(r.defects.length, "defect"))} traced to its work</span></td>
  <td class="num">${r.contradicted.length} of ${e(plural(r.approvals, "approval"))}<span class="meta">${e(plural(r.unfinishedReviews, "review"))} without a verdict</span></td>
  <td class="num">${r.runs.stalled} stalled · ${r.runs["timed-out"]} timed out · ${r.runs.refused} refused</td>
  <td class="num">${owner.page} by ${e(who)} on the page<span class="meta">${owner.api} through the API · ${owner.unrecorded} unrecorded</span></td>
</tr>${causes ? `<tr class="causes"><td colspan="7"><details><summary>Causes for ${e(r.model)}</summary>${causes}</details></td></tr>` : ""}`;
}

export function reliabilitySection(models: Reliability, ownerName: string | null, window: { events: number; unread: string[] }): string {
  const who = ownerName || "the owner";
  const rows = [...models.values()];
  const lead = `Each model's record across the most recent ${window.events.toLocaleString("en")} events of every project${window.unread.length ? ` (${window.unread.map(e).join(", ")} could not be read just now, so ${window.unread.length === 1 ? "its" : "their"} work is not counted)` : ""}, and the runs the runners reported. Its work is what it held; its verdicts are its own reviews. Approvals by ${e(who)} are never a model's verdict: they are counted per model whose work they approved, those made on the task page apart from those recorded through the API, as the orchestrator records them; those from before Atelier kept the two apart are unrecorded.`;
  return `<section class="reliability" aria-label="Reliability by model">
  <h2 class="section-title">Reliability by model · ${rows.length}</h2>
  <p class="meta">${lead}</p>
  ${rows.length ? `<table class="usage-table">
    <thead><tr><th scope="col">Model</th><th scope="col">Approved at first review</th><th scope="col">Review rounds to merge</th><th scope="col">Rejections</th><th scope="col">Approvals contradicted</th><th scope="col">Runs stalled, timed out, refused</th><th scope="col">Owner approvals of its work</th></tr></thead>
    <tbody>${rows.map((r) => reliabilityRow(r, who)).join("")}</tbody>
  </table>` : '<p class="empty">No model has acted yet.</p>'}
</section>`;
}

// ── studio ─────────────────────────────────────────────────────────────────

const MARK_NAMES: Record<MarkKind, string> = {
  claim: "Claimed",
  handoff: "Handed off",
  push: "Pushed",
  "observed-cloud": "Check passed in Cloudflare",
  "observed-local": "Check passed on the agent's machine",
  failed: "Check failed",
  reported: "Reported, not verified",
  submit: "Submitted",
  approve: "Approved",
  reject: "Changes requested",
  accept: "Accepted",
};

// Each kind has its own shape as well as its own colour, so the lane reads
// without colour (portfolio principle: colour never carries status alone).
function markShape(kind: MarkKind): string {
  switch (kind) {
    case "claim": return '<rect x="-6" y="-6" width="12" height="12" class="m-claim"/>';
    case "handoff": return '<path d="M-7 -7 L5 0 L-7 7 M-1 -7 L11 0 L-1 7" class="m-handoff"/>';
    case "push": return '<path d="M0 -12 V12" class="m-push"/>';
    case "observed-cloud": return '<circle r="7" class="m-cloud"/>';
    case "observed-local": return '<circle r="6" class="m-local"/>';
    case "failed": return '<path d="M-6 -6 L6 6 M6 -6 L-6 6" class="m-failed"/>';
    case "reported": return '<circle r="6" class="m-reported"/>';
    case "submit": return '<path d="M0 -8 L8 0 L0 8 L-8 0 Z" class="m-submit"/>';
    case "approve": return '<path d="M-7 5 L0 -8 L7 5 Z" class="m-approve"/>';
    case "reject": return '<path d="M-7 -5 L0 8 L7 -5 Z" class="m-reject"/>';
    case "accept": return '<path d="M0 -9 L9 0 L0 9 L-9 0 Z" class="m-accept"/>';
  }
}

const TRACK_H = 76;
const MID = 40;

// One lane, drawn as the Flow graph draws a thread: a band per holder and
// the thread along the shared axis, both in the holder's family colour (a
// local run dotted), so a handoff is a change of band and colour; a mark for
// every recorded event, staggered where marks crowd together; and the
// current holder's band and thread running to the now line, where the head
// breathes.
function lane(b: Bench, floor: Floor, now: Date, titles: Map<string, string>, owner: string): string {
  const pct = (at: string) => position(at, floor) * 100;
  const colour = (actor: string) => `var(--m-${vendorFor(actor, owner)})`;
  const spans = b.spans.map((sp) => {
    const x = pct(sp.from), w = Math.max(0.6, pct(sp.to ?? now.toISOString()) - x);
    const current = sp.to === null;
    const label = splitActor(sp.holder).model;
    const c = colour(sp.holder);
    // A band that starts in the last fifth of the axis is too short for its
    // label, which then sits to the left of the band instead of running past now.
    const before = x > 80;
    return `<rect x="${x.toFixed(2)}%" y="8" width="${w.toFixed(2)}%" height="${TRACK_H - 16}" rx="6" class="${current ? "span-now" : "span-past"}" style="--c:${c}"><title>${e(sp.holder)} held it from ${e(clock(sp.from))}${sp.to ? ` to ${e(clock(sp.to))}` : " until now"}</title></rect>
      <line x1="${x.toFixed(2)}%" y1="${MID}" x2="${(x + w).toFixed(2)}%" y2="${MID}" class="g-thread g-lane${isLocalRun(sp.holder) ? " local" : ""}" style="--c:${c}"/>
      <text x="${x.toFixed(2)}%" dx="${before ? -8 : 8}" y="22"${before ? ' text-anchor="end"' : ""} class="span-label${current ? " now" : ""}" style="--c:${c}">${e(label)}</text>`;
  }).join("");
  const xs = b.marks.map((m) => position(m.at, floor));
  const dy = staggers(xs);
  const marks = b.marks.map((m, i) =>
    `<svg x="${(xs[i] * 100).toFixed(2)}%" y="${MID + dy[i] * 13}" overflow="visible" class="mark"><title>${e(MARK_NAMES[m.kind])}: ${e(m.title ?? m.label)} · ${e(clock(m.at))}</title>${markShape(m.kind)}</svg>`).join("");
  const last = b.marks[b.marks.length - 1];
  const chain = b.chain.length > 1
    ? `<p class="chain" aria-label="Held by, in order">${b.chain.map((a) => `<span title="${e(a)}">${e(splitActor(a).model || a)}</span>`).join('<span aria-hidden="true"> → </span>')}</p>`
    : "";
  const tone = b.item.state === "accepted" ? "go" : b.item.state === "submitted" ? "ask" : "";
  return `<li class="lane" id="${e(b.project)}-${e(b.item.id)}" style="--c:${colour(b.agent)}">
  <div class="bench">
    <p class="who"><strong>${e(b.model)}</strong><span class="meta">${e(b.harness || "agent")}</span></p>
    <p class="task"><a href="${href("p", b.project, b.item.id)}">${e(b.item.title)}</a></p>
    <p class="meta">${e(titles.get(b.project) ?? b.project)} · ${e(b.item.id)} · ${tag(stateLabel[b.item.state], tone)}</p>
    ${chain}
  </div>
  <div class="track">
    <svg class="track-svg" width="100%" height="${TRACK_H}" role="img" aria-label="${e(`${b.marks.length} recorded events for ${b.item.id}, held by ${b.chain.map(modelOf).join(", then ")}; latest: ${last ? `${MARK_NAMES[last.kind]} ${ago(last.at, now)}` : "none"}`)}">
      <g class="g-task live">
      <line x1="0" y1="${MID}" x2="100%" y2="${MID}" class="axis"/>
      ${spans}
      <line x1="100%" y1="4" x2="100%" y2="${TRACK_H - 4}" class="now-line"/>
      ${marks}
      <circle class="g-head" cx="100%" cy="${MID}" r="4.5" style="--c:${colour(b.agent)}"><title>${e(b.agent)} holds it now</title></circle>
      </g>
    </svg>
    <p class="meta latest">${last ? `<strong>${e(MARK_NAMES[last.kind])}</strong> · ${e(last.label)} · ${e(ago(last.at, now))}` : "No activity recorded yet."}</p>
  </div>
</li>`;
}

export function renderStudio(floor: Floor, ownerName: string | null = null, now = new Date(), unavailable = false, projects: ProjectRecord[] = [], owner = DEFAULT_OWNER): string {
  const titles = titleMap(projects);
  const agents = new Set(floor.benches.map((b) => b.agent)).size;
  const vendors = [...new Set(floor.benches.flatMap((b) => b.chain.map((a) => vendorFor(a, owner))))];
  const hasLocal = floor.benches.some((b) => b.chain.some(isLocalRun));
  const legend = (Object.keys(MARK_NAMES) as MarkKind[]).map((k) =>
    `<li><svg width="24" height="24" aria-hidden="true"><svg x="12" y="12" overflow="visible" class="mark">${markShape(k)}</svg></svg>${e(MARK_NAMES[k])}</li>`).join("");
  const mid = new Date((Date.parse(floor.from) + Date.parse(floor.to)) / 2).toISOString();
  const body = floor.benches.length
    ? `${familyLegend(vendors, "You", hasLocal ? LOCAL_KEY : "")}<div class="axis-labels" aria-hidden="true"><span>${e(clock(floor.from))}</span><span>${e(clock(mid))}</span><span>now</span></div>
<ol class="lanes">${floor.benches.map((b) => lane(b, floor, now, titles, owner)).join("")}</ol>`
    : `<div class="empty"><h3>The floor is quiet.</h3><p>When an agent claims a task, its bench appears here with every push, check and handoff as it happens.</p></div>`;
  return page("Studio", `<div class="studio">
  <header><h1>Studio</h1>
  <p class="lead">${agents ? `${agents} agent${agents === 1 ? "" : "s"} at work on ${floor.benches.length} task${floor.benches.length === 1 ? "" : "s"}.` : "No agent is working right now."} <span class="meta">Updated ${e(clock(now.toISOString()))}; refreshes every 15 seconds.</span></p></header>
  ${unavailable ? '<p role="status" class="error">Some projects could not be read; the floor may be incomplete.</p>' : ""}
  ${body}
  <details class="disclosure legend-box"><summary>What the marks mean</summary><ul class="legend">${legend}</ul></details>
</div>`, "Studio", ownerName, 15);
}

// ── projects and history ───────────────────────────────────────────────────
// Projects are cards: each with its tally and the last two weeks of moves, a
// bar per day stacked by the family of the agent that made them. History is
// the timeline of merges and closures across projects, each marked in the
// family of the agent that held the task when it ended. Both are counted by
// pulse.ts from the Ledger's events; nothing is estimated.

const r1 = (n: number) => Math.round(n * 10) / 10;

// The families present, in the fixed order, with the zone the page's times are in.
function familyLegend(vendors: Vendor[], who = "You", extra = ""): string {
  const items = VENDOR_NAMES.filter(([v]) => vendors.includes(v))
    .map(([v, label]) => `<li><i style="--c:var(--m-${v})"></i>${e(v === "owner" ? who : label)}</li>`);
  return `<ul class="legend-line" aria-label="Colours">${items.join("")}${extra}<li class="meta">times in ${e(zoneLabel())}</li></ul>`;
}

const PULSE_W = 20, PULSE_BAR = 14, PULSE_H = 86, PULSE_TOP = 6, PULSE_BASE = 68;

// Two weeks of moves, one bar per day, each stacked by family with the
// owner's decisions on top; a day with nothing is a tick on the baseline.
// Every bar says in its title what it counts, and the drawing says its total.
function pulseGraph(p: Pulse): string {
  const W = PULSE_W * p.days.length;
  const peak = Math.max(1, ...p.days.map((d) => d.moves + d.decisions));
  const scale = (n: number) => (n / peak) * (PULSE_BASE - PULSE_TOP);
  const bars = p.days.map((d, i) => {
    const x = i * PULSE_W + (PULSE_W - PULSE_BAR) / 2;
    if (!d.moves && !d.decisions) return `<rect class="none" x="${x}" y="${PULSE_BASE - 2}" width="${PULSE_BAR}" height="2" rx="1"><title>${e(keyLabel(d.day, false))}: nothing recorded</title></rect>`;
    const parts: [Vendor, string, number][] = VENDOR_NAMES.filter(([v]) => v !== "owner" && d.byVendor[v]).map(([v, label]) => [v, label, d.byVendor[v]!]);
    if (d.decisions) parts.push(["owner", "you", d.decisions]);
    let y = PULSE_BASE;
    const stack = parts.map(([v, , n]) => {
      const h = Math.max(2, scale(n));
      y -= h;
      return `<rect x="${x}" y="${r1(y)}" width="${PULSE_BAR}" height="${r1(h)}" style="fill:var(--m-${v})"/>`;
    }).join("");
    const said = parts.map(([v, label, n]) => (v === "owner" ? `${plural(n, "decision")} by you` : `${n} ${label}`)).join(", ");
    return `<g><title>${e(`${keyLabel(d.day, false)}: ${plural(d.moves, "move")} (${said})`)}</title>${stack}</g>`;
  }).join("");
  const busiest = p.days.reduce((a, b) => (b.moves + b.decisions > a.moves + a.decisions ? b : a));
  const label = p.moves || p.decisions
    ? `Moves per day over the last two weeks: ${p.moves} by agents and ${plural(p.decisions, "decision")} by you, most on ${keyLabel(busiest.day, false)}`
    : "No moves in the last two weeks";
  return `<svg class="pulse-graph" viewBox="0 0 ${W} ${PULSE_H}" role="img" aria-label="${e(label)}">
    <line class="baseline" x1="0" x2="${W}" y1="${PULSE_BASE + 0.5}" y2="${PULSE_BASE + 0.5}"/>${bars}
    <text x="4" y="${PULSE_H - 3}">${e(keyLabel(p.days[0].day, false))}</text><text x="${W - 4}" y="${PULSE_H - 3}" text-anchor="end">${e(keyLabel(p.days[p.days.length - 1].day, false))}</text>
  </svg>`;
}

// `showcase` is the public showcase setting by project name, so each card
// carries the owner's control over what is published. The card's link stays
// the whole card's, so the form sits under it, outside the link.
export function renderProjects(views: ProjectView[], ownerName: string | null = null, now = new Date(), owner = DEFAULT_OWNER, showcase: Record<string, "named" | "anonymous"> = {}): string {
  const vendors = new Set<Vendor>();
  const cards = views.map(({ project, items, unavailable, events, cut }) => {
    const count = (states: string[]) => items.filter((i) => states.includes(i.state)).length;
    const p = buildPulse(events ?? [], owner, now, !!cut);
    for (const v of Object.keys(p.byVendor) as Vendor[]) vendors.add(v);
    if (p.decisions) vendors.add("owner");
    const tally = `<p class="card-tally"><span><b>${count(["claimed", "submitted", "accepted"])}</b>active</span><span><b>${count(["open"])}</b>ready to start</span><span><b>${count(["merged"])}</b>merged</span></p>`;
    const last = p.lastAt ? ` · last activity ${e(ago(p.lastAt, now))}` : "";
    const line = p.moves || p.decisions
      ? `${plural(p.moves, "move")} by ${plural(p.agents.length, "agent")} and ${plural(p.decisions, "decision")} in two weeks${p.cut ? ", from the most recent part of the record" : ""}${last}.`
      : `No moves in the last two weeks${last}.`;
    const body = unavailable
      ? '<p class="meta">Temporarily unavailable. Open to retry.</p>'
      : `${tally}${pulseGraph(p)}<p class="meta">${line}</p>`;
    const mode = showcase[project.name];
    const form = `<form method="post" action="/projects/showcase" class="show-form">
      <input type="hidden" name="project" value="${e(project.name)}">
      <label>Public showcase<select name="mode">
        <option value=""${mode ? "" : " selected"}>Not shown</option>
        <option value="anonymous"${mode === "anonymous" ? " selected" : ""}>Anonymised</option>
        <option value="named"${mode === "named" ? " selected" : ""}>Named</option>
      </select></label>
      <button class="quiet">Save</button>
    </form>`;
    return `<li class="project-card${unavailable ? " unavailable" : ""}"><a href="${href("p", project.name)}"><h2>${e(titleOf(project))}</h2>${body}</a>${form}</li>`;
  }).join("");
  return page("Projects", `<div class="page-width">
  <header><h1>Projects</h1><p class="lead">Work in motion, with a clear owner for every task. Each card counts the last ${PULSE_DAYS} days of moves, a bar per day, in the colour of the family that made them.</p></header>
  ${views.length ? familyLegend([...vendors]) : ""}
  <ul class="project-cards">${cards}</ul>
  ${!views.length ? '<div class="empty"><h2>Start with one project.</h2><p>Run <code>atelier init</code> in its local checkout. It will appear here.</p></div>' : ""}
</div>`, "Projects", ownerName);
}

// ── where a project stands ─────────────────────────────────────────────────
// Generated from the record, never written by hand: who holds what, what waits
// on the owner, what is queued, what merged last and what the last handoff
// said. The project page draws it and the JSON route returns it as it is.

export interface Standing {
  project: { name: string; title: string; repo: string };
  generatedAt: string;
  session?: SessionNote;
  live: { id: string; title: string; state: string; owner: string | null; since: string | null }[];
  waiting: { id: string; title: string; kind: InboxEntry["kind"]; kinds: InboxEntry["kind"][]; reason: string; brief: { verdict: string; line: string } | null }[];
  queued: { id: string; title: string; to: string; agent: string | null; model: string | null; by: string; at: string; note: string }[];
  merged: { id: string; title: string; at: string; commit: string | null; line: string | null }[];
  handoffs: { id: string; title: string; from: string; to: string; note: string; at: string }[];
  controlPlane: { approval: string; protected: string[]; eligible: string[]; refuseOverlap: boolean } | null;
  // Each registered check, its class, that class in words (src/checks.ts),
  // and the paths it applies to, or null when it applies to every change.
  checks: { command: string; class: CheckClass; text: string; paths: string[] | null }[];
  // What this view could not read in full, in words. Empty when it read everything it shows.
  partial: string[];
}

// How many waiting tasks get a brief, how many merges are listed, and how many
// live tasks have their own record read.
export const STANDING_BRIEFS = 12;
export const STANDING_TASKS = 40;
const STANDING_MERGES = 5;
const str = (v: unknown) => (typeof v === "string" ? v : "");

const LIVE_STATES = ["claimed", "submitted", "accepted"];

// The merged items this view lists: the last five by the time each was merged,
// which is when the item was last updated, since a merged item changes no more.
export const lastMerged = (items: Item[]) =>
  items.filter((i) => i.state === "merged").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, STANDING_MERGES);

// The tasks whose own events the view needs: every live one, up to a cap, and the last merges.
export function standingTasks(items: Item[]): string[] {
  return [...items.filter((i) => LIVE_STATES.includes(i.state)).slice(0, STANDING_TASKS), ...lastMerged(items)].map((i) => i.id);
}

// `taskEvents` holds each of those tasks' own events, newest first, at most
// `limit` of each; `details` the Ledger's detail for the waiting tasks, which
// the brief reads. Holders come from the items, since-when and handoff notes
// from the task's own events, and merges from the merged items. What an
// event window may have cut off is reported in `partial`, never guessed.
export function buildStanding(
  p: ProjectRecord, items: Item[], taskEvents: Map<string, LedgerEvent[]>, limit: number,
  inbox: InboxEntry[], details: Map<string, Detail>, now: Date,
): Standing {
  const partial: string[] = [];
  const byId = new Map(items.map((i) => [i.id, i]));
  const own = (id: string) => [...(taskEvents.get(id) ?? [])].sort((a, b) => b.seq - a.seq);
  // What is found in a task's events is right; what is not found may lie beyond them.
  const mayBeCut = (id: string) => !taskEvents.has(id) || taskEvents.get(id)!.length >= limit;
  const why = (id: string) => (taskEvents.has(id) ? `its record is longer than the last ${limit} events read` : "its record was not read here");
  const liveItems = items.filter((i) => LIVE_STATES.includes(i.state));

  const live = liveItems.map((i) => {
    // Since when someone holds a task: the claim or handoff that made them the holder.
    const made = own(i.id).find((ev) => ev.kind === "item.claimed" || (ev.kind === "item.handoff" && ev.data.to === i.owner));
    if (!made) partial.push(`${i.id}: when it was taken is not shown, because ${why(i.id)}.`);
    return { id: i.id, title: i.title, state: i.state, owner: i.owner, since: made?.at ?? null };
  });

  // One line per waiting task: the inbox's own kind and reasons, which are what
  // the owner must act on, and the brief's verdict after them.
  const groups = new Map<string, InboxEntry[]>();
  for (const x of [...inbox].sort((a, b) => b.weight - a.weight)) {
    if (x.kind !== "failing" && byId.has(x.itemId)) groups.set(x.itemId, [...(groups.get(x.itemId) ?? []), x]);
  }
  const waiting = [...groups.entries()].map(([id, entries], n) => {
    const d = n < STANDING_BRIEFS ? details.get(id) : undefined;
    const b = d ? briefFor(d, d.events) : null;
    return {
      id, title: byId.get(id)!.title, kind: entries[0].kind, kinds: entries.map((x) => x.kind), reason: entries.map((x) => x.reason).join("; "),
      brief: b ? { verdict: b.recommendation.verdict, line: b.recommendation.reason } : null,
    };
  });

  const merged = lastMerged(items).map((i) => {
    const events = own(i.id), ev = events.find((x) => x.kind === "item.merged");
    const said = submission(events, i.id, str(ev?.data.head) || i.acceptedHead);
    if (!said && mayBeCut(i.id)) partial.push(`${i.id}: its summary may be missing, because ${why(i.id)}.`);
    return { id: i.id, title: i.title, at: ev?.at ?? i.updatedAt, commit: str(ev?.data.mergeCommit) || null, line: said?.summary ?? null };
  });

  const handoffs = liveItems.flatMap((i) => {
    const h = own(i.id).find((ev) => ev.kind === "item.handoff" && str(ev.data.note).trim());
    if (!h && mayBeCut(i.id)) partial.push(`${i.id}: an older handoff note may exist, because ${why(i.id)}.`);
    return h ? [{ id: i.id, title: i.title, from: str(h.data.from), to: str(h.data.to), note: str(h.data.note).trim(), at: h.at }] : [];
  });

  return {
    project: { name: p.name, title: titleOf(p), repo: p.repo },
    generatedAt: now.toISOString(),
    live, waiting,
    queued: items.filter((i) => i.state === "open" && !i.owner && i.dispatch).map((i) => ({
      id: i.id, title: i.title, to: i.dispatch!.to, agent: i.dispatch!.agent ?? null, model: i.dispatch!.model ?? null, by: i.dispatch!.by, at: i.dispatch!.at, note: i.dispatch!.note ?? "",
    })),
    merged, handoffs,
    // A project governed by ControlPlane carries the owner's recorded approval.
    controlPlane: p.policy.approval
      ? { approval: p.policy.approval, protected: p.policy.protected, eligible: p.policy.eligible ?? [], refuseOverlap: !!p.policy.refuseOverlap }
      : null,
    checks: checkClasses(p.policy).map((v) => ({ command: v.command, class: v.class, text: classText(v), paths: p.policy.checkPaths?.find((c) => c.command === v.command)?.paths ?? null })),
    partial,
  };
}

function standingSection(p: ProjectRecord, s: Standing): string {
  const link = (id: string) => `<a href="${href("p", p.name, id)}">${e(id)}</a>`;
  const group = (title: string, rows: string[]) => rows.length ? `<h3>${e(title)}</h3><ul class="standing-list">${rows.join("")}</ul>` : "";
  const runner = (q: Standing["queued"][number]) => `${q.to}${q.agent ? ` ${q.agent}` : ""}${q.model ? `/${q.model}` : ""}`;
  const groups = [
    group("Held now", s.live.map((i) => `<li>${link(i.id)} <strong>${e(i.title)}</strong><span class="meta">${e(stateLabel[i.state as Item["state"]] ?? i.state)} · held by ${e(i.owner ?? "nobody")}${i.since ? ` since ${e(when(i.since))}` : ", since when is not shown"}</span></li>`)),
    group("Waiting on the owner", s.waiting.map((w) => `<li>${link(w.id)} <strong>${e(w.title)}</strong>${tag(KIND[w.kind][0], KIND[w.kind][1])}<span class="meta">${e(w.reason)}${w.brief ? ` · brief, ${e(w.brief.verdict)}: ${e(w.brief.line)}` : ""}</span></li>`)),
    group("Queued for a runner", s.queued.map((q) => `<li>${link(q.id)} <strong>${e(q.title)}</strong><span class="meta">for ${e(runner(q))} · sent by ${e(q.by)} ${e(when(q.at))}${q.note ? ` · ${e(q.note)}` : ""}</span></li>`)),
    group("Last merges", s.merged.map((m) => `<li>${link(m.id)} <strong>${e(m.title)}</strong><span class="meta">${e(when(m.at))}${m.commit ? ` · <code>${e(m.commit.slice(0, 8))}</code>` : ""}${m.line ? ` · ${e(m.line)}` : ""}</span></li>`)),
    group("Handoff notes", s.handoffs.map((h) => `<li>${link(h.id)} <strong>${e(h.title)}</strong><span class="meta">${e(h.from || "?")} to ${e(h.to || "?")}, ${e(when(h.at))}: ${e(h.note)}</span></li>`)),
  ].join("");
  const cp = s.controlPlane
    ? `<p class="meta standing-policy">ControlPlane policy, approved: ${e(s.controlPlane.approval)}. Protected areas: ${s.controlPlane.protected.map(e).join(", ") || "none"}. Eligible agents: ${s.controlPlane.eligible.map(e).join(", ") || "any"}. Overlapping claims: ${s.controlPlane.refuseOverlap ? "refused" : "flagged"}.</p>`
    : "";
  return `<section class="standing" id="standing" aria-label="Where it stands">
  <h2 class="section-title">Where it stands</h2>
  <p class="meta">Generated from Atelier's record as of ${e(when(s.generatedAt))}. <code>atelier status --project ${e(p.name)}</code> prints the same as text; ${e(`/api/projects/${p.name}/standing`)} returns it as JSON.</p>
  ${s.partial.length ? `<div class="notice" role="status"><h3>Part of this record is not shown</h3><ul>${s.partial.map((x) => `<li>${e(x)}</li>`).join("")}</ul></div>` : ""}
  ${groups || '<p class="empty">Nothing is held, waiting, queued or recently merged.</p>'}
  ${s.session ? `<h3>Newest session</h3>${sessionNoteText(s.session).split("\n").map((line) => `<p class="meta">${e(line)}</p>`).join("")}` : ""}
  ${cp}
</section>`;
}

function taskRows(p: ProjectRecord, items: Item[]): string {
  return `<ul class="task-list">${items.map((i) => `<li><a href="${href("p", p.name, i.id)}">
    <span><strong>${e(i.title)}</strong><span class="meta">${e(i.id)} · ${e(i.owner ?? "No current owner")}</span></span>
    ${tag(stateLabel[i.state], i.state === "merged" ? "go" : "")}<time class="meta">${when(i.updatedAt)}</time>${icon("arrow")}</a></li>`).join("")}</ul>`;
}

// `actions` is the protected-actions section, drawn by src/actions-page.ts.
export function renderProject(p: ProjectRecord, items: Item[], events: LedgerEvent[], ownerName: string | null = null, standing?: Standing, actions = ""): string {
  const closed = (i: Item) => i.state === "merged" || i.state === "abandoned";
  const live = items.filter((i) => !closed(i));
  const done = items.filter(closed);
  const policy = `<dl>
    <dt>Required checks</dt><dd>${checkClasses(p.policy).map((v) => `<code>${e(v.command)}</code> <span class="meta">${e(classText(v))}${p.policy.checkPaths?.some((c) => c.command === v.command) ? `; ${e(appliesText(p.policy, v.command))}` : ""}</span>`).join("<br>") || "None configured"}</dd>
    <dt>Protected files</dt><dd>${p.policy.protected.map(e).join(", ") || "None configured"}</dd>
    <dt>Check execution</dt><dd>${p.policy.sandboxOnly ? "Only checks run in a Cloudflare container count" : "Checks count from a Cloudflare container or the agent's machine"}</dd>
    <dt>Eligible agents</dt><dd>${p.policy.eligible?.map(e).join(", ") || "Any agent"}</dd>
    <dt>Overlap</dt><dd>${p.policy.refuseOverlap ? "Refused" : "Flagged for review"}</dd>
    <dt>Baseline</dt><dd><code>${e(p.repo)}</code></dd>
  </dl>`;
  return page(titleOf(p), `<div class="page-width">
  <nav class="breadcrumbs"><a href="/projects">Projects</a> / ${e(titleOf(p))}</nav>
  <header><h1>${e(titleOf(p))}</h1><p class="lead">${live.length} active or planned task${live.length === 1 ? "" : "s"}.</p>
  <nav class="repo-tabs" aria-label="Repository"><a href="${href("p", p.name, "code")}">Code</a><a href="${href("p", p.name, "log")}">Log</a></nav></header>
  ${standing ? standingSection(p, standing) : ""}
  <details class="new-task"><summary>Create a task</summary>
    <form method="post" action="${href("ui", p.name, "new")}" class="stack">
      <label>What should change?<input name="title" type="text" required maxlength="300" placeholder="Describe the outcome"></label>
      <label>Files in scope<input name="scope" type="text" placeholder="src/**, test/**"></label>
      <p class="meta">Separate patterns with commas. Leave empty for unrestricted scope.</p>
      <button class="primary">Create task</button>
    </form>
  </details>
  <h2 class="section-title">Work</h2>
  ${live.length ? taskRows(p, live) : '<p class="empty">No active tasks. Create one above.</p>'}
  ${done.length ? `<details class="disclosure"><summary>Completed and closed · ${done.length}</summary>${taskRows(p, done)}</details>` : ""}
  ${actions}
  <details class="disclosure"><summary>Project policy</summary>${policy}</details>
  <details class="disclosure"><summary>Activity</summary>${eventTable(events, true)}</details>
</div>`, "Projects", ownerName);
}

export function renderHistory(views: ProjectView[], ownerName: string | null = null, owner = DEFAULT_OWNER): string {
  const entries = buildTimeline(views.map((v) => ({ project: v.project, items: v.items, events: v.events ?? [] })), owner);
  const merged = entries.filter((x) => x.ending === "merged").length, closed = entries.length - merged;
  const projects = new Set(entries.map((x) => x.project.name)).size;
  const vendors = [...new Set(entries.map((x) => x.vendor).filter((v): v is Vendor => v !== null))];
  const days = byDay(entries).map(({ day, entries: list }) => `<li class="timeline-day"><h2>${e(`${weekdayOf(list[0].at)} ${keyLabel(day, true)}`)}</h2><ol>${list.map((x) => {
    const model = x.holder ? splitActor(x.holder).model || x.holder : null;
    const mark = x.vendor
      ? `<i class="family-mark" style="--c:var(--m-${x.vendor})" title="${e(`${x.ending} while held by ${x.holder}`)}"></i>`
      : '<i class="family-mark unknown" title="who held it is not in the record read"></i>';
    const detail = [titleOf(x.project), x.item.id, model ?? "holder not in the record read", x.ending === "merged" ? (x.commit ? `merged as ${x.commit.slice(0, 8)}` : "merged") : "closed without merging"];
    return `<li class="merge-row ${x.ending}"><a href="${href("p", x.project.name, x.item.id)}">${mark}<time datetime="${e(x.at)}">${e(clock(x.at))}</time><span><strong>${e(x.item.title)}</strong><span class="meta">${detail.map(e).join(" · ")}</span></span>${tag(x.ending === "merged" ? "Merged" : "Closed", x.ending === "merged" ? "go" : "")}</a></li>`;
  }).join("")}</ol></li>`).join("");
  const lead = entries.length
    ? `${plural(merged, "task")} merged and ${closed} closed across ${plural(projects, "project")}, newest first. Each mark is the family of the agent that held the task when it ended.`
    : "Finished work, with its evidence intact.";
  const capKey = closed ? '<li><i class="cap-key"></i>closed without merging</li>' : "";
  return page("History", `<div class="page-width">
  <header><h1>History</h1><p class="lead">${lead}</p></header>
  ${views.some((v) => v.unavailable) ? '<p class="error">Some project history is unavailable. Refresh to retry.</p>' : ""}
  ${entries.length ? familyLegend(vendors, "You", capKey) : ""}
  <ol class="merge-timeline">${days}</ol>
  ${!entries.length ? '<p class="empty">Completed tasks will appear here after they merge or close.</p>' : ""}
</div>`, "History", ownerName);
}

function eventTable(events: LedgerEvent[], withItem = false): string {
  if (!events.length) return '<p class="empty">No activity recorded yet.</p>';
  return `<ol class="timeline">${events.map((v) => `<li><span class="timeline-dot"></span><div>
    <strong>${e(v.kind.replaceAll(".", " ").replaceAll("_", " "))}</strong>${withItem && v.itemId ? ` · ${e(v.itemId)}` : ""}
    <p class="meta">${e(v.actor)}${v.proved ? " · token proved" : ""} · ${when(v.at)}</p>
    <details><summary>Details</summary><pre>${e(JSON.stringify(v.data, null, 2))}</pre></details></div></li>`).join("")}</ol>`;
}

// ── a task ─────────────────────────────────────────────────────────────────

export function renderItem(p: ProjectRecord, d: Detail, ownerName: string | null = null, diff: ItemDiff | "unavailable" | null = null, live?: Live): string {
  const closed = d.item.state === "merged" || d.item.state === "abandoned";
  return page(d.item.title, `<div class="page-width">
  <nav class="breadcrumbs"><a href="/decisions">Decisions</a> / <a href="${href("p", p.name)}">${e(titleOf(p))}</a> / ${e(d.item.id)}</nav>
  <article class="review-sheet standalone" id="review">${reviewBody({ project: p, detail: d, diff, thread: true })}</article>
</div>`, closed ? "History" : "Decisions", ownerName, 0, true, live);
}

const VERDICT_TONE: Record<Verdict, string> = { accept: "go", merge: "go", review: "ask", wait: "ask", decide: "ask", "send back": "bad", none: "" };

// The brief sits above the diff: what is decided, what the agent said, what the
// record shows, and what it points to.
function briefBlock(d: Detail): string {
  if (!["claimed", "submitted", "accepted", "blocked"].includes(d.item.state)) return "";
  const b = briefFor(d, d.events);
  const said = submission(d.events, d.item.id, d.item.head);
  const summary = said
    ? `<div class="review-note"><p>“${e(said.summary)}”</p><p class="meta">Summary from ${e(said.by)}, not verified</p></div>`
    : "";
  return `<section class="review-section brief" id="brief" aria-label="Decision brief">
  <h3>${e(b.decided)}</h3>
  ${summary}
  ${b.evidence.length ? `<p class="section-title">What the evidence shows</p><ul>${b.evidence.map((l) => `<li>${e(l)}</li>`).join("")}</ul>` : ""}
  <p class="section-title">Recommendation</p>
  <p>${tag(b.recommendation.verdict, VERDICT_TONE[b.recommendation.verdict])} ${e(b.recommendation.reason)}</p>
</section>`;
}

// The task page's thread, full width on a time axis, with the brief's one line
// beside its head. It scrolls inside its own box on a narrow screen.
function threadBlock(p: ProjectRecord, d: Detail): string {
  const story = taskStory(p.name, d);
  if (!story) return "";
  const owner = d.ownerActor ?? DEFAULT_OWNER;
  const b = ["claimed", "submitted", "accepted", "blocked"].includes(d.item.state) ? briefFor(d, d.events) : null;
  const note = b ? { verdict: b.recommendation.verdict, tone: VERDICT_TONE[b.recommendation.verdict] as "go" | "ask" | "bad", text: b.recommendation.reason } : undefined;
  return `<section class="review-section task-thread" id="thread" aria-label="This task's thread">
  <h3>Thread</h3>
  ${legendLine(Object.keys(story.tally.byVendor) as Vendor[], story.tally.localRuns > 0)}
  <div class="stage-scroll">${drawStory(story, owner, { replaySeconds: 0, ...(note ? { note } : {}) })}</div>
</section>`;
}

const shell = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

function reviewBody({ project: p, detail: d, diff, thread }: ReviewContext): string {
  const { item, gate } = d;
  const view = evidenceAt(d.policy, d.evidence, item.head);
  const decision = decisionFor(item, d.policy, d.evidence, d.reviews, d.ownerActor);
  const live = item.state === "claimed" || item.state === "submitted";
  const action = (verb: string) => href("ui", p.name, item.id, verb);
  const revision = `<input type="hidden" name="head" value="${e(item.head ?? "")}">`;
  const evidenceVisible = !!diff && diff !== "unavailable" && diff.head === item.head;
  // The checks on the would-be merge, read against main's head as the
  // preview read it, so a run main has moved past is marked stale.
  const mergedChecks = diff && diff !== "unavailable" && diff.main ? mergedChecksAt(d.policy, d.evidence, item.head, diff.main.head) : undefined;

  const reject = live && item.head
    ? `<details class="request-changes"><summary>Request changes</summary>
      <form class="stack" method="post" action="${action("reject")}">${revision}
        <label>What needs to change?<textarea name="note" required rows="3" maxlength="2000"></textarea></label>
        <button>Send review</button>
      </form></details>`
    : "";
  const evidenceNotice = live && item.head && !evidenceVisible
    ? `<div class="notice" role="status"><h3>${diff && diff !== "unavailable" ? "The displayed revision has changed" : "Changes are unavailable"}</h3>
      <p>Approval and acceptance are unavailable until the displayed changes match this task’s recorded revision. <a href="${href("p", p.name, item.id)}">Reload this task</a>. If the revision changed, the task owner should run <code>atelier push</code> and rerun checks.</p></div>`
    : "";
  const reviewWanted = decision.action === "review" || latestReviews(d.reviews, item.head).some((r) => !r.approve);
  const approve = evidenceVisible && live && item.head && reviewWanted
    ? `<form method="post" action="${action("approve")}">${revision}<button class="primary">Approve revision</button></form>`
    : "";
  const accept = evidenceVisible && decision.action === "accept"
    ? `<form method="post" action="${action("accept")}">${revision}<button class="primary">Accept revision</button></form>`
    : "";
  // The owner's override, offered only while the missing independent review
  // is the one thing blocking this revision, since it waives that and nothing
  // else. Its reason is required and recorded.
  const overridable = evidenceVisible && item.state === "submitted" && !!item.head && gate.needsAssessor && gate.blockers.length === 1;
  const override = overridable
    ? `<details class="request-changes"><summary>Accept without an independent review</summary>
      <form class="stack" method="post" action="${action("override")}">${revision}
        <label>Why is no independent review possible?<textarea name="note" required rows="3" maxlength="${OVERRIDE_REASON_MAX}"></textarea></label>
        <p class="meta">This records your override and its reason on the task and in the inbox, and accepts the revision. It is not a review.</p>
        <button>Override the review and accept</button>
      </form></details>`
    : "";
  const merge = decision.action === "merge"
    ? `<div class="merge-command"><p>In the registered checkout, run:</p>
      <pre tabindex="0">${e(`atelier merge ${item.id} --project ${shell(p.name)} --head ${item.acceptedHead}`)}</pre>
      <p class="meta">This merges the approved revision and records the result. It does not deploy.</p></div>`
    : "";
  // An accepted revision can be accepted again: the acceptance records the
  // policy it was made under, and a merge refused because that policy changed
  // since asks for a new one, made under the policy as it is now. The gate
  // runs again before anything is recorded.
  const reaccept = evidenceVisible && item.state === "accepted" && item.head === item.acceptedHead
    ? `<details class="request-changes"><summary>Accept again under the current policy</summary>
      <form class="stack" method="post" action="${action("accept")}">${revision}
        <p class="meta">For a merge refused because the project's protected paths, eligible agents, overlap rule or checks changed since this acceptance: checks the gate again under the policy as it is now and records a new acceptance of this revision.</p>
        <button>Accept this revision again</button>
      </form></details>`
    : "";

  // An open task can be sent to a runner; a queued one shows who it waits for.
  const dispatchBox = item.state === "open" && !item.owner
    ? item.dispatch
      ? `<div class="notice" role="status"><h3>Waiting for ${e(describeDispatch(item.dispatch))}</h3>
        <p>Sent by ${e(item.dispatch.by)} ${when(item.dispatch.at)}${item.dispatch.note ? `: ${e(item.dispatch.note)}` : ""}. The first matching runner to ask for work claims it.</p>
        <form method="post" action="${action("undispatch")}">${revision}<button>Withdraw</button></form></div>`
      : `<details class="request-changes dispatch-form"><summary>Send to an agent</summary>
        <form class="stack" method="post" action="${action("dispatch")}">${revision}
          <label>Where<select name="to"><option value="any">Any runner</option><option value="home">Home runner (your Macs and the Studio)</option><option value="cloud">Cloud runner</option></select></label>
          <label>Agent<select name="agent"><option value="">Runner's choice</option><option value="claude-code">Claude Code</option><option value="codex">Codex</option><option value="zcode">ZCode (GLM)</option><option value="opencode">OpenCode (local models)</option><option value="antigravity">Antigravity (Gemini)</option><option value="gemini-cli">Gemini CLI</option></select></label>
          <label>Model <span class="meta">optional, as the runner names it</span><input type="text" name="model" placeholder="e.g. glm-5.3-flash"></label>
          <label>Note for the agent <span class="meta">optional</span><input type="text" name="note" maxlength="500"></label>
          <button class="primary">Send</button>
        </form></details>`
    : "";

  // A blocked task shows who blocked it, why, and the one way on; any task
  // that is waiting, in progress or in review offers the block form.
  const blockBox = item.state === "blocked" && item.blocked
    ? `<div class="notice" role="status"><h3>Blocked by ${e(item.blocked.by)} ${when(item.blocked.at)}</h3>
        <p>${e(item.blocked.reason)}</p>
        <p class="meta">It keeps its owner and workspace, is skipped by runners and stuck detection, and cannot be pushed or submitted. Unblocking returns it to ${e(stateLabel[item.blocked.from].toLowerCase())}.</p>
        <form method="post" action="${action("unblock")}">${revision}<button class="primary">Unblock</button></form></div>`
    : live || item.state === "open"
      ? `<details class="request-changes"><summary>Block this task</summary>
        <form class="stack" method="post" action="${action("block")}">${revision}
          <label>What is it waiting on?<textarea name="note" required rows="2" maxlength="${REASON_MAX}"></textarea></label>
          <p class="meta">The task keeps its owner and workspace, leaves the runner queue and stuck detection, and cannot be submitted until it is unblocked.</p>
          <button>Block</button>
        </form></details>`
      : "";

  const header = `<header class="review-header">
  <p class="context">${e(titleOf(p))} · ${e(item.id)} · ${e(stateLabel[item.state])}</p>
  <h2>${e(item.title)}</h2>
  <p class="review-description">${e(decision.detail)}</p>
  <p class="decision-status ${decision.tone}">${trustLine(view.checks)}<strong>${e(decision.title)}</strong></p>
  ${evidenceNotice}
  <div class="actions">${approve}${accept}${override}${reject}${dispatchBox}${blockBox}</div>
  ${merge}${reaccept}
  <p class="meta revision">Revision <code>${short(item.head)}</code>${item.owner ? ` · ${e(item.owner)}` : ""}</p>
</header>`;

  // The owner's framing, set with atelier new or atelier edit: shown only
  // when any of it is set, above the brief, where an agent or reviewer reads first.
  const list = (entries: string[]) => `<ul>${entries.map((x) => `<li>${e(x)}</li>`).join("")}</ul>`;
  const framing = item.nonGoals?.length || item.stopWhen?.length || item.nextGate
    ? `<section class="review-section framing" id="framing" aria-label="How the task is framed"><h3>Framing</h3><dl>
    ${item.nonGoals?.length ? `<dt>Non-goals</dt><dd>${list(item.nonGoals)}</dd>` : ""}
    ${item.stopWhen?.length ? `<dt>Stop when</dt><dd>${list(item.stopWhen)}</dd>` : ""}
    ${item.nextGate ? `<dt>Next gate</dt><dd>${e(item.nextGate)}</dd>` : ""}
  </dl></section>`
    : "";

  const scope = gate.outOfScope.length
    ? `<details class="notice"><summary>Scope changed · ${gate.outOfScope.length} file${gate.outOfScope.length === 1 ? "" : "s"}</summary>
      <p>These changes extend beyond the original task scope. Include them in your review.</p>
      <ul>${gate.outOfScope.map((f) => `<li><code>${e(f)}</code></li>`).join("")}</ul></details>`
    : "";
  const protectedNote = gate.needsAssessor
    ? `<div class="notice"><h3>${gate.changeClass === "coordinated" ? "Coordinated change" : "Protected change"}</h3><p>${e(gate.requirement ? `${gate.requirement}.` : "These files affect protected behavior and need an approval from a model of another family than every contributor.")} Your own approval does not count as that review.</p></div>`
    : "";

  // The head's own runs: a merged check ran on another tree and is shown
  // beside the merge preview instead.
  const checkRows = view.checks.map((c) => {
    const last = d.evidence
      .filter((x) => x.head === item.head && x.claim === c.claim && x.grade === "observed" && !x.merged && !x.notApplicable && (!d.policy.sandboxOnly || x.where === "sandbox"))
      .sort((a, b) => a.at.localeCompare(b.at))
      .pop();
    const status = c.grade === "pending" ? tag("Waiting", "ask") : c.passed ? tag("Passed", "go") : tag("Failed", "bad");
    const where = c.grade === "observed" ? whereChip(c.where) : "";
    const uncounted = !last && d.policy.sandboxOnly && d.evidence.some((x) => x.head === item.head && x.claim === c.claim && x.grade === "observed" && !x.merged && x.where !== "sandbox");
    const detail = last
      ? `${e(last.by)} · ${e(WHERE[last.where ?? "runner"][0])} · ${when(last.at)}`
      : uncounted
        ? "This check ran on the agent's machine, which does not count for this project. Run <code>atelier check --sandbox</code> to run it in a Cloudflare container."
        : "The task owner must run this required check.";
    return `<details class="check-row"${c.passed === false ? " open" : ""}>
      <summary>${status}<code>${e(c.claim)}</code>${where}</summary>
      <p class="meta">${detail}</p>${last?.outputTail ? `<pre tabindex="0">${e(last.outputTail)}</pre>` : ""}</details>`;
  }).join("");
  // A check whose paths this revision does not touch is shown, and never blocks.
  const notApplicableRows = view.notApplicable.map((claim) => {
    const last = d.evidence.filter((x) => x.head === item.head && x.claim === claim && x.notApplicable).sort((a, b) => a.at.localeCompare(b.at)).pop();
    return `<details class="check-row">
      <summary>${tag("Not applicable")}<code>${e(claim)}</code></summary>
      <p class="meta">This check ${e(appliesText(d.policy, claim))}, and this revision touches none of those paths.${last ? ` Recorded by ${e(last.by)} · ${e(WHERE[last.where ?? "runner"][0])} · ${when(last.at)}` : ""}</p></details>`;
  }).join("");
  const reports = view.reports.length
    ? `<details class="disclosure"><summary>Reported by agents · ${view.reports.length}</summary>
      <p class="meta">Reported, not verified; these never satisfy a required check.</p>
      ${view.reports.map((r) => `<p>${tag("Reported")} ${e(r.claim)} <span class="meta">${e(r.by)}</span></p>`).join("")}</details>`
    : "";
  const reviews = latestReviews(d.reviews, item.head).map((r) => `<div class="review-note">${tag(r.approve ? "Approved" : "Changes requested", r.approve ? "go" : "ask")}
    <p>${e(r.note || "No note provided.")}</p><p class="meta">${e(r.by)} · ${when(r.at)}</p></div>`).join("");
  const overridden = overrideAt(item, d.ownerActor ?? DEFAULT_OWNER);
  const overrideNote = overridden
    ? `<div class="review-note">${tag("Review overridden", "ask")}
    <p>${e(overridden.reason)}</p><p class="meta">${e(overridden.by)} · ${when(overridden.at)} · the project owner's override, not a review</p></div>`
    : "";
  const blockers = live && !gate.ready
    ? `<details class="disclosure"><summary>Readiness details</summary><ul>${gate.blockers.map((b) => `<li>${e(b)}</li>`).join("")}</ul></details>`
    : "";

  const technical = `<dl>
    <dt>Workspace</dt><dd><code>${e(item.fork ?? "Not created")}</code></dd>
    <dt>Forked at</dt><dd><code>${short(item.base)}</code></dd>
    <dt>Scope</dt><dd>${item.scope.map(e).join(", ") || "Unrestricted"}</dd>
    <dt>Last push</dt><dd>${when(item.lastPushAt)}</dd>
  </dl>`;
  const ownership = live
    ? `<form class="stack" method="post" action="${action("handoff")}">${revision}
        <label>New owner<input type="text" name="to" required placeholder="harness/model"></label>
        <label>Handoff note<input type="text" name="note"></label>
        <button>Hand off task</button></form>
      <form method="post" action="${action("release")}">${revision}<button>Release task</button></form>`
    : "";
  const close = item.state !== "merged" && item.state !== "abandoned"
    ? `<form class="stack" method="post" action="${action("abandon")}">${revision}
        <label>Reason for closing<input type="text" name="note" required></label>
        <button class="danger">Close task without merging</button></form>`
    : "";

  return `${header}
${framing}${thread ? threadBlock(p, d) : ""}${briefBlock(d)}
<nav class="review-nav" aria-label="In this review"><a href="#changes">Changes</a><a href="#checks">Checks</a><a href="#history">History</a>${item.fork ? `<a href="${href("p", p.name, item.id, "code")}">Browse the fork</a><a href="${href("p", p.name, item.id, "log")}">Its log</a>` : ""}</nav>
<section id="changes" class="review-section"><h3>Changes</h3>${renderDiff(diff, item.head, mergedChecks)}${scope}${protectedNote}</section>
<section id="checks" class="review-section"><h3>Checks and reviews</h3>
  <p class="meta">${view.checks.length ? `${decision.passed} of ${view.checks.length} required checks passed at this revision.` : view.notApplicable.length ? "No required check applies to this revision." : "This project requires no checks."}${view.checks.length && view.notApplicable.length ? ` ${view.notApplicable.length} more ${view.notApplicable.length === 1 ? "does" : "do"} not apply to it.` : ""}${d.policy.sandboxOnly ? " Only checks run in a Cloudflare container count for this project." : ""}</p>
  ${checkRows}${notApplicableRows}${reports}${reviews}${overrideNote}${blockers}
</section>
<details class="disclosure" id="history"><summary>Task history</summary>${eventTable(d.events)}</details>
<details class="disclosure"><summary>Technical details${live ? " and ownership" : ""}</summary>${technical}${ownership}${close}</details>`;
}

export function renderError(message: string, back = "/"): string {
  return page("Action needs attention", `<section class="page-width error-page">
  <h1>Let’s resolve this.</h1><p class="lead" role="alert">${e(message)}</p>
  <p>Return to the current task, refresh its evidence, and try the available action again.</p>
  <a class="button" href="${e(back)}">Return to work</a>
</section>`);
}

// ── diffs ──────────────────────────────────────────────────────────────────

const STATUS: Record<FileChange["status"], [string, string]> = {
  added: ["Added", "go"],
  deleted: ["Deleted", "bad"],
  modified: ["Modified", "signal"],
  mode: ["Mode", ""],
  binary: ["Binary", ""],
  "too-large": ["Too large", "ask"],
  submodule: ["Submodule", ""],
};

// Each line keeps its +, - or space, so the diff reads without colour.
export function renderFile(f: FileChange, open: boolean): string {
  const [label, tone] = STATUS[f.status];
  const counts = f.added || f.removed ? `<span class="counts">+${f.added} −${f.removed}</span>` : "";
  const note = f.status === "binary" ? "Binary file; not shown."
    : f.status === "too-large" ? "Too large to diff here; use <code>atelier diff</code>."
    : f.status === "mode" ? "Only the file mode changed."
    : f.status === "submodule" ? "A submodule: the commit it points to changed. Its contents are in another repository." : "";
  const body = f.hunks.length
    ? `<pre class="diff" tabindex="0">${f.hunks.map((h) =>
        `<span class="hunk">@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@</span>` +
        h.lines.map((l) => `<span class="${l.op === "+" ? "add" : l.op === "-" ? "del" : ""}">${l.op}${e(l.text)}</span>`).join("")).join("")}</pre>`
    : note ? `<p class="meta file-note">${note}</p>` : "";
  return `<details class="file"${open ? " open" : ""}><summary><span class="tag ${tone}">${label}</span><code>${e(f.path)}</code>${counts}</summary>${body}</details>`;
}

function renderDiff(diff: ItemDiff | "unavailable" | null, recordedHead: string | null, merged?: MergedCheckView): string {
  if (diff === "unavailable") return `<p class="empty">The diff could not be read from Artifacts just now. <code>atelier diff</code> shows it from a clean clone.</p>`;
  if (!diff) return `<p class="empty">No workspace yet, so nothing to compare.</p>`;
  if (!diff.files.length) return `<p class="empty">No changes: the workspace at <span class="mono">${short(diff.head)}</span> holds the same tree as main at <span class="mono">${short(diff.base)}</span>.</p>`;
  const added = diff.files.reduce((n, f) => n + f.added, 0);
  const removed = diff.files.reduce((n, f) => n + f.removed, 0);
  const moved = recordedHead && recordedHead !== diff.head
    ? `<p>${tag("Unrecorded", "ask")} Artifacts holds <span class="mono">${short(diff.head)}</span>, newer than the recorded head <span class="mono">${short(recordedHead)}</span>; the owner has pushed without running <code>atelier push</code>.</p>`
    : "";
  // The diff is against main as it is now, so a workspace behind main shows
  // main's newer changes too, as reversals; the preview beneath says how far
  // main has moved, and the note says what that means for the list.
  const summary = `${diff.files.length}${diff.truncated ? "+" : ""} file${diff.files.length === 1 ? "" : "s"} differ from main at <span class="mono">${short(diff.base)}</span>, +${added} −${removed}, at the workspace's <span class="mono">${short(diff.head)}</span>.`;
  const behind = diff.main && diff.main.ahead > 0
    ? ` Paths main changed since this task forked, and the workspace has not taken, are listed here as the workspace's changes until <code>atelier update</code> brings them in.`
    : "";
  return `${moved}<p class="meta">${summary}${behind}${diff.truncated ? " Only the first files are listed; <code>atelier diff</code> shows the rest." : ""}</p>
${renderMainPreview(diff.main, merged)}
${diff.files.map((f) => renderFile(f, diff.files.length <= 8)).join("")}`;
}

// Whether the task would merge into main as main is now, with the checks run
// on that merge beside it. Read only; the merge itself is still made by
// atelier merge.
export function renderMainPreview(m: MainPreview | null | undefined, merged?: MergedCheckView): string {
  if (m === undefined) return "";
  if (m === null) return `<p class="meta">Whether this merges cleanly into main could not be read just now.</p>`;
  const plural = (n: number, w: string) => `${n.toLocaleString("en")} ${w}${n === 1 ? "" : "s"}`;
  if (m.ahead === 0) return `<p class="merge-preview">${tag("Up to date", "go")} Main has not moved since this task forked; it merges as it is.</p>${renderMergedChecks(merged, m, false)}`;
  const moved = `Main has moved ${m.aheadCapped ? "at least " : ""}${plural(m.ahead, "commit")} along its first-parent line since this task forked (a merge counts once), changing ${plural(m.merge.ours, "path")}`;
  if (m.merge.clean) {
    const shared = m.merge.both.length ? `; both sides changed ${plural(m.merge.both.length, "path")}, and the changes do not overlap` : "; none of them are paths this task changed";
    return `<p class="merge-preview">${tag("Merges cleanly", "go")} ${moved}${shared}.</p>${renderMergedChecks(merged, m, true)}`;
  }
  const rows = m.merge.conflicts.map((c) => `<li><code>${e(c.path)}</code> <span class="meta">${e(c.reason)}</span></li>`).join("");
  return `<div class="merge-preview">${tag(plural(m.merge.conflicts.length, "conflict"), "bad")} ${moved}. Merging now would stop at:<ul class="merge-conflicts">${rows}</ul><p class="meta">Bring main into the task's workspace and resolve these before accepting.</p></div>${renderMergedChecks(merged, m, false)}`;
}

// The required checks run on the would-be merge: each one's latest run at
// this revision, with the main head it merged with, marked stale once main
// has moved past it. A merged check is shown, never required, except that a
// failing one blocks acceptance when main moved after the revision's own
// checks passed (see mergedBlockers in src/rules.ts), until a merged run
// passes or the head moves; a later run of the revision's own checks does
// not clear it. The readiness details then say so. `offer` names the command when no run exists yet and
// main has moved, where the revision's own checks say nothing about the merge.
function renderMergedChecks(merged: MergedCheckView | undefined, m: MainPreview, offer: boolean): string {
  if (!merged || !merged.checks.length) return "";
  if (!merged.run) {
    return offer
      ? `<p class="meta merge-checks">Checks on the merge: not run. <code>atelier check --merged</code> runs the required checks on the merge of this revision with main at <code>${short(m.head)}</code>, locally or with <code>--sandbox</code>.</p>`
      : "";
  }
  const rows = merged.checks.map((c) => {
    if (c.grade === "pending") return `<li>${tag("Not run", "ask")}<code>${e(c.claim)}</code></li>`;
    const status = c.passed ? tag("Passed", "go") : tag("Failed", "bad");
    const stale = c.stale ? ` ${tag("Stale", "ask")}<span class="meta">main is now at <code>${short(m.head)}</code>; run <code>atelier check --merged</code> again</span>` : "";
    return `<li>${status}<code>${e(c.claim)}</code>${whereChip(c.where)}<span class="meta">with main at <code>${short(c.mainHead ?? null)}</code>${c.by ? ` · ${e(c.by)}` : ""}${c.at ? ` · ${when(c.at)}` : ""}</span>${stale}</li>`;
  }).join("");
  return `<div class="merge-checks"><p class="meta">Checks on the merge with main, at this revision:</p><ul class="merge-check-rows">${rows}</ul></div>`;
}
