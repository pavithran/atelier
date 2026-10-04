// Server-rendered pages. No scripts: every action is a plain form post, and the
// Studio refreshes itself with a meta refresh, so the CSP can forbid script.
// Colours, type, spacing and radii come from the portfolio theme (theme.css);
// layout.css only arranges them.

import theme from "./theme.css";
import layout from "./layout.css";
import type { ProjectRecord, LedgerEvent } from "./ledger";
import type { FileChange, ItemDiff } from "./diff";
import { ago, position, splitActor, staggers, type Bench, type Floor, type MarkKind } from "./floor";
import { briefFor, submission, type Verdict } from "./brief";
import { describe as describeDispatch } from "./dispatch/rules";
import { drawStory, vendorOf as vendorFor, VENDOR_NAMES, type Story, type Tally, type Vendor } from "./graph";
import {
  decisionFor, evidenceAt, latestReviews, stateLabel,
  type Evidence, type Gate, type InboxEntry, type Item, type ProjectPolicy, type Review,
} from "./rules";

// What a page calls a project: its title when it has one, else its name. Links,
// forms and commands always use the name.
export const titleOf = (p: { name: string; title?: string }) => p.title || p.name;
// A project's display title as stored: one line of plain text, at most 80
// characters, or nothing.
export function cleanTitle(v: unknown): string | undefined {
  const s = String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return s || undefined;
}
const titleMap = (ps: ProjectRecord[]) => new Map(ps.map((p) => [p.name, titleOf(p)]));

export function escapeText(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
const e = escapeText;
const short = (sha: string | null) => (sha ? sha.slice(0, 8) : "—");
const when = (iso: string | null) => (iso ? iso.replace("T", " ").slice(0, 16) + " UTC" : "—");
const clock = (iso: string) => iso.slice(11, 16) + " UTC";
const href = (...p: string[]) => "/" + p.map(encodeURIComponent).join("/");
const selectedHref = (project: string, task: string) =>
  `/?project=${encodeURIComponent(project)}&task=${encodeURIComponent(task)}#review`;
const tag = (label: string, tone = "") => `<span class="tag ${tone}">${e(label)}</span>`;

const ICONS: Record<string, string> = {
  decisions: '<path d="M7 3h8l4 4v14H5V3h2Zm7 0v5h5M9 12h6m-6 4h6"/>',
  studio: '<path d="M3 20h18M5 20V9l7-5 7 5v11M9 20v-6h6v6"/>',
  projects: '<path d="M3 6h7l2 3h9v11H3V6Z"/>',
  history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/>',
  flow: '<path d="M3 6h18"/><path d="M6 6c3 0 2 6 5 6h7c3 0 2-6 5-6M6 6c3 0 2 12 5 12h4"/>',
  arrow: '<path d="m9 6 6 6-6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.1 11.5 3.3 3.3 0 0 0 7 18Z"/>',
  laptop: '<path d="M4 6h16v10H4zM2 19h20"/>',
};
const icon = (name: string) =>
  `<svg aria-hidden="true" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ""}</svg>`;

const NAV: [string, string, string][] = [
  ["Decisions", "/", "decisions"],
  ["Flow", "/flow", "flow"],
  ["Studio", "/studio", "studio"],
  ["Projects", "/projects", "projects"],
  ["History", "/history", "history"],
];

const FONTS = "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700;12..96,800&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&family=IBM+Plex+Mono:wght@400;500&display=swap";

function page(title: string, body: string, active = "Decisions", ownerName: string | null = null, refreshSeconds = 0): string {
  const nav = NAV.map(([label, url, glyph]) =>
    `<a href="${url}"${label === active ? ' aria-current="page"' : ""}>${icon(glyph)}<span>${label}</span></a>`).join("");
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
  <p>Many agents, one owner per task.<br>Decisions with evidence.</p></div>
</aside>
<main id="main">${body}</main></body></html>`;
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
export interface ReviewContext { project: ProjectRecord; detail: Detail; diff: ItemDiff | "unavailable" | null }
export interface ProjectView { project: ProjectRecord; items: Item[]; unavailable?: boolean }

const KIND: Record<InboxEntry["kind"], [string, string]> = {
  accept: ["Ready to accept", "go"],
  merge: ["Ready to merge", "go"],
  assess: ["Review required", "ask"],
  scope: ["Scope changed", "ask"],
  stale: ["Needs a handoff", "ask"],
  overlap: ["Overlapping work", "ask"],
  failing: ["Checks failed", "bad"],
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

export function renderLogin(error?: string): string {
  return page("Sign in", `<section class="login">
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
</section>`, "");
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
    return `<li><a class="decision-row${current ? " selected" : ""}" href="${selectedHref(lead.project, lead.itemId)}"${current ? ' aria-current="true"' : ""}>
      ${icon("decisions")}<span><strong>${e(lead.title)}</strong><span class="meta">${e(names.get(lead.project) ?? lead.project)} · ${e(lead.itemId)}</span>${extra}</span>${tag(label, tone)}${icon("arrow")}</a></li>`;
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
  return page("Decisions", `<div class="desk">${queue}${sheet}</div>`, "Decisions", ownerName);
}

// ── flow ───────────────────────────────────────────────────────────────────
// The work as a graph, with the tally that says who did what. Numbers here are
// counted from the Ledger's events by graph.ts; nothing is estimated.

const taskHref = (project: string) => (th: { id: string }) => href("p", project, th.id);
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

function legendLine(vendors: Vendor[]): string {
  const items = VENDOR_NAMES.filter(([v]) => vendors.includes(v) || v === "owner")
    .map(([v, label]) => `<li><i style="--c:var(--m-${v})"></i>${e(label)}</li>`);
  return `<ul class="legend-line" aria-label="Colours"><li><i style="--c:var(--main-line)"></i>main</li>${items.join("")}<li><i style="--c:var(--fault)"></i>sent back</li></ul>`;
}

function vendorsIn(stories: Story[]): Vendor[] {
  return [...new Set(stories.flatMap((s) => Object.keys(s.tally.byVendor) as Vendor[]))];
}

function tallyBlock(t: Tally): string {
  const total = t.agentMoves + t.decisions || 1;
  const bar = VENDOR_NAMES.filter(([v]) => v !== "owner" && t.byVendor[v])
    .map(([v]) => `<span style="--c:var(--m-${v});width:${((t.byVendor[v]! / total) * 100).toFixed(2)}%"></span>`).join("")
    + `<span style="--c:var(--m-owner);width:${((t.decisions / total) * 100).toFixed(2)}%"></span>`;
  return `<div class="tally"><div class="tally-bar" aria-hidden="true">${bar}</div><dl>
  <div><dt>agent moves</dt><dd>${t.agentMoves}</dd></div>
  <div class="you"><dt>your decisions</dt><dd>${t.decisions}</dd></div>
  <div class="cloud"><dt>checks run on a clean copy${t.inCloud ? `, ${t.inCloud} in Cloudflare` : ""}</dt><dd>${t.checks}</dd></div>
  <div class="catch"><dt>times a model sent work back</dt><dd>${t.sentBack}</dd></div>
</dl></div>`;
}

function headline(t: Tally): string {
  const agents = t.agents.length;
  return `<span class="you">You made ${plural(t.decisions, "decision")}.</span> <span class="them">${
    agents ? `${plural(agents, "agent")} did the other ${t.agentMoves} moves${t.sentBack ? `, and sent work back ${plural(t.sentBack, "time")}` : ""}.` : "No agent has started yet."}</span>`;
}

function restingGraph(s: Story, owner: string): string {
  const t = s.tally;
  return `<div class="resting-graph">
  <span class="kicker">${e(s.title)} · the work so far${s.partial ? " · the most recent part of the record" : ""}</span>
  <h2><span class="you">You made ${plural(t.decisions, "decision")}.</span> ${plural(t.agents.length, "agent")} made ${t.agentMoves} moves.</h2>
  <p>Nothing is waiting on you. Each thread is a task an agent took off main; it flows back only when you accept it.</p>
  ${legendLine(Object.keys(t.byVendor) as Vendor[])}
  <div class="stage-scroll">${drawStory(s, owner, { compact: true, replaySeconds: 6, href: taskHref(s.project) })}</div>
  <a href="/flow">See the whole flow</a>
</div>`;
}

const MOMENT_COLOUR = (m: Story["moments"][number], owner: string) =>
  m.tone === "catch" ? "var(--fault)" : m.tone === "merge" ? "var(--main-line)" : m.actor === owner ? "var(--m-owner)" : `var(--m-${vendorFor(m.actor, owner)})`;

export function renderFlow(stories: Story[], total: Tally, owner: string, ownerName: string | null = null, unavailable = false): string {
  const shown = stories.filter((s) => s.threads.length);
  const moments = shown
    .flatMap((s) => s.moments.map((m) => ({ ...m, project: s.title })))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 14);
  const many = shown.length > 1;
  const stages = shown.map((s) => `<section class="stage" id="${e(s.project)}" aria-label="${e(s.title)}">
  <div class="stage-head"><h2>${e(s.title)}</h2><span class="meta">${plural(s.threads.length, "task")} taken · ${s.tally.merges} merged · ${plural(s.tally.agents.length, "agent")}${s.partial ? " · the most recent part of the record" : ""}</span>
  <a class="replay" href="/flow?replay=${Date.now().toString(36)}#${e(s.project)}">▶ Replay</a></div>
  <div class="stage-scroll">${drawStory(s, owner, { href: taskHref(s.project) })}</div>
</section>`).join("");
  const t = total;
  const journey = [
    ["Planned", "You describe an outcome; it becomes a task with a scope.", `${plural(t.planned, "task")} planned`, "var(--main-line)"],
    ["Claimed", "One agent takes it and gets its own fork in Cloudflare Artifacts. Nobody else can write there.", `${plural(t.claims, "claim")}, ${plural(t.handoffs, "handoff")}`, "var(--m-anthropic)"],
    ["Worked", "The agent commits and pushes to its fork, never to your checkout.", `${plural(t.pushes, "push", "pushes")}`, "var(--m-openai)"],
    ["Checked", "The project's checks run on a clean copy of the exact revision: in a Cloudflare container, or, where the project allows it, on the agent's machine.", `${plural(t.checks, "check")} observed${t.inCloud ? `, ${t.inCloud} in Cloudflare` : ""}`, "var(--observed)"],
    ["Reviewed", "Changes to protected files need a model from another family, or you.", `${plural(t.approvals, "approval")}, ${t.sentBack} sent back`, "var(--m-zai)"],
    ["Decided", "You see the diff, the evidence and the reviews, and accept one revision.", `${plural(t.accepts, "acceptance")}`, "var(--m-owner)"],
    ["Merged", "It merges into main on your machine, with its whole history attached as a git note.", `${t.merges} merged`, "var(--main-line)"],
  ].map(([b, p, n, c]) => `<li style="--c:${c}"><b>${e(b)}</b><p>${e(p)}</p><span class="n">${e(n)}</span></li>`).join("");

  const body = shown.length
    ? `${legendLine(vendorsIn(shown))}${stages}
<div class="flow-cols">
  <section aria-label="What happened"><h2>What happened</h2><ol class="moments">${moments.map((m) =>
    `<li class="${m.tone}"><span class="dot" style="--c:${MOMENT_COLOUR(m, owner)}"></span><time datetime="${e(m.at)}">${e(m.at.slice(5, 10).replace("-", "/"))} ${e(m.at.slice(11, 16))}</time><p>${many ? `<span class="meta">${e(m.project)} · </span>` : ""}${e(m.text)}</p></li>`).join("")}</ol></section>
  <section aria-label="How a task travels"><h2>How a task travels</h2><ol class="journey">${journey}</ol></section>
</div>`
    : `<div class="empty"><h3>No work yet.</h3><p>When an agent claims a task, its thread appears here, from claim to merge.</p></div>`;
  return page("Flow", `<div class="page-width flow">
  <header class="flow-hero">
    <div><span class="kicker">Atelier · every project · from the ledger</span>
      <h1>${headline(t)}</h1>
      <p class="lead">Each coloured thread is a task an agent took off main: its pushes, its checks, the reviews from other models, and your decision. Hover a mark for what happened; select a task to open it.</p></div>
    ${tallyBlock(t)}
  </header>
  ${unavailable ? '<p role="status" class="error">Some projects could not be read; the flow may be incomplete.</p>' : ""}
  ${body}
</div>`, "Flow", ownerName);
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

// One lane: a band per holder (the current one tinted), the shared axis, and a
// mark for every recorded event, staggered where marks crowd together.
function lane(b: Bench, floor: Floor, now: Date, titles: Map<string, string>): string {
  const pct = (at: string) => position(at, floor) * 100;
  const spans = b.spans.map((sp, i) => {
    const x = pct(sp.from), w = Math.max(0.6, pct(sp.to ?? now.toISOString()) - x);
    const current = sp.to === null;
    const label = splitActor(sp.holder).model;
    return `<rect x="${x.toFixed(2)}%" y="8" width="${w.toFixed(2)}%" height="${TRACK_H - 16}" rx="6" class="${current ? "span-now" : i % 2 ? "span-past alt" : "span-past"}"><title>${e(sp.holder)} held it from ${e(clock(sp.from))}${sp.to ? ` to ${e(clock(sp.to))}` : " until now"}</title></rect>
      <text x="${x.toFixed(2)}%" dx="8" y="22" class="span-label${current ? " now" : ""}">${e(label)}</text>`;
  }).join("");
  const xs = b.marks.map((m) => position(m.at, floor));
  const dy = staggers(xs);
  const marks = b.marks.map((m, i) =>
    `<svg x="${(xs[i] * 100).toFixed(2)}%" y="${MID + dy[i] * 13}" overflow="visible" class="mark"><title>${e(MARK_NAMES[m.kind])}: ${e(m.label)} · ${e(clock(m.at))}</title>${markShape(m.kind)}</svg>`).join("");
  const last = b.marks[b.marks.length - 1];
  const chain = b.chain.length > 1
    ? `<p class="chain" aria-label="Held by, in order">${b.chain.map((a) => `<span>${e(a)}</span>`).join('<span aria-hidden="true"> → </span>')}</p>`
    : "";
  const tone = b.item.state === "accepted" ? "go" : b.item.state === "submitted" ? "ask" : "";
  return `<li class="lane" id="${e(b.project)}-${e(b.item.id)}">
  <div class="bench">
    <p class="who"><strong>${e(b.model)}</strong><span class="meta">${e(b.harness || "agent")}</span></p>
    <p class="task"><a href="${href("p", b.project, b.item.id)}">${e(b.item.title)}</a></p>
    <p class="meta">${e(titles.get(b.project) ?? b.project)} · ${e(b.item.id)} · ${tag(stateLabel[b.item.state], tone)}</p>
    ${chain}
  </div>
  <div class="track">
    <svg class="track-svg" width="100%" height="${TRACK_H}" role="img" aria-label="${e(`${b.marks.length} recorded events for ${b.item.id}, held by ${b.chain.join(", then ")}; latest: ${last ? `${MARK_NAMES[last.kind]} ${ago(last.at, now)}` : "none"}`)}">
      ${spans}
      <line x1="0" y1="${MID}" x2="100%" y2="${MID}" class="axis"/>
      <line x1="100%" y1="4" x2="100%" y2="${TRACK_H - 4}" class="now-line"/>
      ${marks}
    </svg>
    <p class="meta latest">${last ? `<strong>${e(MARK_NAMES[last.kind])}</strong> · ${e(last.label)} · ${e(ago(last.at, now))}` : "No activity recorded yet."}</p>
  </div>
</li>`;
}

export function renderStudio(floor: Floor, ownerName: string | null = null, now = new Date(), unavailable = false, projects: ProjectRecord[] = []): string {
  const titles = titleMap(projects);
  const agents = new Set(floor.benches.map((b) => b.agent)).size;
  const legend = (Object.keys(MARK_NAMES) as MarkKind[]).map((k) =>
    `<li><svg width="24" height="24" aria-hidden="true"><svg x="12" y="12" overflow="visible" class="mark">${markShape(k)}</svg></svg>${e(MARK_NAMES[k])}</li>`).join("");
  const mid = new Date((Date.parse(floor.from) + Date.parse(floor.to)) / 2).toISOString();
  const body = floor.benches.length
    ? `<div class="axis-labels" aria-hidden="true"><span>${e(clock(floor.from))}</span><span>${e(clock(mid))}</span><span>now</span></div>
<ol class="lanes">${floor.benches.map((b) => lane(b, floor, now, titles)).join("")}</ol>`
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

export function renderProjects(views: ProjectView[], ownerName: string | null = null): string {
  const list = views.map(({ project, items, unavailable }) => {
    const count = (states: string[]) => items.filter((i) => states.includes(i.state)).length;
    const summary = unavailable
      ? "Temporarily unavailable. Open to retry."
      : `${count(["claimed", "submitted", "accepted"])} active · ${count(["open"])} ready to start · ${count(["merged"])} merged`;
    return `<li><a href="${href("p", project.name)}"><h2>${e(titleOf(project))}</h2><p>${summary}</p>${icon("arrow")}</a></li>`;
  }).join("");
  return page("Projects", `<div class="page-width">
  <header><h1>Projects</h1><p class="lead">Work in motion, with a clear owner for every task.</p></header>
  <ul class="project-list">${list}</ul>
  ${!views.length ? '<div class="empty"><h2>Start with one project.</h2><p>Run <code>atelier init</code> in its local checkout. It will appear here.</p></div>' : ""}
</div>`, "Projects", ownerName);
}

function taskRows(p: ProjectRecord, items: Item[]): string {
  return `<ul class="task-list">${items.map((i) => `<li><a href="${href("p", p.name, i.id)}">
    <span><strong>${e(i.title)}</strong><span class="meta">${e(i.id)} · ${e(i.owner ?? "No current owner")}</span></span>
    ${tag(stateLabel[i.state], i.state === "merged" ? "go" : "")}<time class="meta">${when(i.updatedAt)}</time>${icon("arrow")}</a></li>`).join("")}</ul>`;
}

export function renderProject(p: ProjectRecord, items: Item[], events: LedgerEvent[], ownerName: string | null = null): string {
  const closed = (i: Item) => i.state === "merged" || i.state === "abandoned";
  const live = items.filter((i) => !closed(i));
  const done = items.filter(closed);
  const policy = `<dl>
    <dt>Required checks</dt><dd>${p.policy.checks.map((c) => `<code>${e(c)}</code>`).join("<br>") || "None configured"}</dd>
    <dt>Protected files</dt><dd>${p.policy.protected.map(e).join(", ") || "None configured"}</dd>
    <dt>Check execution</dt><dd>${p.policy.sandboxOnly ? "Only checks run in a Cloudflare container count" : "Checks count from a Cloudflare container or the agent's machine"}</dd>
    <dt>Eligible agents</dt><dd>${p.policy.eligible?.map(e).join(", ") || "Any agent"}</dd>
    <dt>Overlap</dt><dd>${p.policy.refuseOverlap ? "Refused" : "Flagged for review"}</dd>
    <dt>Baseline</dt><dd><code>${e(p.repo)}</code></dd>
  </dl>`;
  return page(titleOf(p), `<div class="page-width">
  <nav class="breadcrumbs"><a href="/projects">Projects</a> / ${e(titleOf(p))}</nav>
  <header><h1>${e(titleOf(p))}</h1><p class="lead">${live.length} active or planned task${live.length === 1 ? "" : "s"}.</p></header>
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
  <details class="disclosure"><summary>Project policy</summary>${policy}</details>
  <details class="disclosure"><summary>Activity</summary>${eventTable(events, true)}</details>
</div>`, "Projects", ownerName);
}

export function renderHistory(views: ProjectView[], ownerName: string | null = null): string {
  const completed = views
    .flatMap(({ project, items }) => items.filter((i) => i.state === "merged" || i.state === "abandoned").map((item) => ({ project, item })))
    .sort((a, b) => b.item.updatedAt.localeCompare(a.item.updatedAt));
  const rows = completed.map(({ project, item }) => `<li><a href="${href("p", project.name, item.id)}">
    <span><strong>${e(item.title)}</strong><span class="meta">${e(titleOf(project))} · ${e(item.id)}</span></span>
    ${tag(stateLabel[item.state], item.state === "merged" ? "go" : "")}<time class="meta">${when(item.updatedAt)}</time>${icon("arrow")}</a></li>`).join("");
  return page("History", `<div class="page-width">
  <header><h1>History</h1><p class="lead">Finished work, with its evidence intact.</p></header>
  ${views.some((v) => v.unavailable) ? '<p class="error">Some project history is unavailable. Refresh to retry.</p>' : ""}
  <ul class="task-list">${rows}</ul>
  ${!completed.length ? '<p class="empty">Completed tasks will appear here after they merge or close.</p>' : ""}
</div>`, "History", ownerName);
}

function eventTable(events: LedgerEvent[], withItem = false): string {
  if (!events.length) return '<p class="empty">No activity recorded yet.</p>';
  return `<ol class="timeline">${events.map((v) => `<li><span class="timeline-dot"></span><div>
    <strong>${e(v.kind.replaceAll(".", " ").replaceAll("_", " "))}</strong>${withItem && v.itemId ? ` · ${e(v.itemId)}` : ""}
    <p class="meta">${e(v.actor)} · ${when(v.at)}</p>
    <details><summary>Details</summary><pre>${e(JSON.stringify(v.data, null, 2))}</pre></details></div></li>`).join("")}</ol>`;
}

// ── a task ─────────────────────────────────────────────────────────────────

export function renderItem(p: ProjectRecord, d: Detail, ownerName: string | null = null, diff: ItemDiff | "unavailable" | null = null): string {
  const closed = d.item.state === "merged" || d.item.state === "abandoned";
  return page(d.item.title, `<div class="page-width">
  <nav class="breadcrumbs"><a href="/">Decisions</a> / <a href="${href("p", p.name)}">${e(titleOf(p))}</a> / ${e(d.item.id)}</nav>
  <article class="review-sheet standalone" id="review">${reviewBody({ project: p, detail: d, diff })}</article>
</div>`, closed ? "History" : "Decisions", ownerName);
}

const VERDICT_TONE: Record<Verdict, string> = { accept: "go", merge: "go", review: "ask", wait: "ask", decide: "ask", "send back": "bad" };

// The brief sits above the diff: what is decided, what the agent said, what the
// record shows, and what it points to.
function briefBlock(d: Detail): string {
  if (!["claimed", "submitted", "accepted"].includes(d.item.state)) return "";
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

const shell = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

function reviewBody({ project: p, detail: d, diff }: ReviewContext): string {
  const { item, gate } = d;
  const view = evidenceAt(d.policy, d.evidence, item.head);
  const decision = decisionFor(item, d.policy, d.evidence, d.reviews, d.ownerActor);
  const live = item.state === "claimed" || item.state === "submitted";
  const action = (verb: string) => href("ui", p.name, item.id, verb);
  const revision = `<input type="hidden" name="head" value="${e(item.head ?? "")}">`;
  const evidenceVisible = !!diff && diff !== "unavailable" && diff.head === item.head;

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
  const merge = decision.action === "merge"
    ? `<div class="merge-command"><p>In the registered checkout, run:</p>
      <pre tabindex="0">${e(`atelier merge ${item.id} --project ${shell(p.name)} --head ${item.acceptedHead}`)}</pre>
      <p class="meta">This merges the approved revision and records the result. It does not deploy.</p></div>`
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
          <label>Agent<select name="agent"><option value="">Runner's choice</option><option value="claude-code">Claude Code</option><option value="codex">Codex</option><option value="zcode">ZCode (GLM)</option><option value="opencode">OpenCode (local models)</option></select></label>
          <label>Model <span class="meta">optional, as the runner names it</span><input type="text" name="model" placeholder="e.g. glm-5.3-flash"></label>
          <label>Note for the agent <span class="meta">optional</span><input type="text" name="note" maxlength="500"></label>
          <button class="primary">Send</button>
        </form></details>`
    : "";

  const header = `<header class="review-header">
  <p class="context">${e(titleOf(p))} · ${e(item.id)} · ${e(stateLabel[item.state])}</p>
  <h2>${e(item.title)}</h2>
  <p class="review-description">${e(decision.detail)}</p>
  <p class="decision-status ${decision.tone}">${trustLine(view.checks)}<strong>${e(decision.title)}</strong></p>
  ${evidenceNotice}
  <div class="actions">${approve}${accept}${reject}${dispatchBox}</div>
  ${merge}
  <p class="meta revision">Revision <code>${short(item.head)}</code>${item.owner ? ` · ${e(item.owner)}` : ""}</p>
</header>`;

  const scope = gate.outOfScope.length
    ? `<details class="notice"><summary>Scope changed · ${gate.outOfScope.length} file${gate.outOfScope.length === 1 ? "" : "s"}</summary>
      <p>These changes extend beyond the original task scope. Include them in your review.</p>
      <ul>${gate.outOfScope.map((f) => `<li><code>${e(f)}</code></li>`).join("")}</ul></details>`
    : "";
  const protectedNote = gate.needsAssessor
    ? '<div class="notice"><h3>Protected change</h3><p>These files affect protected behavior. Approval from you or a different model is required.</p></div>'
    : "";

  const checkRows = view.checks.map((c) => {
    const last = d.evidence
      .filter((x) => x.head === item.head && x.claim === c.claim && x.grade === "observed" && (!d.policy.sandboxOnly || x.where === "sandbox"))
      .sort((a, b) => a.at.localeCompare(b.at))
      .pop();
    const status = c.grade === "pending" ? tag("Waiting", "ask") : c.passed ? tag("Passed", "go") : tag("Failed", "bad");
    const where = c.grade === "observed" ? whereChip(c.where) : "";
    const uncounted = !last && d.policy.sandboxOnly && d.evidence.some((x) => x.head === item.head && x.claim === c.claim && x.grade === "observed" && x.where !== "sandbox");
    const detail = last
      ? `${e(last.by)} · ${e(WHERE[last.where ?? "runner"][0])} · ${when(last.at)}`
      : uncounted
        ? "This check ran on the agent's machine, which does not count for this project. Run <code>atelier check --sandbox</code> to run it in a Cloudflare container."
        : "The task owner must run this required check.";
    return `<details class="check-row"${c.passed === false ? " open" : ""}>
      <summary>${status}<code>${e(c.claim)}</code>${where}</summary>
      <p class="meta">${detail}</p>${last?.outputTail ? `<pre tabindex="0">${e(last.outputTail)}</pre>` : ""}</details>`;
  }).join("");
  const reports = view.reports.length
    ? `<details class="disclosure"><summary>Reported by agents · ${view.reports.length}</summary>
      <p class="meta">Reported, not verified; these never satisfy a required check.</p>
      ${view.reports.map((r) => `<p>${tag("Reported")} ${e(r.claim)} <span class="meta">${e(r.by)}</span></p>`).join("")}</details>`
    : "";
  const reviews = latestReviews(d.reviews, item.head).map((r) => `<div class="review-note">${tag(r.approve ? "Approved" : "Changes requested", r.approve ? "go" : "ask")}
    <p>${e(r.note || "No note provided.")}</p><p class="meta">${e(r.by)} · ${when(r.at)}</p></div>`).join("");
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
${briefBlock(d)}
<nav class="review-nav" aria-label="In this review"><a href="#changes">Changes</a><a href="#checks">Checks</a><a href="#history">History</a></nav>
<section id="changes" class="review-section"><h3>Changes</h3>${renderDiff(diff, item.head)}${scope}${protectedNote}</section>
<section id="checks" class="review-section"><h3>Checks and reviews</h3>
  <p class="meta">${decision.passed} of ${view.checks.length} required checks passed at this revision.${d.policy.sandboxOnly ? " Only checks run in a Cloudflare container count for this project." : ""}</p>
  ${checkRows}${!view.checks.length ? '<p class="meta">No required checks are configured.</p>' : ""}${reports}${reviews}${blockers}
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
};

// Each line keeps its +, - or space, so the diff reads without colour.
function renderFile(f: FileChange, open: boolean): string {
  const [label, tone] = STATUS[f.status];
  const counts = f.added || f.removed ? `<span class="counts">+${f.added} −${f.removed}</span>` : "";
  const note = f.status === "binary" ? "Binary file; not shown."
    : f.status === "too-large" ? "Too large to diff here; use <code>atelier diff</code>."
    : f.status === "mode" ? "Only the file mode changed." : "";
  const body = f.hunks.length
    ? `<pre class="diff" tabindex="0">${f.hunks.map((h) =>
        `<span class="hunk">@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@</span>` +
        h.lines.map((l) => `<span class="${l.op === "+" ? "add" : l.op === "-" ? "del" : ""}">${l.op}${e(l.text)}</span>`).join("")).join("")}</pre>`
    : note ? `<p class="meta file-note">${note}</p>` : "";
  return `<details class="file"${open ? " open" : ""}><summary><span class="tag ${tone}">${label}</span><code>${e(f.path)}</code>${counts}</summary>${body}</details>`;
}

function renderDiff(diff: ItemDiff | "unavailable" | null, recordedHead: string | null): string {
  if (diff === "unavailable") return `<p class="empty">The diff could not be read from Artifacts just now. <code>atelier diff</code> shows it from a clean clone.</p>`;
  if (!diff) return `<p class="empty">No workspace yet, so nothing to compare.</p>`;
  if (!diff.files.length) return `<p class="empty">No changes: the workspace is at <span class="mono">${short(diff.head)}</span>, the same as the baseline.</p>`;
  const added = diff.files.reduce((n, f) => n + f.added, 0);
  const removed = diff.files.reduce((n, f) => n + f.removed, 0);
  const moved = recordedHead && recordedHead !== diff.head
    ? `<p>${tag("Unrecorded", "ask")} Artifacts holds <span class="mono">${short(diff.head)}</span>, newer than the recorded head <span class="mono">${short(recordedHead)}</span>; the owner has pushed without running <code>atelier push</code>.</p>`
    : "";
  const summary = `${diff.files.length}${diff.truncated ? "+" : ""} file${diff.files.length === 1 ? "" : "s"} changed, +${added} −${removed}, from <span class="mono">${short(diff.base)}</span> to <span class="mono">${short(diff.head)}</span>.`;
  return `${moved}<p class="meta">${summary}${diff.truncated ? " Only the first files are listed; <code>atelier diff</code> shows the rest." : ""}</p>
${diff.files.map((f) => renderFile(f, diff.files.length <= 8)).join("")}`;
}
