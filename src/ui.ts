import { taskPage } from "./task-page.ts";
import { renderBoard } from "./board-html.ts";
import type { BoardSnapshot, Stage } from "./board.ts";
import { OWNER_CALL_LABEL, STAGE_LABEL, legacyFields, stageCounts, type Attention, type LegacyFields, type OwnerTask } from "./attention.ts";
import { sessionNoteText, type SessionNote } from "./sessions.ts";
// Server-rendered pages. Every action is a plain form post and every page
// reads fully without script; the Studio refreshes itself with a meta
// refresh. A page given a `Live` nonce also carries Atelier's own script,
// which refreshes and animates it and nothing more (src/live.ts).
// Colours, type, spacing and radii come from the portfolio theme (theme.css);
// layout.css only arranges them.

import { DISPATCH_NOTE_MAX, notePreview, TEXT_CONTROLS } from "./text.ts";
import { appliesText, checkClasses, classText, type CheckClass } from "./checks.ts";
import theme from "./theme.css";
import layout from "./layout.css";
import type { CriteriaReviewView, ProjectRecord, LedgerEvent, ReviewerAvailability } from "./ledger";
import { landingOf } from "./diff";
import type { FileChange, ItemDiff, Landed } from "./diff";
import { ago, position, splitActor, staggers, type Bench, type Floor, type MarkKind } from "./floor";
import { briefFor, submission, type Verdict } from "./brief";
import { describe as describeDispatch } from "./dispatch/rules";
import { fenceText, prereviewLines, type PrereviewFence, type PrereviewView } from "./dispatch/prereview.ts";
import { drawImported, laneColour } from "./import/draw";
import { NO_AGENT, type ImportedHistory } from "./import/history";
import { HARNESSES, PROVIDERS, type ModelEntry } from "./models/pool";
import type { ModelRecord } from "./models/record";
import { PRECISION_MIN_JUDGED, precisionTerm, type PrecisionRecord, type ReviewerPrecision } from "./models/precision.ts";
import { judged, judgementTotals, type ActingJudgement, type JudgementRecord } from "./models/judgement.ts";
import { reliabilityLine, roundsPerMerge, runTotal, RUN_OUTCOMES, type Cause, type KindMeasures, type ModelReliability, type Reliability } from "./models/reliability.ts";
import { clockTime, dayOf, shortStamp, stamp, weekdayOf, zoneLabel } from "./time";
import { duration, type GatewayView } from "./usage/gateway.ts";
import { pace, stalledText, type Measure, type RoleSpeed, type SpeedRecord } from "./models/speed.ts";
import { money, tokens } from "./usage/report.ts";
import type { MainPreview } from "./preview/merge";
import { addTally, buildStory, drawStory, emptyTally, isLocalRun, vendorOf as vendorFor, VENDOR_NAMES, type Story, type Tally, type Vendor } from "./graph";
import { buildPulse, buildTimeline, byDay, PULSE_DAYS, type Pulse } from "./pulse";
import type { PlanPartView, PlanView } from "./plans/show.ts";
import type { Attempt } from "./plans/phase.ts";
import type { PartRoute } from "./plans/route.ts";

// A page that carries the live script (src/live.ts): the request's nonce,
// which the script tag and the policy both name, and how often the page
// refreshes itself, in seconds, or nothing for the scrubber alone.
export interface Live { nonce: string; refresh?: number }
import {
  bindingOf, changeClass, confirmationAt, contributorsOf, countingReviews, DEFAULT_OWNER, decisionFor, evidenceAt, independentApproval, latestReviews, mergedByOverride, mergedChecksAt, NO_OWNER_FACTOR, OVERRIDE_CONFIRMATION_MS, OVERRIDE_REASON_MAX, overrideAt, protectedNeed, REASON_MAX, recordedText, stateLabel, modelOf, modelKey, singleFamily, standingFastReady,
  type Finding, type Evidence, type FamilyMode, type Gate, type InboxEntry, type Item, type ItemState, type MergedCheckView, type OwnerFactor, type ProjectPolicy, type Review, type UnparsableReply,
} from "./rules";
import { STEPS, TAGLINE, TAKEAWAYS, type Verb } from "./how-data.ts";

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
  back: '<path d="m15 6-6 6 6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.1 11.5 3.3 3.3 0 0 0 7 18Z"/>',
  laptop: '<path d="M4 6h16v10H4zM2 19h20"/>',
};
const icon = (name: string) =>
  `<svg aria-hidden="true" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ""}</svg>`;

// One bar in two rows for every owner page (docs/design/plan.md §2, P1; the
// canvas in docs/design/reimagined/). Row 1 says where in Atelier: Decisions
// with the count waiting on the owner, Projects, Activity, the project
// switcher and the owner's menu. Row 2, under /p/NAME only, says where in the
// project: Project › page, and the five tabs. The brand leads to Decisions,
// the owner's first question.
const NAV: [label: string, url: string][] = [
  ["Decisions", "/decisions"],
  ["Projects", "/home"],
  ["Activity", "/studio"],
];
// Which row-1 item each page's `active` makes current: Home and every page in
// a project's area are Projects; the Studio, Flow and History are Activity's
// Now, Flow and Merges.
const NAV_OF: Record<string, string> = { Decisions: "Decisions", Home: "Projects", Projects: "Projects", Studio: "Activity", Flow: "Activity", History: "Activity", Activity: "Activity" };

const ACCOUNT: [string, string][] = [
  ["Models", "/models"],
  ["Usage", "/usage"],
];

// What the bar needs from more than the page it is drawn on: the number
// waiting on the owner (the Decisions list's count, one per task, from the
// same attention the list reads), whether every project was read for it,
// and the projects for the switcher with their task and waiting counts. The
// renderers draw the bar with markers where these go; the server fills them
// for the request (fillShell), so a page drawn without one simply has no
// badge and no project list. `here` is the project the request's address
// names, and the page there: a page in a project's area whose body drew no
// project row (an error, an empty repository) is given one from it.
export interface Shell {
  waiting: number;
  incomplete: boolean;
  projects: { name: string; title: string; tasks: number | null; waiting: number | null }[];
  here?: { project: ProjectRecord; active: string; crumb?: string } | null;
}
const MARK = {
  waiting: "<!--shell:waiting-->",
  projects: "<!--shell:projects-->",
  tasks: (name: string) => `<!--shell:tasks:${encodeURIComponent(name)}-->`,
  row: "<!--shell:row-->",
  title: "<!--shell:title-->",
};
export const hasShell = (html: string) => html.includes(MARK.waiting);

export function fillShell(html: string, s: Shell): string {
  const n = `${s.waiting}${s.incomplete ? "?" : ""}`;
  const badge = s.waiting || s.incomplete ? ` <span class="badge"><span class="visually-hidden">, waiting on you: </span>${n}</span>` : "";
  const projects = s.projects.map((p) =>
    `<a href="${href("p", p.name)}">${e(p.title)}${p.waiting ? ` <span class="meta">${p.waiting} waiting</span>` : ""}</a>`).join("");
  let out = html.replaceAll(MARK.waiting, badge).replaceAll(MARK.projects, projects);
  if (s.here && out.includes(MARK.row)) {
    out = out.replace(MARK.row, projectRow(s.here.project, s.here.active, s.here.crumb)).replace(`${MARK.title}Project`, e(titleOf(s.here.project)));
  }
  out = out.replaceAll(MARK.row, "").replaceAll(MARK.title, "");
  for (const p of s.projects) out = out.replaceAll(MARK.tasks(p.name), p.tasks === null ? "" : ` (${p.tasks})`);
  return out;
}

// Row 2 is drawn by projectTabs, which the pages call in their bodies; the
// frame lifts it out of the body into the header, so a page in a project's
// area, browse pages included, has one bar and no second tab row.
const ROW2 = ["<!--project-row:", "<!--/project-row-->"] as const;

function liftProjectRow(body: string): { body: string; row: string; title: string | null } {
  const at = body.indexOf(ROW2[0]);
  if (at < 0) return { body, row: "", title: null };
  const open = body.indexOf("-->", at);
  const end = body.indexOf(ROW2[1], open);
  if (open < 0 || end < 0) return { body, row: "", title: null };
  const title = decodeURIComponent(body.slice(at + ROW2[0].length, open));
  return { body: body.slice(0, at) + body.slice(end + ROW2[1].length), row: body.slice(open + 3, end), title };
}

// One line about Atelier (src/how-data.ts), used here and as the sign-in
// page's headline, so the two never say different things.

// src/render-check.ts lets the render check's browser load exactly this URL.
export const FONTS = "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700;12..96,800&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&family=IBM+Plex+Mono:wght@400;500&display=swap";

// `signedIn` draws the sign-out form in the owner's menu; the sign-in page
// has none. `live` adds the script under its nonce; with a refresh, <main>
// says how often, and a small note in the bar, revealed by the script and
// widened on hover, says when this copy was drawn. On a phone the two menus
// stack under the brand and the three destinations, and open in the page's
// flow (layout.css), so nothing scrolls sideways.
export function page(title: string, body: string, active = "Decisions", ownerName: string | null = null, refreshSeconds = 0, signedIn = true, live?: Live): string {
  const lifted = liftProjectRow(body);
  const current = NAV_OF[active] ?? "";
  const cur = (on: boolean) => (on ? ' aria-current="page"' : "");
  const nav = NAV.map(([label, url]) => `<a href="${url}"${cur(label === current)}>${label}${label === "Decisions" ? `<span data-shell="waiting">${MARK.waiting}</span>` : ""}</a>`).join("");
  const account = ACCOUNT.map(([label, url]) => `<a href="${url}"${cur(label === active)}>${label}</a>`).join("");
  const signout = signedIn ? `<form method="post" action="/logout" class="signout"><button type="submit" class="quiet">Sign out</button></form>` : "";
  const who = e(ownerName || "Owner");
  const liveAttr = live?.refresh ? ` data-live-refresh="${live.refresh}"` : "";
  const liveNote = live?.refresh
    ? `<p class="meta live-note" hidden><span class="pulse" aria-hidden="true"></span>Live<span class="live-when"> · this copy is from ${e(clock(new Date().toISOString()))}; it refreshes every ${live.refresh} seconds.</span></p>`
    : "";
  const script = live ? `\n<script nonce="${e(live.nonce)}" src="/live.js" defer></script>` : "";
  return `<!doctype html><html lang="en" data-theme="night" data-scheme="night"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">${refreshSeconds ? `\n<meta http-equiv="refresh" content="${refreshSeconds}">` : ""}
<title>${e(title)} · Atelier</title><style>${theme}\n${layout}</style></head><body>
<a class="skip" href="#main">Skip to content</a>
<header class="owner-bar">
  <div class="bar-row">
    <a class="brand" href="/decisions">Atelier</a>
    <nav class="bar-nav" aria-label="Atelier">${nav}</nav>
    ${liveNote}
    <details class="bar-menu switcher"><summary>${lifted.title === null ? `${MARK.title}Project` : e(lifted.title)}</summary><div data-shell="projects"><a href="/home">All projects</a>${MARK.projects}</div></details>
    <details class="bar-menu account"><summary>${who}</summary><div>${account}${signout}</div></details>
  </div>${lifted.title === null ? MARK.row : lifted.row}
</header>
<main id="main"${liveAttr}>${lifted.body}</main>${script}</body></html>`;
}

// The shell of the pages anyone can read: no rail, and no link into a signed-in
// page. `main` is the inner HTML of <main>; `css` is appended after the site's.
// `night` keeps the page in Night whatever the device prefers, as the
// owner's pages are; the showcase is drawn that way (d24, the d29 canvas).
export function publicPage(o: { title: string; description: string; brand: string; nav: [label: string, url: string][]; mainClass: string; main: string; css?: string; head?: string; night?: boolean; bodyClass?: string }): string {
  const nav = o.nav.map(([label, url]) => `<a href="${url}">${e(label)}</a>`).join("");
  return `<!doctype html><html lang="en" data-theme="night"${o.night ? ' data-scheme="night"' : ""}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="${o.night ? "dark" : "dark light"}">${o.head ?? ""}
<meta name="description" content="${e(o.description)}">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<title>${e(o.title)}</title><style>${theme}\n${layout}${o.css ? `\n${o.css}` : ""}</style></head><body class="public${o.bodyClass ? ` ${o.bodyClass}` : ""}">
<header class="public-bar"><a class="brand" href="${o.brand}">Atelier</a><nav aria-label="Elsewhere">${nav}</nav></header>
<main id="main" class="${o.mainClass}">${o.main}</main></body></html>`;
}

export interface Detail {
  runs?: import("./models/reliability").RunReport[];
  ownerActor?: string;
  // The factor the server takes as the owner's confirmation of an override
  // (t371): the Access identity, the confirmation secret, or null for a
  // server with neither, which offers no override form. Unset where the
  // page is drawn without a server, as a null.
  ownerFactor?: OwnerFactor | null;
  // A submission from this page that was refused (t457): the form it came
  // from, the refusal's words and the reason the owner typed, which the
  // form keeps. A confirmation secret is never carried back.
  formError?: FormError;
  item: Item;
  policy: ProjectPolicy;
  evidence: Evidence[];
  reviews: Review[];
  // Replies no verdict could be read from, kept on the task (t407), oldest
  // first; the reviews above carry none of them.
  unparsable?: UnparsableReply[];
  // The task's pre-reviews, newest first, and the fence a blocking one left
  // on its landing (t524); unset on a server from before pre-review.
  prereviews?: PrereviewView[];
  prereviewFence?: PrereviewFence | null;
  gate: Gate;
  // Where the review of the item's acceptance criteria stands (t438), with
  // every criteria review and resolution; absent from an older server.
  criteriaReview?: CriteriaReviewView;
  events: LedgerEvent[];
}
export interface FormError { verb: "approve" | "reject" | "accept" | "override" | "allow-override"; message: string; note?: string }
// `full` is set on the task's own page, the one place that shows the task's
// brief and acceptance criteria; every other view shows its short title.
// `auto` marks the decision Decisions selects itself when the owner picked
// none: the desktop shows it beside the list, a phone shows only the list.
export interface ReviewContext { project: ProjectRecord; detail: Detail; diff: ItemDiff | "unavailable" | null; thread?: boolean; full?: boolean; auto?: boolean }
// `events` is the project's recent record, newest first, when the page reads
// it (Projects and History); `cut` says it was read up to a limit.
export interface ProjectView { project: ProjectRecord; items: Item[]; unavailable?: boolean; events?: LedgerEvent[]; cut?: boolean }

const KIND: Record<InboxEntry["kind"], [string, string]> = {
  accept: ["Ready to accept", "go"],
  merge: ["Ready to merge", "go"],
  ship: ["To ship", "ask"],
  assess: ["Review required", "ask"],
  blocked: ["Blocked", "ask"],
  scope: ["Scope changed", "ask"],
  stale: ["Needs a handoff", "ask"],
  overlap: ["Overlapping work", "ask"],
  failing: ["Checks failed", "bad"],
  "approve-plan": ["Plan to approve", "ask"],
  "plan-blocked": ["Plan blocked", "bad"],
};

// The owner's calls and the pipeline's stages as the waiting lists tag them
// (attentionFor in src/attention.ts places each task once).
const CALL_TONE: Record<OwnerTask["call"], string> = {
  "clear-secret": "bad", unblock: "ask", "decide-plan": "bad", "approve-plan": "ask", accept: "go", override: "bad", ship: "ask", "start-runner": "bad",
};
const callTag = (t: OwnerTask) => tag(OWNER_CALL_LABEL[t.call], CALL_TONE[t.call]);

// Where an owner item's call is performed: the task page's form, or Ship.
const actionLink = (t: OwnerTask) => `<a href="${e(t.href)}">${t.call === "ship" ? "Open Ship" : "Open the task page"}</a>`;

// One owner item: the task, its call, the sentence that says what to do and
// the link to where it is done.
function ownerRow(t: OwnerTask, projectTitle?: string): string {
  return `<li class="owner-call"><a href="${e(t.href)}"><strong>${e(t.title)}</strong></a>${callTag(t)}<span class="meta">${projectTitle ? `${e(projectTitle)} · ` : ""}${e(t.id)}</span>
    <p>${e(t.sentence)} ${actionLink(t)}</p></li>`;
}

// The pipeline's tasks, counted by stage, and the overlapping scopes, each in
// a disclosure: they are the orchestrator's and the reviewers', never inline
// with what waits on the owner.
function pipelineDisclosure(a: Attention, projectTitle?: string, waitsFor: Map<string, string> = new Map()): string {
  if (!a.pipeline.length) return "";
  const counts = stageCounts(a).map(([s, n]) => `${n} ${STAGE_LABEL[s]}`).join(" · ");
  const rows = a.pipeline.map((t) => `<li><a href="${href("p", a.project, t.id)}">${e(t.title)}</a><span class="meta">${projectTitle ? `${e(projectTitle)} · ` : ""}${e(t.id)} · ${e(STAGE_LABEL[t.stage])}${waitsFor.has(`${a.project}/${t.id}`) ? `, for ${e(waitsFor.get(`${a.project}/${t.id}`)!)}` : ""}${t.notices.length ? ` · ${t.notices.map((k) => e(KIND[k][0])).join(", ")}` : ""}</span></li>`).join("");
  return `<details class="disclosure pipeline"><summary>${plural(a.pipeline.length, "task")} in the pipeline: ${counts}</summary>
    <p class="meta">The orchestrator, runners and reviewers move these; none waits on you.</p><ul class="home-rows">${rows}</ul></details>`;
}

// `projectTitle` names the project where the page lists more than one.
function overlapDisclosure(a: Attention, projectTitle?: string): string {
  if (!a.overlaps.length) return "";
  return `<details class="disclosure overlaps"><summary>${projectTitle ? `${e(projectTitle)} · ` : ""}${plural(a.overlaps.length, "pair")} of tasks with overlapping scopes</summary>
    <ul class="home-rows">${a.overlaps.map(([x, y]) => `<li><a href="${href("p", a.project, x)}">${e(x)}</a> and <a href="${href("p", a.project, y)}">${e(y)}</a> name overlapping paths</li>`).join("")}</ul>
    <p class="meta">Expect a merge conflict when the second lands; nothing waits on you.</p></details>`;
}

const unknownNotice = (a: Attention) => a.unknown.length
  ? `<div class="notice" role="status"><h3>Not everything was read</h3><ul>${a.unknown.map((x) => `<li>${e(x)}</li>`).join("")}</ul></div>` : "";

// ── where evidence came from ───────────────────────────────────────────────
// Both places are Atelier's own runs: a Cloudflare container started by the
// Worker, or Atelier's command in a clean clone of the pushed head on a runner.
// Neither is the agent running its own tests, so every summary that says
// "passed" also says where.

const WHERE: Record<"sandbox" | "runner", [string, string]> = {
  sandbox: ["in a Cloudflare container", "cloud"],
  runner: ["on a runner, in a clean clone", "laptop"],
};

function whereChip(where: "sandbox" | "runner" | undefined): string {
  const [label, glyph] = WHERE[where ?? "runner"];
  return `<span class="where ${where === "sandbox" ? "cloud" : "local"}">${icon(glyph)}${e(where === "sandbox" ? "Cloudflare container" : "Runner, clean clone")}<span class="visually-hidden"> (${e(label)})</span></span>`;
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
    const threads = s.threads.slice(0, Math.max(0, left));
    left -= threads.length;
    return { ...s, threads };
  }).filter((s) => s.threads.length);
  const graph = drawn.length
    ? `<div class="login-backdrop" aria-hidden="true">${drawn.map((s) => drawStory(s, backdrop!.owner, { replaySeconds: 12, ownerLabel: backdrop!.who })).join("").replace(/ tabindex="0"/g, "")}</div>`
    : "";
  return publicPage({
    title: "Sign in · Atelier",
    description: `Sign in to Atelier, a Git platform for multiple coding agents: claim, fork, prove, review, land. ${TAKEAWAYS}`,
    brand: "/",
    nav: [["How it works", "/how"], ["Source on GitHub", REPO_URL]],
    mainClass: "login-page",
    main: `<section class="login${graph ? " over-graph" : ""}">${graph}
  <h1>${TAGLINE.split(". ").map(e).join(".<br>")}</h1>
  <p class="lead">Atelier gives every task one owner, grades its evidence, and brings you only what needs a person.</p>
  <form method="post" action="/login" class="login-form">
    <h2>Sign in to Atelier</h2>
    ${error ? `<p role="alert" class="error">${e(error)}</p>` : ""}
    <label for="token">Server token</label>
    <input id="token" type="password" name="token" autocomplete="current-password" required>
    <p class="meta">Use the token stored in your Keychain as <code>atelier.API_TOKEN</code>.</p>
    <button class="primary">Sign in</button>
  </form>
  <p class="meta">${showcase ? 'Not the owner? <a href="/">See the public showcase</a>, or read ' : "Read "}<a href="/how">how Atelier works</a>.</p>
</section>`,
  });
}

// Behind Cloudflare Access (t534), a request that arrived from another site
// — the hop back from Access's own sign-in among them — starts no session and
// carries no SameSite=Strict cookie, so it is answered with this page, which
// sends the browser on to the same address at once. That second request is
// the page's own, same-origin, and the Worker starts the session there.
export function renderSignInContinue(path: string): string {
  return publicPage({
    title: "Signing in · Atelier",
    description: "Signing in to Atelier through Cloudflare Access.",
    brand: "/",
    nav: [["How it works", "/how"]],
    mainClass: "login-page",
    head: `\n<meta http-equiv="refresh" content="0;url=${e(path)}">`,
    main: `<section class="login">
  <h1>Signing you in</h1>
  <p class="lead">Cloudflare Access has signed you in. <a href="${e(path)}">Continue</a> if this page stays.</p>
</section>`,
  });
}

// ── decisions ──────────────────────────────────────────────────────────────
// One column of what waits on the owner, grouped by project, and the selected
// task's detail beside it: its state, why, the owner's actions and the
// evidence behind them (the canvas's Decisions artboard, PAVI's d29). Below
// about 700 px the two are separate views (layout.css).

// The task's own thread: just its events, as a story of one. Nothing is drawn
// when the record holds no claim for it (an older record cut at the read limit).
function taskStory(project: string, d: Detail): Story | null {
  const s = buildStory(project, [d.item], d.events.filter((ev) => ev.itemId === d.item.id), d.ownerActor ?? DEFAULT_OWNER);
  return s.threads.length ? s : null;
}

// An owner call as the state its task stands in, in the plan's one name per
// state (docs/design/brief.md §5) where it has one, with its colour role:
// gold what waits on the owner, green go, orange caution, red a fault.
const CALL_STATE: Record<OwnerTask["call"], [string, string]> = {
  "clear-secret": ["Secret flagged", "bad"],
  unblock: ["Blocked", "ask"],
  "decide-plan": ["Plan blocked", "bad"],
  "approve-plan": ["Plan to approve", "signal"],
  accept: ["Ready to accept", "go"],
  override: ["Needs review", "signal"],
  ship: ["To ship", "signal"],
  "start-runner": ["No runner", "bad"],
};

function decisionRow(project: string, t: OwnerTask, current: boolean): string {
  const [word, tone] = CALL_STATE[t.call];
  return `<li><a class="decision-row${current ? " selected" : ""}" href="${selectedHref(project, t.id)}"${current ? ' aria-current="true"' : ""}>
    <span class="dec-id">${e(t.id)}</span><span class="dec-title">${e(t.title)}</span><span class="dec-state ${tone}">${e(word)}</span><span class="dec-why">${e(t.sentence)}</span></a></li>`;
}

// What the orchestrator, runners and reviewers move, folded: per project its
// count by stage, then each task. None of it waits on the owner.
function orchestratorDisclosure(attention: Attention[], names: Map<string, string>, waitsFor: Map<string, string>): string {
  const busy = attention.filter((a) => a.pipeline.length);
  const total = busy.reduce((n, a) => n + a.pipeline.length, 0);
  if (!total) return "";
  const groups = busy.map((a) => {
    const counts = stageCounts(a).map(([s, n]) => `${n} ${STAGE_LABEL[s]}`).join(" · ");
    const rows = a.pipeline.map((t) => `<li><a href="${href("p", a.project, t.id)}">${e(t.title)}</a><span class="meta">${e(t.id)} · ${e(STAGE_LABEL[t.stage])}${waitsFor.has(`${a.project}/${t.id}`) ? `, for ${e(waitsFor.get(`${a.project}/${t.id}`)!)}` : ""}${t.notices.length ? ` · ${t.notices.map((k) => e(KIND[k][0])).join(", ")}` : ""}</span></li>`).join("");
    return `<h3 class="dec-project">${e(names.get(a.project) ?? a.project)} · ${counts}</h3><ul class="home-rows">${rows}</ul>`;
  }).join("");
  return `<details class="disclosure pipeline"><summary>Handled by the orchestrator · ${total}</summary>${groups}</details>`;
}

// Where a check ran, in the evidence list's words.
const PLACE: Record<"sandbox" | "runner", string> = { sandbox: "Cloudflare container", runner: "Runner, clean clone" };
const evidenceRow = (label: string, tone: string, what: string, where = "") =>
  `<li><span class="ev-label ${tone}">${e(label)}</span><span class="ev-what">${what}</span><span class="ev-where">${where}</span></li>`;

// The selected task. Its state and why are the task page's (taskPage), or the
// owner call's word when the task waits on the owner, so the row and the
// detail say one thing. Each action is the task page's own: the same form,
// posted to the same route, or the same command, or a link to the page.
function decisionDetail({ project: p, detail: d, diff }: ReviewContext, lead?: OwnerTask): string {
  const { item, gate } = d;
  const owner = d.ownerActor ?? DEFAULT_OWNER;
  const single = singleFamily(d.policy);
  const presentation = taskPage(d);
  const decision = decisionFor(item, d.policy, d.evidence, d.reviews, owner);
  const [word, tone] = lead ? CALL_STATE[lead.call] : [presentation.title, decision.tone];
  // A plan's own call carries its decision in its reason, as the plan item's
  // presentation reads it as a task and knows nothing of its proposal.
  const why = lead && (lead.call === "approve-plan" || lead.call === "decide-plan") ? lead.why : presentation.detail;
  const taskHref = href("p", p.name, item.id);
  const action = (verb: string) => href("ui", p.name, item.id, verb);
  const revision = `<input type="hidden" name="head" value="${e(item.head ?? "")}"><input type="hidden" name="criteria" value="${e(bindingOf(item).criteria)}">`;
  const live = item.state === "claimed" || item.state === "submitted";
  const evidenceVisible = !!diff && diff !== "unavailable" && diff.head === item.head;
  const binding = bindingOf(item);
  const counted = countingReviews(d.reviews, binding, d.policy, owner);

  const evidenceNotice = live && item.head && !evidenceVisible
    ? `<div class="notice" role="status"><h3>${diff && diff !== "unavailable" ? "The displayed revision has changed" : "Changes are unavailable"}</h3>
      <p>Approval and acceptance are unavailable until the displayed changes match this task’s recorded revision. <a href="${taskHref}">Reload this task</a>.</p></div>`
    : "";
  const ask = `<details class="ask-reviewer"><summary class="button primary">Ask a reviewer</summary>
      <div class="merge-command"><p>In the registered checkout, run:</p>
      <pre tabindex="0">${e(`atelier land ${item.id} --project ${shell(p.name)}`)}</pre>
      <p class="meta">The landing merges main into the workspace, runs the required checks, requests the review from ${single ? `a different ${single} model from every contributor (single-family mode)` : "a model of another family than every contributor"}, or the one <code>--reviewer</code> names, waits for its verdict, then accepts and merges.</p></div></details>`;
  const primary = evidenceVisible && decision.action === "accept"
    ? `<form method="post" action="${action("accept")}">${revision}<button class="primary">Accept revision</button></form>`
    : decision.action === "review" && !counted.some((r) => !r.approve)
      ? ask
      : item.state === "blocked" && item.blocked
        ? `<form method="post" action="${action("unblock")}">${revision}<button class="primary">Unblock</button></form>`
        : lead?.call === "ship"
          ? `<a class="button primary" href="${e(lead.href)}">Open Ship</a>`
          : "";
  const merge = decision.action === "merge"
    ? `<div class="merge-command"><p>In the registered checkout, run:</p>
      <pre tabindex="0">${e(`atelier merge ${item.id} --project ${shell(p.name)} --head ${item.acceptedHead}`)}</pre>
      <p class="meta">This merges the approved revision and records the result. It does not deploy.</p></div>`
    : "";
  const actions = `<div class="actions dec-actions">${primary}${item.head ? `<a class="button" href="${taskHref}#changes">Review the diff</a>` : ""}<a class="dec-open" href="${taskHref}">Open the task</a></div>`;

  // The evidence: each required check at this head with where and when it
  // last ran, the diff in figures, and the review the gate counts.
  const view = evidenceAt(d.policy, d.evidence, item.head);
  const checks = view.checks.map((c) => {
    const last = d.evidence
      .filter((x) => x.head === item.head && x.claim === c.claim && x.grade === "observed" && !x.merged && !x.notApplicable && (!d.policy.sandboxOnly || x.where === "sandbox"))
      .sort((a, b) => a.at.localeCompare(b.at)).at(-1);
    const [label, t] = c.grade === "pending" ? ["Waiting", "ask"] : c.passed ? ["Passed", "go"] : ["Failed", "bad"];
    return evidenceRow(label, t, `<code>${e(c.claim)}</code>`, last ? `${e(PLACE[last.where ?? "runner"])} · ${when(last.at)}` : "");
  }).join("") + view.notApplicable.map((claim) => evidenceRow("Not applicable", "", `<code>${e(claim)}</code>`)).join("");
  const files = diff && diff !== "unavailable" ? diff.files : [];
  const changed = diff === "unavailable"
    ? evidenceRow("Diff", "", "Could not be read just now")
    : diff && item.head
      ? evidenceRow("Diff", "", `${plural(files.length, "file")}${diff.truncated ? " or more" : ""}, +${files.reduce((n, f) => n + f.added, 0)} −${files.reduce((n, f) => n + f.removed, 0)}${gate.outOfScope.length ? ` · ${gate.outOfScope.length} outside its scope` : ""}`)
      : "";
  const current = latestReviews(d.reviews, binding).filter((r) => counted.includes(r));
  const reviews = current.length
    ? current.map((r) => evidenceRow(r.approve ? "Approved" : "Sent back", r.approve ? "go" : "bad", e(r.note || "No note provided."), `${e(r.by)} · ${when(r.at)}`)).join("")
    : gate.overridden
      ? evidenceRow("Overridden", "ask", e(gate.overridden.reason), `${e(gate.overridden.by)} · ${when(gate.overridden.at)}`)
      : gate.needsAssessor
        ? evidenceRow("Review", "signal", `None yet. ${e(cap(gate.requirement ?? protectedNeed(single)))}.`)
        : "";
  const evidence = item.head
    ? `${checks || changed || reviews ? `<ul class="dec-evidence">${checks}${changed}${reviews}</ul>` : ""}${checks ? "" : `<p class="meta">${view.notApplicable.length ? "No required check applies to this revision." : "This project requires no checks."}</p>`}`
    : `<p class="meta">Nothing pushed yet.</p>`;

  // The override is the task page's form, among its actions at the top; this
  // links to the page while the missing independent review is all that
  // blocks and the page offers the form.
  const overridable = evidenceVisible && item.state === "submitted" && !!item.head && gate.needsAssessor && gate.blockers.length === 1 && !d.policy.noOverride && (d.ownerFactor ?? null) !== null;
  const footer = overridable ? `<p class="meta dec-foot">No reviewer available? As a last resort, <a href="${taskHref}">record an override</a> on the task page.</p>` : "";

  return `<p class="context">${e(titleOf(p))} · ${e(item.id)}${item.owner ? ` · ${e(item.owner)}` : ""}</p>
  <h2 id="sel-h">${e(item.title)}</h2>
  <p class="dec-word ${tone}">${e(word)}</p>
  <p class="dec-because">${e(why)}</p>
  ${presentation.unknowns.map((x) => `<p class="meta">${e(x)}</p>`).join("")}
  ${evidenceNotice}${secretNotice(item, revision, action)}
  ${actions}${merge}
  <h3 class="dec-project">Evidence</h3>
  ${evidence}
  ${footer}`;
}

export function renderInbox(
  attention: Attention[],
  projects: ProjectRecord[],
  ownerName: string | null = null,
  selected?: ReviewContext,
  projectViews: ProjectView[] = [],
  queued: { project: ProjectRecord; item: Item }[] = [],
  latest?: { story: Story; owner: string },
  live?: Live,
): string {
  const names = titleMap(projects);
  // What waits on the owner, one row per task, placed by attentionFor and
  // grouped by project; what the pipeline carries and overlapping scopes stay
  // folded below.
  const own = attention.flatMap((a) => a.owner.map((t) => ({ project: a.project, t })));
  const isSelected = (project: string, id: string) => selected?.project.name === project && selected.detail.item.id === id;
  const groups = attention.filter((a) => a.owner.length).map((a) => {
    const title = names.get(a.project) ?? a.project;
    return `<section class="dec-group" aria-label="${e(title)}"><h2 class="dec-project">${e(title)} · ${a.owner.length}</h2>
    <ul class="decision-list">${a.owner.map((t) => decisionRow(a.project, t, isSelected(a.project, t.id))).join("")}</ul></section>`;
  }).join("");
  // A queued task's row names the runner it waits for.
  const waitsFor = new Map(queued.map(({ project, item }) => [`${project.name}/${item.id}`, describeDispatch(item.dispatch!)]));
  const elsewhere = orchestratorDisclosure(attention, names, waitsFor) + attention.map((a) => overlapDisclosure(a, names.get(a.project) ?? a.project)).join("");
  const unknown = attention.map(unknownNotice).join("");
  // The projects not read in full, by title: the list says it may be
  // incomplete, and so does the resting panel beside it.
  const notRead = [...new Set([...attention.filter((a) => a.unknown.length).map((a) => a.project), ...projectViews.filter((p) => p.unavailable).map((p) => p.project.name)])]
    .map((n) => names.get(n) ?? n);
  const incomplete = notRead.length > 0;

  const queue = `<section class="queue" aria-labelledby="dec-h">
  <h1 id="dec-h">Decisions · ${own.length}</h1>
  ${groups || (incomplete ? '<div class="empty"><h3>The list may be incomplete.</h3><p>Nothing is known to be waiting on you; more may be waiting. Refresh to try again.</p></div>' : `<div class="empty"><h3>You’re clear.</h3><p>Nothing is waiting on you. <a href="/studio">Watch the studio</a>.</p></div>`)}
  ${unknown}
  ${elsewhere}
  ${projectViews.some((p) => p.unavailable) ? '<p role="status" class="error">Some projects could not be read. Refresh to try again; this list may be incomplete.</p>' : ""}
  ${!projects.length ? '<div class="empty"><h3>Bring your first project.</h3><p>In its checkout, run <code>atelier init</code> to register it.</p></div>' : ""}
</section>`;
  // On a phone the desk is two views: the list, or the decision the owner
  // picked with a back link to the list. The back link is drawn only there
  // (layout.css hides it on wider screens), so the desktop's side-by-side desk
  // keeps both. The first decision, selected when the owner picked none, is
  // `auto-selected`, not `has-selection`: a phone shows the list for it, so
  // every row stays in reach.
  const picked = !!selected && !selected.auto;
  const back = picked
    ? `<a class="review-back" href="/decisions">${icon("back")}<span>All decisions</span></a>`
    : "";
  const lead = selected && own.find(({ project, t }) => isSelected(project, t.id))?.t;
  const sheet = selected
    ? `<section class="review-sheet decision-detail" id="review" aria-labelledby="sel-h">${back}${decisionDetail(selected, lead)}</section>`
    : latest?.story.threads.length
      ? `<section class="review-sheet resting has-graph" aria-label="Latest work">${restingGraph(latest.story, latest.owner, notRead)}</section>`
      : `<section class="review-sheet resting"><div>${icon("check")}<h2>Space to focus.</h2><p>Select a decision to see the changes, the evidence, and your next action.</p><a href="/studio">Watch the studio</a></div></section>`;
  return page("Decisions", `<div class="desk${picked ? " has-selection" : selected ? " auto-selected" : ""}">${queue}${sheet}</div>`, "Decisions", ownerName, 0, true, live);
}

// ── flow ───────────────────────────────────────────────────────────────────
// The work as a graph, with the tally that says who did what. Numbers here are
// counted from the Ledger's events by graph.ts; nothing is estimated.

const taskHref = (project: string) => (th: { id: string }) => href("p", project, th.id);
// The owner's label at the start of a sentence.
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const listed = (xs: string[]) => xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

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

// `notRead` names the projects whose records were not all read; while any
// is, the panel never says nothing is waiting (t504).
function restingGraph(s: Story, owner: string, notRead: string[] = []): string {
  const t = s.tally;
  const waiting = notRead.length
    ? `The list may be incomplete: some records of ${e(listed(notRead))} could not be read, so more may be waiting on you.`
    : "Nothing is waiting on you.";
  return `<div class="resting-graph">
  <span class="kicker">${e(s.title)} · the work so far${s.partial ? " · the most recent part of the record" : ""}</span>
  <h2><span class="you">You made ${plural(t.decisions, "decision")}.</span> ${plural(t.agents.length, "agent")} made ${t.agentMoves} moves.</h2>
  <p>${waiting} Each thread is a task an agent took off main; it flows back only when you accept it.</p>
  ${legendLine(Object.keys(t.byVendor) as Vendor[], t.localRuns > 0)}
  <div class="stage-scroll">${drawStory(s, owner, { compact: true, replaySeconds: 6, href: taskHref(s.project) })}</div>
  <a href="/flow">See the whole flow</a>
</div>`;
}

// Latest moves is a list, not a chart, so its dots carry no company colour:
// red for a catch, the accent for the owner, neutral for everything else.
const MOMENT_COLOUR = (m: Story["moments"][number], owner: string) =>
  m.tone === "catch" ? "var(--fault)" : m.tone === "merge" ? "var(--main-line)" : m.actor === owner ? "var(--m-owner)" : "var(--text-muted)";

// A page's numbers count only the projects whose threads it draws, so the
// headline and the picture agree. Callers' totals are not used.
// A story has tasks when it draws a thread, or when its tally, counted over
// the whole record (Story.counted), saw a task taken that the drawing's
// window no longer reaches (t578).
const hasTasks = (s: Story) => s.threads.length > 0 || (s.counted?.taken ?? 0) > 0;
const tasksOf = (s: Story) => s.counted?.taken ?? s.threads.length;
const drawnTotal = (stories: Story[]) => stories.filter(hasTasks).reduce((acc, s) => addTally(acc, s.tally), emptyTally());

interface FlowParts { stages: string; moments: string; journey: string; shown: Story[] }

// The parts Flow, a project's Flow tab and the public showcase share. `href`
// links a task, or nothing on the public page. A project's history before
// Atelier, read from git: drawn below its threads, framed and labelled as
// imported, never counted in the tally.
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
const noTasks = (s: Story) => !hasTasks(s) && !s.tally.planned && !s.partial;

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
// before its first task and tasks since (of those with a substantial imported
// history, the one with the most tasks), shown on both sides as itself, but
// only when its imported history is substantial or no other shown project is
// known only from git; otherwise `before` is that git-only project with the
// largest imported history, and the record Atelier kept of the shown
// projects' tasks stands against it.
function comparePick(stories: Story[], imported: Map<string, ImportedHistory>): { same?: Story; before?: Story } {
  const total = (s: Story) => imported.get(s.project)?.total ?? 0;
  const both = stories.filter((s) => hasTasks(s) && total(s) > 0);
  const byTasks = (a: Story, b: Story) => tasksOf(b) - tasksOf(a);
  const same = both.filter((s) => total(s) >= SAME_MIN).sort(byTasks)[0] ?? both.sort(byTasks)[0];
  const before = stories.filter((s) => noTasks(s) && total(s) > 0).sort((a, b) => total(b) - total(a))[0];
  if (same && (total(same) >= SAME_MIN || !before)) return { same };
  return before ? { before } : {};
}

// Before and with Atelier, side by side, as the showcase's first section after
// its hero. When one project holds both a substantial history from before its
// first task and tasks since, that project is shown on both sides: its own git
// history beside its own Atelier record. Otherwise the git-only project with
// the largest imported history stands before the record Atelier kept of the
// shown projects' tasks. Each side says its window only when it is the same
// project's, and what was not read in full.
export function compareBlock(stories: Story[], imported: Map<string, ImportedHistory>, t: Tally, _owner: string, who: string): string {
  const pick = comparePick(stories, imported);
  const same = pick.same;
  const before = same ?? pick.before;
  const withs = same ? [same] : stories.filter(hasTasks);
  if (!before || !withs.length || (!same && !t.claims)) return "";
  if (same) t = same.tally;
  const h = imported.get(before.project)!;
  const named = h.lanes.filter((l) => l.label !== NO_AGENT);
  const n = (v: number) => v.toLocaleString("en");
  const row = (v: number | null, label: string) => v === null
    ? `<div class="none"><dt>—</dt><dd>${e(label)}</dd></div>`
    : `<div><dt>${n(v)}</dt><dd>${e(label)}</dd></div>`;
  const withTitle = withs.map((s) => e(s.title)).join(" and ");
  const tasks = withs.reduce((sum, s) => sum + tasksOf(s), 0);
  const reviews = t.approvals + t.sentBack;
  // A share that rounds to 0% or 100% without being exactly that says so.
  const pct = (a: number, d: number) => {
    const p = Math.round((a / d) * 100);
    return p === 0 && a > 0 ? "<1%" : p === 100 && a < d ? ">99%" : `${p}%`;
  };
  // Dates for the same-project card. The commits' span is from the messages'
  // own times; the Atelier side starts at the first thing the record shows.
  // A tally counted over the whole record (Story.counted) begins at its first event.
  const began = same ? (same.counted ? same.counted.from ?? undefined : [...same.moments].sort((a, b) => a.at.localeCompare(b.at))[0]?.at) : undefined;
  const beforeDates = same
    ? `<p class="compare-dates">${e(spanLabel(h.first, h.last))}${h.complete ? "" : " · only the most recent part of the history was read"}</p>` : "";
  const withDates = same && began
    ? `<p class="compare-dates">since ${e(dayLabel(began, false))}${same.partial && !same.counted ? " · only the most recent part of the record was read" : ""} · the same project</p>` : "";
  return `<section class="show-section compare-section" aria-labelledby="compare-h">
  <h2 class="show-h2" id="compare-h">Git keeps what a commit claims. Atelier keeps what happened.</h2>
  <div class="compare">
  <article class="compare-card before">
    <p class="compare-kicker"><span>Before Atelier · from git</span><span>${e(before.title)}</span></p>
    ${beforeDates}
    <p class="compare-lead"><b>${e(pct(h.attributed, h.total))}</b><span>of commits name an agent. Nothing else about them is recorded.</span></p>
    <dl>${row(h.total, `commits${h.complete ? "" : " (the most recent part)"}`)}${row(h.attributed, `name ${plural(named.length, "agent")} in their messages`)}${row(null, "checks tied to a revision")}${row(null, "reviews by another model")}${row(null, `decisions by ${who}`)}</dl>
  </article>
  <article class="compare-card with">
    <p class="compare-kicker"><span>With Atelier · observed</span><span>${withTitle}</span></p>
    ${withDates}
    ${reviews ? `<p class="compare-lead"><b>${e(pct(t.sentBack, reviews))}</b><span>of reviews sent the work back: ${n(t.sentBack)} of ${n(reviews)}.</span></p>` : ""}
    <dl>${row(tasks, `${tasks === 1 ? "task" : "tasks"} taken, each by one agent on its own fork`)}${row(t.checks, "checks run on a clean copy of the exact revision")}${row(reviews, `reviews, ${n(t.sentBack)} sending work back`)}${row(t.decisions, `decisions by ${who}`)}${row(t.merges, "merged, with their record attached")}</dl>
  </article>
  </div>
</section>`;
}

function flowParts(stories: Story[], t: Tally, owner: string, href?: (s: Story) => (th: { id: string }) => string, who = "You", imported: Map<string, ImportedHistory> = new Map()): FlowParts {
  const shown = stories.filter((s) => s.threads.length || imported.get(s.project)?.total);
  const many = shown.length > 1;
  // One picture of the latest moves: the newest moments across whatever the
  // caller draws, named for whether it spans projects (finding 19).
  const momentsList = shown
    .flatMap((s) => s.moments.map((m) => ({ ...m, project: s.title })))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 14);
  const stages = shown.map((s) => `<section class="stage" id="${e(s.project)}" aria-label="${e(s.title)}">
  <div class="stage-head"><h2>${e(s.title)}</h2><span class="meta">${s.threads.length
    ? `${plural(s.threads.length, "task")} taken · ${s.tally.merges} merged · ${plural(s.tally.agents.length, "agent")}${s.partial ? " · the most recent part of the record" : ""}`
    : noTasks(s) ? "History imported from git · no Atelier tasks yet" : `${plural(s.tally.planned, "task")} planned, none taken yet${s.partial ? " · the most recent part of the record" : ""}`}</span></div>
  ${s.threads.length ? `<div class="stage-scroll">${drawStory(s, owner, { ...(href ? { href: href(s) } : {}), ...(who === "You" ? {} : { ownerLabel: who }) })}</div>` : imported.get(s.project)?.total ? "" : `<p class="meta stage-empty">No Atelier tasks yet.</p>`}
  ${importedBlock(imported.get(s.project), owner, s.title, s.project)}
</section>`).join("");
  const yours = who === "You" ? "your" : `${who}'s`;
  // The five steps of src/how-data.ts, each said for this owner and counted.
  const said: Record<Verb, [text: string, count: string]> = {
    Claim: [`${cap(who)} ${who === "You" ? "describe" : "describes"} an outcome; it becomes a task with a scope. One agent claims it, and a second claim is refused.`, `${plural(t.planned, "task")} planned, ${plural(t.claims, "claim")}, ${plural(t.handoffs, "handoff")}`],
    Fork: [`The task gets its own fork in Cloudflare Artifacts, and nobody else can write there. The agent commits and pushes to its fork, never to ${yours} checkout.`, `${plural(t.pushes, "push", "pushes")}`],
    Prove: ["The project's checks run in a fresh clone of exactly the pushed head, on the machine that asks for them; in a Cloudflare container only with --sandbox, or where the project requires it.", `${plural(t.checks, "check")} observed${t.inCloud ? `, ${t.inCloud} in Cloudflare` : ""}`],
    Review: [`Changes to protected files need an approval from a model of another family than every contributor by default, or a different model of the selected company from every contributor in single-family mode; ${yours} own approval does not count. Without one, ${who === "You" ? "you" : who} can accept only by recording an override with its reason.`, `${plural(t.approvals, "approval")}, ${t.sentBack} sent back`],
    Land: [`${cap(who)} ${who === "You" ? "accept" : "accepts"} one revision on the diff, the evidence and the reviews. It merges into main on ${yours} machine, one landing at a time, with its whole history attached as a git note.`, `${plural(t.accepts, "acceptance")}, ${t.merges} merged`],
  };
  const journey = STEPS.map((s) => `<li><h3>${e(s.verb)}</h3><p><span class="motto">${e(s.line)}</span> ${e(said[s.verb][0])}</p><span class="n">${e(said[s.verb][1])}</span></li>`).join("");
  const moments = `<section aria-label="Latest moves"><h2>${many ? "Latest moves across projects" : "Latest moves"}</h2><ol class="moments">${momentsList.map((m) =>
    `<li class="${m.tone}"><span class="dot" style="--c:${MOMENT_COLOUR(m, owner)}"></span><time datetime="${e(m.at)}">${e(shortStamp(m.at))}</time><p>${many ? `<span class="meta">${e(m.project)} · </span>` : ""}${e(m.text)}</p></li>`).join("")}</ol></section>`;
  const journeySection = `<section aria-label="How a task travels"><h2>How a task travels</h2><ol class="journey">${journey}</ol><p class="takeaways">${e(TAKEAWAYS)}</p><p class="meta">${e(TAGLINE)}</p></section>`;
  return { stages, moments, journey: journeySection, shown };
}

export function renderFlow(stories: Story[], _total: Tally, owner: string, ownerName: string | null = null, unavailable = false, imported: Map<string, ImportedHistory> = new Map(), sinceParam = "all", familyParam?: string, familiesPresent: string[] = [], live?: Live): string {
  const t = drawnTotal(stories);
  const { stages, moments, journey, shown } = flowParts(stories, t, owner, (s) => taskHref(s.project), "You", imported);
  const body = shown.length
    ? `${legendLine(vendorsIn(shown), shown.some(s => s.tally.localRuns > 0))}${stages}<div class="flow-cols">${moments}${journey}</div>`
    : `<div class="empty"><h3>No work yet.</h3><p>When an agent claims a task, its thread appears here, from claim to merge.</p></div>`;

  const link = (s: string, f: string | undefined) => `?since=${e(s)}${f ? `&amp;family=${e(f)}` : ''}`;
  const sinceLinks = [["1d", "last day"], ["7d", "last week"], ["all", "all time"]]
    .map(([val, label]) => `<a href="${link(val, familyParam)}"${sinceParam === val ? ' aria-current="page"' : ''}>${e(label)}</a>`).join('');

  // Company colours live only inside charts; the family filter is a plain
  // tab like the time filter beside it.
  const fams = VENDOR_NAMES.filter(([v]) => familiesPresent.includes(v));
  const familyLinks = fams.map(([v, label]) => `<a href="${link(sinceParam, v)}"${familyParam === v ? ' aria-current="page"' : ''}>${e(label)}</a>`).join('');
  const allFamiliesLink = `<a href="${link(sinceParam, undefined)}"${!familyParam ? ' aria-current="page"' : ''}>all families</a>`;

  // The filter labels carry their own class: the row wraps at any width, and
  // no inline style decides their alignment (finding 2).
  const filters = `<nav class="repo-tabs" aria-label="Filters">
    <span class="meta filter-label">Time:</span>${sinceLinks}
    ${familiesPresent.length > 0 ? `<span class="meta filter-label filter-label-gap">Family:</span>${allFamiliesLink}${familyLinks}` : ''}
  </nav>`;

  // The hero is one row: the headline beside its tally, nothing above the
  // graph but the filters (finding 10).
  return page("Flow", `<div class="page-width flow">
  <header class="flow-hero">
    <div><span class="kicker">Atelier · every project · from the ledger</span>
      <h1>${headline(t)}</h1></div>
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
// task titled by its kind of work, and no commit hash anywhere, so no project
// name, task title, path, commit message, commit hash, review note, person or
// address reaches the HTML.

export const REPO_URL = "https://github.com/pavithran/atelier";

// One shown project as the portfolio draws it: the project's record (for its
// title when named), how it is shown, its story, its two weeks of moves
// for the card's bar graph when the events were read, and every merge it has
// ever had, from its whole item list.
export interface ShownProject {
  project: ProjectRecord;
  mode: "named" | "anonymous";
  story: Story;
  pulse?: Pulse;
  allTimeMerged?: number;
  landedFast?: number;         // tasks landed in fast mode, all time, apart from allTimeMerged (t585)
  inProgress?: number;         // tasks claimed, submitted or accepted now, from the items
  featured?: Story;            // one merged task, told from its own events
}

// The task stories under the cards: two or three threads from different shown
// projects, the ones with the most recorded moves, each drawn alone.
// Only a merged task is told: an open or failing one is no story yet (t578).
// A card's featured task, read from its own events, comes first.
function taskStories(cards: ShownProject[]): { card: ShownProject; thread: Story["threads"][number]; one: Story }[] {
  const featured = cards.flatMap((card) => card.featured?.threads.filter((th) => th.ending === "merged").map((thread) => ({ card, thread, one: { ...card.featured!, threads: [thread] } })) ?? [])
    .sort((a, b) => (b.thread.beads.some((x) => x.kind === "reject") ? 1 : 0) - (a.thread.beads.some((x) => x.kind === "reject") ? 1 : 0) || b.thread.beads.length - a.thread.beads.length);
  if (featured.length) return featured.slice(0, 3);
  const best = new Map<ShownProject, Story["threads"][number]>();
  for (const { card, thread } of cards.flatMap((card) => card.story.threads.filter((th) => th.ending === "merged").map((thread) => ({ card, thread })))
    .sort((a, b) => b.thread.beads.length - a.thread.beads.length)) {
    if ([...best.keys()].some((other) => other.story.project === card.story.project)) continue;
    if (!best.has(card)) best.set(card, thread);
    if (best.size >= 3) break;
  }
  return [...best].map(([card, thread]) => ({ card, thread, one: { ...card.story, threads: [thread] } }));
}

// A card's label: the project's title when named, its neutral kind otherwise.
const shownLabel = (c: ShownProject) => (c.mode === "anonymous" ? cap(c.story.title) : c.story.title);

// One glyph per kind of move in the showcase's feed (d9), in place of a
// family's colour: the text says who and what, the glyph only sorts the
// kinds at a glance. Red is for a catch, green for a merge.
const MOVE_GLYPH: Record<string, [glyph: string, tone: string]> = {
  "item.claimed": ["□", ""],
  "item.submitted": ["◇", ""],
  "item.handoff": ["⇄", "quiet"],
  "item.dispatched": ["→", "quiet"],
  "item.abandoned": ["–", "quiet"],
  "review.rejected": ["▽", "catch"],
  "review.overridden": ["!", "caution"],
  "evidence.observed": ["×", "catch"],
  "item.accepted": ["●", "merge"],
  "item.merged": ["●", "merge"],
};

export interface FeedRow { at: string; kind: string; text: string; project: string; times: number; since: string }

// The showcase's latest moves, newest first. An acceptance followed by its
// merge is one row, and a move repeated back to back (the same words in the
// same project) is one row that says how many times and over how long
// (t530). Nothing is counted that the stories do not hold. Moves of one
// instant keep the ledger's order by their position, newest first, so a merge
// recorded in the acceptance's millisecond still follows it.
export function foldMoves(moments: { at: string; kind: string; text: string; item: string; project: string; pos?: number }[], limit = 10): FeedRow[] {
  const sorted = [...moments].sort((a, b) => b.at.localeCompare(a.at) || (b.pos ?? 0) - (a.pos ?? 0));
  const joined: Omit<FeedRow, "times" | "since">[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i], older = sorted[i + 1];
    if (m.kind === "item.merged" && older?.kind === "item.accepted" && older.item === m.item && older.project === m.project && m.text.startsWith(`${m.item} `)) {
      joined.push({ at: m.at, kind: m.kind, project: m.project, text: `${older.text}; ${m.text.slice(m.item.length + 1)}` });
      i++;
      continue;
    }
    joined.push({ at: m.at, kind: m.kind, project: m.project, text: m.text });
  }
  const rows: FeedRow[] = [];
  for (const m of joined) {
    const last = rows.at(-1);
    if (last && last.text === m.text && last.project === m.project) { last.times++; last.since = m.at; continue; }
    if (rows.length === limit) break;
    rows.push({ ...m, times: 1, since: m.at });
  }
  return rows;
}

// How long a folded row's repeats took, in the largest whole unit.
function foldSpan(from: string, to: string): string {
  const min = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));
  if (min < 120) return `${min} min`;
  const hours = Math.round(min / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}

// The seven steps a task travels, each said for this owner and counted from
// the tally the page draws.
function travelSteps(t: Tally, who: string): string {
  const n = (v: number) => v.toLocaleString("en");
  const steps: [name: string, text: string, count: string, tone?: string][] = [
    ["Planned", `${cap(who)} describes an outcome; it becomes a task with a scope.`, `${n(t.planned)} planned`],
    ["Claimed", "One agent takes it and gets its own fork. Nobody else can write there.", `${plural(t.claims, "claim")}, ${plural(t.handoffs, "handoff")}`],
    ["Worked", `The agent pushes to its fork, never to ${who}'s checkout.`, plural(t.pushes, "push", "pushes")],
    ["Checked", "The checks run in a fresh clone of exactly the pushed head, on the machine that asks for them; in a Cloudflare container only with --sandbox, or where the project requires it.", `${n(t.checks)} observed${t.inCloud ? `, ${n(t.inCloud)} in Cloudflare` : ""}`, "observed"],
    ["Reviewed", "A model of another family than every contributor approves, or sends it back; in single-family mode, another model of the one company.", `${n(t.approvals)} approved, ${n(t.sentBack)} sent back`],
    ["Decided", `${cap(who)} sees the diff, the evidence and the reviews, and accepts one revision.`, `${n(t.accepts)} accepted`],
    ["Merged", `Into main on ${who}'s machine, its history attached as a git note.`, `${n(t.merges)} merged`],
  ];
  return `<ol class="travel">${steps.map(([name, text, count, tone], i) =>
    `<li><span class="travel-n">${i + 1}</span><h3>${name}</h3><p>${e(text)}</p><span class="travel-count${tone ? ` ${tone}` : ""}">${e(count)}</span></li>`).join("")}</ol>`;
}

// Where Atelier runs, layer by layer, in the canvas's short form; the
// diagram with every arrow is on /how.
const RUNS_ON: [layer: string, parts: string[], tone?: string][] = [
  ["Who acts", ["Browser · the pages", "Terminal · <code>atelier plan \"goal\"</code>", "Orchestrator · starts agents", "Home runner · build, plan, review jobs"]],
  ["Your Mac", ["the <code>atelier</code> CLI", "one workspace per task, a clone of its fork"]],
  ["Agents", ["Claude Code · Opus, Sonnet, Fable", "Codex · gpt-6-astra", "Antigravity · Gemini, GPT-OSS", "opencode · GLM, DeepSeek, OpenRouter"]],
  ["Cloudflare", ["Worker · pages, API, the gate", "Durable Objects · a ledger per project", "Check container · npm registry only", "Artifacts · baseline and task forks"], "cloud"],
];

const tallyHeadline = (t: Tally, who: string) =>
  `${e(cap(who))} made ${plural(t.decisions, "decision")}. ${t.agents.length ? `${plural(t.agents.length, "agent")} did the other ${t.agentMoves.toLocaleString("en")} moves.` : "No agent has started yet."}`;

export function renderShowcase(stories: Story[], _total: Tally, owner: string, ownerName: string | null, unavailable = false, imported: Map<string, ImportedHistory> = new Map(), shown?: ShownProject[]): string {
  // Without the server's portfolio view (a direct render), the stories stand
  // as the portfolio themselves, shown named.
  const cards = shown ?? stories.map((s): ShownProject => ({ project: { name: s.project, repo: s.project, policy: { checks: [], protected: [] }, createdAt: "" }, mode: "named", story: s }));
  const total = drawnTotal(stories);
  const who = ownerName || "the owner";
  const drawn = stories.filter((s) => s.threads.length || imported.get(s.project)?.total);
  const n = (v: number) => v.toLocaleString("en");

  // The tally's window: from the oldest to the newest event read of the
  // projects whose threads it counts.
  // A tally the Ledger counted over the whole record spans that record.
  const counted = stories.filter(hasTasks);
  const ats = counted.flatMap((s) => s.counted ? [s.counted.from ?? "", s.counted.to ?? ""] : s.times.map((x) => x.at)).filter(Boolean).sort();
  const window = ats.length
    ? `${spanLabel(Date.parse(ats[0]) / 1000, Date.parse(ats[ats.length - 1]) / 1000)}${counted.some((s) => s.partial && !s.counted) ? " · the most recent part of the record" : ""}`
    : "";
  const tally = `<section class="show-band" aria-labelledby="tally-h"><div class="show-section">
    <h2 class="show-h2" id="tally-h">${tallyHeadline(total, who)}</h2>
    ${window ? `<p class="show-window">${e(window)}</p>` : ""}
    <dl class="show-tally">
      <div><dt>agent moves</dt><dd>${n(total.agentMoves)}</dd></div>
      <div class="you"><dt>${e(`${who}'s`)} decisions</dt><dd>${n(total.decisions)}</dd></div>
      <div class="cloud"><dt>checks run on a clean copy${total.inCloud ? `, ${n(total.inCloud)} in Cloudflare` : ""}</dt><dd>${n(total.checks)}</dd></div>
      <div class="catch"><dt>times a model sent work back</dt><dd>${n(total.sentBack)}</dd></div>
    </dl>
    <p class="evidence-key" aria-label="How evidence is graded"><span class="evidence-title">Evidence</span><span><span class="grade observed">Observed</span>counts</span><span><span class="grade reported">Reported</span>shown, not counted</span><span><span class="grade pending">Pending</span>not yet run</span></p>
  </div></section>`;

  const cardList = cards.map((c, i) => {
    const t = c.story.tally;
    const inProgress = c.inProgress ?? c.story.threads.filter((th) => th.end === null && ["claimed", "submitted", "accepted"].includes(th.state)).length;
    const families = VENDOR_NAMES.filter(([v]) => v !== "owner" && t.byVendor[v])
      .map(([v, label]) => `<li><i style="--c:var(--m-${v})"></i>${e(label)}</li>`).join("");
    if (!families) return `<li class="show-card idle" id="card-${i + 1}"><h3>${e(shownLabel(c))}</h3><p class="idle-note">No agent has worked here yet.</p></li>`;
    const figure = (v: number, label: string) => `<div><dt>${label}</dt><dd>${n(v)}</dd></div>`;
    return `<li class="show-card" id="card-${i + 1}">
    <h3>${e(shownLabel(c))}</h3>
    ${c.pulse ? pulseGraph(c.pulse, false) : ""}
    <dl class="card-figures">${figure(c.pulse?.merges ?? t.merges, "merged, last two weeks")}${c.allTimeMerged === undefined ? "" : figure(c.allTimeMerged, "merged, all time")}${c.landedFast ? figure(c.landedFast, "landed in fast mode, all time") : ""}${figure(c.pulse?.sentBack ?? t.sentBack, "sent back, last two weeks")}${figure(inProgress, "in progress, last two weeks")}</dl>
    <ul class="legend-line" aria-label="Who worked on it">${families}${t.decisions ? `<li><i style="--c:var(--m-owner)"></i>${e(cap(who))}</li>` : ""}</ul>
  </li>`;
  }).join("");

  // One merged task: one a review sent back first when there is one, then the one with the most recorded moves.
  const pick = taskStories(cards)[0];
  const story = pick ? `<section class="show-section" aria-labelledby="story-h" id="story">
    <h2 class="show-h2" id="story-h">One task, as it happened</h2>
    <p class="show-window">${e(pick.thread.id)} · ${e(cap(pick.thread.title))}${cards.length > 1 ? ` · ${e(shownLabel(pick.card))}` : ""}</p>
    <figure class="show-story">
      <div class="stage-scroll">${drawStory(pick.one, owner, { replaySeconds: 9, ownerLabel: cap(who) })}</div>
      ${legendLine(vendorsIn([pick.one]), pick.one.tally.localRuns > 0, cap(who))}
    </figure>
  </section>` : "";

  const many = cards.length > 1;
  const rows = foldMoves(drawn.flatMap((s) => s.moments.map((m) => ({ ...m, project: shownLabel(cards.find((c) => c.story.project === s.project) ?? { mode: "named", story: s } as ShownProject) }))));
  const feed = rows.map((r) => {
    const [glyph, tone] = MOVE_GLYPH[r.kind] ?? ["·", "quiet"];
    const fold = r.times > 1 ? ` <span class="fold">×${r.times} in ${e(foldSpan(r.since, r.at))}</span>` : "";
    return `<li><span class="glyph ${tone}" aria-hidden="true">${glyph}</span><time datetime="${e(r.at)}">${e(shortStamp(r.at))}</time><p>${many ? `<span class="meta">${e(r.project)} · </span>` : ""}${e(r.text)}${fold}</p></li>`;
  }).join("");
  const moves = `<section class="show-section show-moves" aria-labelledby="moves-h">
    <div><h2 class="show-h2" id="moves-h">Latest moves</h2><p class="show-window">times in ${e(zoneLabel())}</p></div>
    ${rows.length ? `<ol class="feed">${feed}</ol>` : `<p class="feed-empty">Nothing to show yet: the projects shown here have no claimed tasks.</p>`}
  </section>`;

  const where = `<section class="show-section" aria-labelledby="where-h" id="where">
    <h2 class="show-h2" id="where-h">Where it runs</h2>
    <dl class="runs-on">${RUNS_ON.map(([layer, parts, tone]) => `<div${tone ? ` class="${tone}"` : ""}><dt>${layer}</dt><dd>${parts.map((p) => `<span>${p}</span>`).join("")}</dd></div>`).join("")}</dl>
  </section>`;

  return publicPage({
    title: "Atelier · public showcase",
    description: `Atelier: several coding agents on one codebase. Claim, fork, prove, review, land. ${TAKEAWAYS} A Git platform on Cloudflare Workers and Artifacts.`,
    brand: "/",
    nav: [["How it works", "/how"], ["Source on GitHub", REPO_URL], ["Sign in", "/login"]],
    mainClass: "showcase",
    night: true,
    bodyClass: "show-page",
    main: `
  <header class="show-section show-hero" id="top">
    <p class="kicker">Public showcase · read only · from the ledger</p>
    <h1>A Git platform for multiple coding agents</h1>
    <p class="show-lead">Agents of several model families work one repository at once. Atelier runs their checks itself, has a model of another family review each change, and leaves the merge to the person who owns the project.</p>
    ${unavailable ? '<p role="status" class="error">A project could not be read just now; this page may be incomplete.</p>' : ""}
  </header>
  ${compareBlock(stories, imported, total, owner, who)}
  ${tally}
  <section class="show-section" aria-labelledby="portfolio-h" id="cards">
    <h2 class="show-h2" id="portfolio-h">The portfolio</h2>
    <ul class="show-cards">${cardList}</ul>
  </section>
  ${story}
  <section class="show-section" aria-labelledby="travels-h" id="travels">
    <h2 class="show-h2" id="travels-h">How a task travels</h2>
    ${travelSteps(total, who)}
  </section>
  ${moves}
  ${where}
  <footer class="show-foot"><div class="show-foot-in">
    <p class="public-note">Shown read only. Projects the owner names are named; the others are shown anonymised, with no project name, task title, path, commit message, commit hash or address in them. Review notes, reports and diffs stay private in every case.</p>
    <p class="show-foot-links"><a href="/how">How it works</a><a href="${REPO_URL}">Source on GitHub</a></p>
  </div></footer>
`,
  });
}

// ── models ─────────────────────────────────────────────────────────────────
// The pool: every model the owner has made available, where it runs, how it
// is reached, what the runner last found, and what the record says it did.

const STATUS_TONE: Record<string, string> = { available: "go", refused: "bad", slow: "ask", unknown: "" };

export function renderModels(entries: ModelEntry[], record: ModelRecord, ownerName: string | null = null, error = "", window: { events: number; unread: string[] } = { events: 1000, unread: [] }, reliability: Reliability = new Map(), gateway: GatewayView | null = null, precision: PrecisionRecord | null = null, speed: SpeedRecord | null = null, judgement: JudgementRecord | null = null): string {
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
    // The owner's standing, shown with when it was set; available is not shown.
    const held = m.state && m.state !== "available"
      ? `${tag(m.state, "ask")}<span class="meta">set ${e(when(m.stateAt ?? m.addedAt))}${m.state === "reserved" && m.note ? ` · ${e(m.note)}` : ""}</span>`
      : "";
    const standing = [m.roles?.length ? `${tag(m.roles.join(", "))}<span class="meta">the jobs it may take</span>` : "", m.tier ? `${tag(m.tier)}<span class="meta">tier</span>` : ""].filter(Boolean).join(" ");
    const how = [e(m.harness), e(m.provider), m.endpoint ? `<code>${e(m.endpoint)}</code>` : "", m.keychain ? `key in Keychain <code>${e(m.keychain)}</code>` : ""].filter(Boolean).join(" · ");
    return `<li class="model">
  <div class="model-head"><strong class="mono">${e(m.id)}</strong>${m.family === "other" ? tag("family not recognised", "ask") : `<span class="meta">${e(m.family)}</span>`}</div>
  <p class="meta">${how}</p>
  ${m.aliases.length ? `<p class="meta">Also known as ${m.aliases.map((a) => `<code>${e(a)}</code>`).join(", ")}</p>` : ""}
  <p class="model-status">${status}${held ? ` ${held}` : ""}</p>
  ${standing ? `<p class="meta">${standing}</p>` : ""}
  <p class="meta">${r.claimed ? `Took ${plural(r.claimed, "task")}, merged ${r.merges}; checks ${r.pass} passed, ${r.fail} failed; sent back ${plural(r.back, "time")}.` : "No work recorded yet."}</p>
  ${across.map((x) => `<p class="meta">Across projects${across.length > 1 ? ` as <code>${e(x.model)}</code>` : ""}: ${e(reliabilityLine(x))}</p>`).join("")}
  ${m.note ? `<p class="meta">${e(m.note)}</p>` : ""}
  ${[...(m.notes ?? [])].reverse().map((n) => `<p class="meta model-note">${when(n.at)} · ${e(n.by)}${n.item ? ` on <code>${n.project ? `${e(n.projectName ?? n.project)}/` : ""}${e(n.item)}</code>` : ""}: ${e(n.text)}</p>`).join("")}
  <form method="post" action="/models/remove" class="inline model-remove"><input type="hidden" name="id" value="${e(m.id)}"><button class="quiet">Remove</button></form>
</li>`;
  };
  const group = (where: "home" | "cloud", title: string, none: string) => {
    const list = entries.filter((m) => m.where === where);
    return `<h2 class="section-title">${title} · ${list.length}</h2>${list.length ? `<ul class="model-grid">${list.map(card).join("")}</ul>` : `<p class="empty">${none}</p>`}`;
  };
  const opts = (values: readonly string[]) => values.map((v) => `<option>${e(v)}</option>`).join("");
  return page("Models", `<div class="page-width">
  <header><h1>Models</h1><p class="lead">${plural(entries.length, "model")} in the pool. The runner on your machine checks each one and reports what it found.</p>
  <p class="meta">Each model's record counts all ${window.events.toLocaleString("en")} events of every project${window.unread.length ? `; ${window.unread.map(e).join(", ")} could not be read just now, so ${window.unread.length === 1 ? "its" : "their"} work is not counted` : ""}.</p></header>
  ${error ? `<p role="alert" class="error">${e(error)}</p>` : ""}
  ${group("home", "At home", "No home models yet. Add one served by your Mac Studio or another local server.")}
  ${group("cloud", "In the cloud", "No cloud models yet. Add one reached through a harness sign-in or an API key in your Keychain.")}
  ${reliabilitySection(reliability, ownerName, window)}
  ${precision ? precisionSection(precision) : ""}
  ${judgement ? judgementSection(judgement) : ""}
  ${speed ? speedSection(speed) : ""}
  ${gateway ? gatewaySection(gateway) : ""}
  <details class="new-task"><summary>+ Add a model</summary>
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

// ── review precision ───────────────────────────────────────────────────────
// Each reviewer model's precision on the blocking findings the owner judged
// over the window (src/models/precision.ts): judged n, held up (confirmed or
// fixed), refuted, and the share held up. Under PRECISION_MIN_JUDGED judged
// the row shows n and says it is too few to rank, as routing treats it.

export function precisionSection(p: PrecisionRecord): string {
  const from = p.window.from.slice(0, 10), to = p.window.to.slice(0, 10);
  const rows = [...p.models.values()];
  const row = (r: ReviewerPrecision) => `<tr><th scope="row"><code>${e(r.model)}</code><span class="meta">${r.actors.map(e).join(", ")}</span></th>
    <td class="num">${r.judged}</td>
    <td class="num">${r.upheld}<span class="meta">${r.confirmed} confirmed · ${r.fixed} fixed</span></td>
    <td class="num">${r.refuted}</td>
    <td class="num">${r.ranked ? `${Math.round(r.precision! * 100)}%<span class="meta">routing term ${precisionTerm(r).toFixed(2)}</span>` : `<span class="meta">n=${r.judged}, too few to rank</span>`}</td></tr>`;
  return `<section class="precision" aria-label="Review precision by reviewer">
  <h2 class="section-title">Review precision · ${e(from)} to ${e(to)}</h2>
  <p class="meta">Of each reviewer's blocking findings the owner judged with <code>atelier finding</code> from ${e(from)} to ${e(to)} (the last ${p.window.days} days, every project), the share that held up: confirmed or fixed, over all judged. Each finding counts once, by its newest verdict. Routing asks qualifying reviewers in order of this precision, smoothed by one held and one refuted, and only after every rule has passed: another family than every contributor by default, or a different model of the selected company from every contributor in single-family mode, available and allowed. With fewer than ${PRECISION_MIN_JUDGED} judged a reviewer is too few to rank and orders as neutral.</p>
  ${rows.length ? `<table class="usage-table">
    <thead><tr><th scope="col">Reviewer</th><th scope="col">Judged blocking findings</th><th scope="col">Held up</th><th scope="col">Refuted</th><th scope="col">Precision</th></tr></thead>
    <tbody>${rows.map(row).join("")}</tbody>
  </table>` : `<p class="empty">No blocking finding was judged from ${e(from)} to ${e(to)}.</p>`}
</section>`;
}

// ── the orchestrator's judgements ──────────────────────────────────────────
// Each harness/model that acted for the owner (src/models/judgement.ts): its
// verdicts on findings, split into upheld, contradicted and unresolved, and
// apart from them the decisions and overrides it recorded, which have no
// outcome and get no score. Events no model was named on are one row of
// their own, unknown.

export function judgementSection(j: JudgementRecord): string {
  const from = j.window.from.slice(0, 10), to = j.window.to.slice(0, 10);
  const totals = judgementTotals(j);
  const rows = [...j.models, ...(judged(j.unknown) ? [j.unknown] : [])];
  const row = (r: ActingJudgement) => `<tr><th scope="row">${r.model ? `<code>${e(r.model)}</code><span class="meta">${r.actors.map(e).join(", ")}</span>` : `unknown<span class="meta">no acting model recorded</span>`}</th>
    <td class="num">${r.verdicts}</td><td class="num">${r.upheld}</td><td class="num">${r.contradicted}</td><td class="num">${r.unresolved}</td>
    <td class="num">${r.decisionsRecorded}<span class="meta">${r.decisionsWithdrawn} withdrawn</span></td><td class="num">${r.overrides}</td></tr>`;
  const causes = rows.flatMap((r) => r.contradictions.map((c) => ({ ...c, model: r.model })));
  return `<section class="judgement" aria-label="Judgements by acting model">
  <h2 class="section-title">The orchestrator's judgements · ${e(from)} to ${e(to)}</h2>
  <p class="meta">What each harness/model acting for the owner recorded from ${e(from)} to ${e(to)} (the last ${j.window.days} days, every project), named with <code>--as</code>; the authority stays the owner's. The acting model is declared, not verified: Atelier checks it names a model in the pool, but the owner token cannot prove which model typed the command. A verdict on a finding is upheld when a later verdict by another named model agrees, contradicted when a later verdict corrects it or a defect names it with <code>atelier defect --contradicts</code>, and unresolved otherwise: no defect is not proof a verdict was right. Decisions and overrides are counted, never scored. Events recorded before Atelier kept the acting model, or without one, stay unknown.</p>
  <p class="meta">Totals: ${plural(totals.verdicts, "verdict")}: ${totals.upheld} upheld, ${totals.contradicted} contradicted, ${totals.unresolved} unresolved; ${plural(totals.decisionsRecorded, "decision")} recorded, ${totals.decisionsWithdrawn} withdrawn; ${plural(totals.overrides, "override")}.</p>
  ${rows.length ? `<table class="usage-table">
    <thead><tr><th scope="col">Acting model (declared)</th><th scope="col">Verdicts</th><th scope="col">Upheld</th><th scope="col">Contradicted</th><th scope="col">Unresolved</th><th scope="col">Decisions</th><th scope="col">Overrides</th></tr></thead>
    <tbody>${rows.map(row).join("")}</tbody>
  </table>` : `<p class="empty">Nothing was judged for the owner from ${e(from)} to ${e(to)}.</p>`}
  ${causes.length ? `<ul class="causes">${causes.map((c) => `<li class="meta">${when(c.at)} · ${c.model ? `<code>${e(c.model)}</code>` : "unknown"}'s verdict (event ${c.event}) on <code>${e(c.project)}/${e(c.item)}</code> ${c.by === "defect" ? "contradicted by a defect" : "corrected"}: ${e(c.note)}</li>`).join("")}</ul>` : ""}
</section>`;
}

// ── AI Gateway ─────────────────────────────────────────────────────────────
// Each model's calls through the AI Gateway over the view's window, from the
// GraphQL Analytics API (src/usage/gateway.ts): calls and failures, tokens,
// cost, and the median and 90th percentile duration with the number of calls
// they are taken over, and the calls per task the runners' cf-aig-metadata
// tags name. Off, refused or empty, the section says which.

export function gatewaySection(g: GatewayView): string {
  const head = `<h2 class="section-title">AI Gateway · last ${g.days} days</h2>`;
  if (g.off) return `<section class="gateway" aria-label="AI Gateway costs">${head}<p class="empty">${e(g.off)}.</p></section>`;
  const ms = (v: number | null) => (v === null ? '<span class="meta">none</span>' : e(duration(v)));
  const row = (m: GatewayView["models"][number]) => `<tr><th scope="row"><code>${e(m.model)}</code><span class="meta"> ${e(m.provider)}</span></th>
    <td class="num">${e(m.calls.toLocaleString("en"))}${m.failures ? ` <span class="meta">${e(m.failures.toLocaleString("en"))} failed</span>` : ""}</td>
    <td class="num">${e(tokens(m.tokensIn))} in · ${e(tokens(m.tokensOut))} out</td>
    <td class="num">${m.cost === null ? '<span class="meta">not priced</span>' : e(money(m.cost))}</td>
    <td class="num">${ms(m.medianMs)} · ${ms(m.p90Ms)} <span class="meta">n=${e(m.sample.toLocaleString("en"))}</span></td></tr>`;
  const taskRow = (t: GatewayView["tasks"][number]) => `<tr><th scope="row"><code>${e(t.task)}</code></th>
    <td class="num">${e(t.calls.toLocaleString("en"))}${t.failures ? ` <span class="meta">${e(t.failures.toLocaleString("en"))} failed</span>` : ""}</td>
    <td class="num">${e(tokens(t.tokensIn))} in · ${e(tokens(t.tokensOut))} out</td>
    <td class="num">${t.cost === null ? '<span class="meta">not priced</span>' : e(money(t.cost))}</td></tr>`;
  return `<section class="gateway" aria-label="AI Gateway costs">${head}
  <p class="meta">Calls runners sent through Cloudflare AI Gateway since ${e(stamp(g.since))}, from Cloudflare's GraphQL Analytics. The median and 90th percentile durations are taken over n calls in that window. A model whose calls all cost $0 shows "not priced": the gateway records a call it could not price as $0, so the two cannot be told apart.</p>
  ${g.models.length ? `<table class="usage-table">
    <thead><tr><th scope="col">Model</th><th scope="col">Calls</th><th scope="col">Tokens</th><th scope="col">Cost</th><th scope="col">Median · p90 duration</th></tr></thead>
    <tbody>${g.models.map(row).join("")}</tbody>
  </table>` : `<p class="empty">No calls through the gateway in the last ${g.days} days.</p>`}
  ${g.tasks.length ? `<h3>Calls per task</h3>
  <p class="meta">Tasks as each call's cf-aig-metadata names it, which the runner sets per run; a task's value is its id, so the same id in two projects is one row. A call with no task tag counts under no task.</p>
  <table class="usage-table">
    <thead><tr><th scope="col">Task</th><th scope="col">Calls</th><th scope="col">Tokens</th><th scope="col">Cost</th></tr></thead>
    <tbody>${g.tasks.map(taskRow).join("")}</tbody>
  </table>` : g.models.length ? '<p class="meta">No calls carried a task tag; runners send it as cf-aig-metadata, one per run.</p>' : ""}
</section>`;
}

// ── speed ──────────────────────────────────────────────────────────────────
// How fast each model works over the record's window (src/models/speed.ts):
// per model, the median time from claim to submission for its builds, from
// review claim to verdict for its reviews and from its first claim to the
// merge for its tasks, each with the n it is taken over, and the share of
// its build and review runs that stalled. Below the minimum n a cell gives
// n and no median. Its own section, so the reliability table stays as it is.

function speedCell(m: Measure): string {
  if (!m.n) return '<span class="meta">none</span>';
  return m.median === null
    ? `<span class="meta">n=${m.n}, too few for a median</span>`
    : `${e(pace(m.median))}<span class="meta">n=${m.n}</span>`;
}

const roleCell = (r: RoleSpeed) => `${speedCell(r)}<span class="meta">${e(stalledText(r))}</span>`;

export function speedSection(s: SpeedRecord): string {
  const window = `the last ${s.days} days, ${dayOf(s.since)} to ${dayOf(s.until)}`;
  const head = `<h2 class="section-title">Speed by model · ${e(window)}</h2>`;
  const lead = `From the ledger's own timestamps over ${e(window)}: a build from the model's claim to its submission, a review from its review claim to its verdict, and a task from its first claim to the merge, counted under the model that claimed it first. Each is the median over the n runs that ended in the window; a model with fewer than ${s.minSamples} shows n and no median. Stalled counts the runs the runners reported as stalled or timed out, of every run that ended with a result or was reported.`;
  const row = (m: SpeedRecord["models"][number]) => `<tr><th scope="row"><code>${e(m.model)}</code><span class="meta">${m.actors.map(e).join(", ")}</span></th>
    <td class="num">${roleCell(m.build)}</td>
    <td class="num">${roleCell(m.review)}</td>
    <td class="num">${speedCell(m.task)}</td></tr>`;
  return `<section class="speed" aria-label="Speed by model">${head}
  <p class="meta">${lead}</p>
  ${s.models.length ? `<table class="usage-table">
    <thead><tr><th scope="col">Model</th><th scope="col">Build: claim to submission</th><th scope="col">Review: claim to verdict</th><th scope="col">Task: first claim to merge</th></tr></thead>
    <tbody>${s.models.map(row).join("")}</tbody>
  </table>` : `<p class="empty">No model built, reviewed or merged anything in ${e(window)}.</p>`}
</section>`;
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

// A duration's median in a compact form, or an em dash when none was timed.
function fmtSecs(seconds: number | null): string {
  if (seconds === null) return '<span class="meta">—</span>';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

// A model's median timings, named in the order a task passes them: claim to
// push, to submission, to the first verdict, to the merge, then rework.
function timingsCell(t: { claimToPush: number | null; claimToSubmit: number | null; claimToVerdict: number | null; claimToMerge: number | null; rework: number | null }): string {
  const parts = [
    t.claimToPush !== null ? `push ${fmtSecs(t.claimToPush)}` : "",
    t.claimToSubmit !== null ? `submit ${fmtSecs(t.claimToSubmit)}` : "",
    t.claimToVerdict !== null ? `verdict ${fmtSecs(t.claimToVerdict)}` : "",
    t.claimToMerge !== null ? `merge ${fmtSecs(t.claimToMerge)}` : "",
    t.rework !== null ? `rework ${fmtSecs(t.rework)}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : '<span class="meta">none timed</span>';
}

// The owner's verdicts on a reviewer's findings: how many were kept (confirmed
// or fixed) of those adjudicated, how many refuted, and the share kept.
function findingsCell(confirmed: number, refuted: number): string {
  const total = confirmed + refuted;
  if (!total) return '<span class="meta">none adjudicated</span>';
  return `${confirmed} of ${total} kept<span class="meta">${refuted} refuted · ${Math.round((confirmed / total) * 100)}%</span>`;
}

// The non-zero run outcomes a model had, named and counted.
function runBreakdown(runs: ModelReliability["runs"]): string {
  const parts = RUN_OUTCOMES.filter((o) => runs[o] > 0).map((o) => `${runs[o]} ${o.replace(/_/g, " ")}`);
  return parts.length ? parts.join(" · ") : '<span class="meta">none</span>';
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
    causeList("Findings adjudicated", r.findingVerdicts),
    causeList("Main folded into its forks", r.integrations),
    causeList("Runs reported", r.runCauses),
  ].join("");
  return `<tr><th scope="row"><code>${e(r.model)}</code><span class="meta">${r.actors.map(e).join(", ")} · ${e(plural(r.projects.length, "project"))}</span></th>
  <td class="num">${r.firstReviews ? `${r.approvedFirst} of ${r.firstReviews}` : '<span class="meta">none reviewed</span>'}</td>
  <td class="num">${merges}</td>
  <td class="num">${r.rejections.length}<span class="meta">${e(plural(r.defects.length, "defect"))} traced to its work</span></td>
  <td class="num">${r.contradicted.length} of ${e(plural(r.approvals, "approval"))}<span class="meta">${e(plural(r.unfinishedReviews, "review"))} without a verdict</span></td>
  <td class="num">${findingsCell(r.findingsConfirmed, r.findingsRefuted)}</td>
  <td class="num">${timingsCell(r.timings)}</td>
  <td class="num">${runTotal(r)}<span class="meta">${runBreakdown(r.runs)}</span></td>
  <td class="num">${owner.page} by ${e(who)} on the page<span class="meta">${owner.api} through the API · ${owner.unrecorded} unrecorded</span></td>
</tr>${causes ? `<tr class="causes"><td colspan="9"><details><summary>Causes for ${e(r.model)}</summary>${causes}</details></td></tr>` : ""}`;
}

// The comparison by model and kind of work: one row per kind a model acted on,
// with the same measures the reliability table holds, split by kind.
function comparisonTable(rows: ModelReliability[]): string {
  const cells = rows.flatMap((r) => r.kinds.map((k) => ({ r, k })));
  if (!cells.length) return "";
  const row = ({ r, k }: { r: ModelReliability; k: KindMeasures }) => `<tr><th scope="row"><code>${e(r.model)}</code><span class="meta">${e(k.kind)} · ${e(plural(k.items, "item"))}</span></th>
  <td class="num">${findingsCell(k.findingsConfirmed, k.findingsRefuted)}</td>
  <td class="num">${k.contradicted} of ${e(plural(k.approvals, "approval"))}</td>
  <td class="num">${timingsCell(k.timings)}</td>
  <td class="num">${k.checkMismatches}<span class="meta">${e(plural(k.outOfScope, "out of scope"))}</span></td>
  <td class="num">${Object.values(k.runs).reduce((a, b) => a + b, 0)}<span class="meta">${runBreakdown(k.runs)}</span></td>
  <td class="num">${k.integrations}</td>
  </tr>`;
  return `<h3 class="section-title">By kind of work</h3>
  <p class="meta">The same measures per model, split by the kind of work each item asked for (from its plan part, or unknown), so a model that is strong at one kind and weak at another shows the difference.</p>
  <table class="usage-table">
    <thead><tr><th scope="col">Model and kind</th><th scope="col">Findings</th><th scope="col">Approvals contradicted</th><th scope="col">Median timings</th><th scope="col">Honesty</th><th scope="col">Runs</th><th scope="col">Main folded in</th></tr></thead>
    <tbody>${cells.map(row).join("")}</tbody>
  </table>`;
}

export function reliabilitySection(models: Reliability, ownerName: string | null, window: { events: number; unread: string[] }): string {
  const who = ownerName || "the owner";
  const rows = [...models.values()];
  const lead = `Each model's record across all ${window.events.toLocaleString("en")} events of every project${window.unread.length ? ` (${window.unread.map(e).join(", ")} could not be read just now, so ${window.unread.length === 1 ? "its" : "their"} work is not counted)` : ""}, and the runs the runners reported. Its work is what it held; its verdicts are its own reviews. A finding the owner adjudicated measures the reviewer's precision: kept means confirmed or marked fixed, refuted means the code already did what it asked. Approvals by ${e(who)} are never a model's verdict: they are counted per model whose work they approved, those made on the task page apart from those recorded through the API, as the orchestrator records them; those from before Atelier kept the two apart are unrecorded.`;
  return `<section class="reliability" aria-label="Reliability by model">
  <h2 class="section-title">Reliability by model · ${rows.length}</h2>
  <p class="meta">${lead}</p>
  ${rows.length ? `<table class="usage-table">
    <thead><tr><th scope="col">Model</th><th scope="col">Approved at first review</th><th scope="col">Review rounds to merge</th><th scope="col">Rejections</th><th scope="col">Approvals contradicted</th><th scope="col">Findings</th><th scope="col">Median timings</th><th scope="col">Runs</th><th scope="col">Owner approvals of its work</th></tr></thead>
    <tbody>${rows.map((r) => reliabilityRow(r, who)).join("")}</tbody>
  </table>${comparisonTable(rows)}` : '<p class="empty">No model has acted yet.</p>'}
</section>`;
}

// ── studio ─────────────────────────────────────────────────────────────────

const MARK_NAMES: Record<MarkKind, string> = {
  claim: "Claimed",
  handoff: "Handed off",
  push: "Pushed",
  "observed-cloud": "Check passed in Cloudflare",
  "observed-local": "Check passed on a runner, in a clean clone",
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

// The marks a lane most often carries, so the row under the family legend
// explains the page without opening anything; the full table stays in the
// disclosure below (finding 20).
const QUICK_MARKS: MarkKind[] = ["claim", "push", "observed-cloud", "failed", "submit", "approve"];
const markGlyph = (k: MarkKind) => `<svg width="22" height="22" aria-hidden="true"><svg x="11" y="11" overflow="visible" class="mark">${markShape(k)}</svg></svg>`;

export function renderStudio(floor: Floor, ownerName: string | null = null, now = new Date(), unavailable = false, projects: ProjectRecord[] = [], owner = DEFAULT_OWNER): string {
  const titles = titleMap(projects);
  const agents = new Set(floor.benches.map((b) => b.agent)).size;
  const vendors = [...new Set(floor.benches.flatMap((b) => b.chain.map((a) => vendorFor(a, owner))))];
  const hasLocal = floor.benches.some((b) => b.chain.some(isLocalRun));
  const legend = (Object.keys(MARK_NAMES) as MarkKind[]).map((k) =>
    `<li><svg width="24" height="24" aria-hidden="true"><svg x="12" y="12" overflow="visible" class="mark">${markShape(k)}</svg></svg>${e(MARK_NAMES[k])}</li>`).join("");
  const quickLegend = `<ul class="legend-line marks-legend" aria-label="The commonest marks">${QUICK_MARKS.map((k) => `<li>${markGlyph(k)}${e(MARK_NAMES[k])}</li>`).join("")}</ul>`;
  const mid = new Date((Date.parse(floor.from) + Date.parse(floor.to)) / 2).toISOString();
  const body = floor.benches.length
    ? `${familyLegend(vendors, "You", hasLocal ? LOCAL_KEY : "")}${quickLegend}<div class="axis-labels" aria-hidden="true"><span>${e(clock(floor.from))}</span><span>${e(clock(mid))}</span><span>now</span></div>
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
// Without `axis`, the bars stand alone at a fixed height and the first and
// last day follow as text, so the labels keep their size at any card width.
function pulseGraph(p: Pulse, axis = true): string {
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
  const first = e(keyLabel(p.days[0].day, false)), last = e(keyLabel(p.days[p.days.length - 1].day, false));
  if (!axis) return `<div class="pulse-chart"><svg class="pulse-graph bars" viewBox="0 0 ${W} ${PULSE_BASE + 1}" preserveAspectRatio="none" role="img" aria-label="${e(label)}">
    <line class="baseline" x1="0" x2="${W}" y1="${PULSE_BASE + 0.5}" y2="${PULSE_BASE + 0.5}"/>${bars}
  </svg><p class="pulse-axis" aria-hidden="true"><span>${first}</span><span>${last}</span></p></div>`;
  return `<svg class="pulse-graph" viewBox="0 0 ${W} ${PULSE_H}" role="img" aria-label="${e(label)}">
    <line class="baseline" x1="0" x2="${W}" y1="${PULSE_BASE + 0.5}" y2="${PULSE_BASE + 0.5}"/>${bars}
    <text x="4" y="${PULSE_H - 3}">${first}</text><text x="${W - 4}" y="${PULSE_H - 3}" text-anchor="end">${last}</text>
  </svg>`;
}

// Home is the portfolio (PAVI's direction, 2026-10-06): one card per project
// with what needs the owner there, what is running, its two weeks of activity
// and its last merge. Projects with something waiting come first. `waiting`
// is that project's placement (attentionFor), or absent when it was not
// read, which the card says; `showcase` is the public showcase setting by
// project name, so each card carries the owner's control over what is
// published, under the card's own link.
export interface HomeView extends ProjectView {
  waiting?: Attention;
  // The project's recent moves could not be read: the card says so rather
  // than reading as a quiet fortnight.
  eventsUnread?: boolean;
}

export function renderHome(views: HomeView[], ownerName: string | null = null, now = new Date(), owner = DEFAULT_OWNER, showcase: Record<string, "named" | "anonymous"> = {}): string {
  const vendors = new Set<Vendor>();
  const ranked = views.map((v) => {
    // What waits on the owner is what attentionFor places under the owner's
    // calls, one per task; the pipeline stays in a disclosure.
    const a = v.unavailable ? undefined : v.waiting;
    return { v, a, waiting: a?.owner ?? [], lastAt: "" };
  });
  for (const { v } of ranked) {
    const p = buildPulse(v.events ?? [], owner, now, !!v.cut);
    for (const w of Object.keys(p.byVendor) as Vendor[]) vendors.add(w);
  }
  // Something waiting first, then whichever project last moved, so a quiet
  // portfolio still reads newest first.
  const order = ranked.map((r) => ({ ...r, lastAt: buildPulse(r.v.events ?? [], owner, now, !!r.v.cut).lastAt ?? "" }))
    .sort((a, b) => b.waiting.length - a.waiting.length || b.lastAt.localeCompare(a.lastAt));
  const cards = order.map(({ v, a, waiting }) => {
    const { project, items, unavailable, events, cut } = v;
    const count = (states: string[]) => items.filter((i) => states.includes(i.state)).length;
    const p = buildPulse(events ?? [], owner, now, !!cut);
    const running = items.filter((i) => LIVE_STATES.includes(i.state));
    const lastMerge = lastMerged(items)[0];
    // A count not read is said as unknown, never as none.
    const waitCount = a ? `${waiting.length}${a.unknown.length ? "?" : ""}` : "?";
    const tally = `<p class="card-tally"><span><b>${waitCount}</b>waiting on you</span><span><b>${count(["claimed", "submitted", "accepted"])}</b>running</span><span><b>${count(["open"])}</b>ready to start</span><span><b>${count(["merged"])}</b>merged</span></p>`;
    const last = p.lastAt ? ` · last activity ${e(ago(p.lastAt, now))}` : "";
    const line = v.eventsUnread ? "Its recent moves could not be read." : p.moves || p.decisions
      ? `${plural(p.moves, "move")} by ${plural(p.agents.length, "agent")} and ${plural(p.decisions, "decision")} in two weeks${p.cut ? ", from the most recent part of the record" : ""}${last}.`
      : `No moves in the last two weeks${last}.`;
    const waitRows = waiting.slice(0, 3).map((t) => ownerRow(t)).join("");
    const more = waiting.length > 3 ? `<li class="meta">and ${waiting.length - 3} more on <a href="/decisions">Decisions</a></li>` : "";
    const runRows = running.slice(0, 3).map((i) =>
      `<li><a href="${href("p", project.name, i.id)}">${e(i.title)}</a><span class="meta">${e(stateLabel[i.state])} · ${e(i.owner ?? "nobody")}</span></li>`).join("");
    const mergeLine = lastMerge
      ? `<p class="meta">Last merge: <a href="${href("p", project.name, lastMerge.id)}">${e(lastMerge.title)}</a> · ${e(ago(lastMerge.updatedAt, now))}</p>`
      : '<p class="meta">Nothing merged yet.</p>';
    const body = unavailable
      ? '<p class="meta">Temporarily unavailable. Open to retry.</p>'
      : `${pulseGraph(p)}<p class="meta">${line}</p>
    ${waitRows ? `<h3>Waiting on you</h3><ul class="home-rows">${waitRows}${more}</ul>` : ""}
    ${a ? unknownNotice(a) : '<p class="meta">What waits on you here could not be read.</p>'}
    ${a ? pipelineDisclosure(a) + overlapDisclosure(a) : ""}
    ${runRows ? `<h3>Running</h3><ul class="home-rows">${runRows}</ul>` : ""}
    ${mergeLine}`;
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
    return `<li class="project-card${unavailable ? " unavailable" : ""}${waiting.length ? " has-waiting" : ""}"><a class="home-head" href="${href("p", project.name)}"><h2>${e(titleOf(project))}</h2>${tally}</a><div class="home-body">${body}</div>${form}</li>`;
  }).join("");
  return page("Home", `<div class="page-width">
  <header><h1>Home</h1><p class="lead">The portfolio: every project with what waits on you, what runs and where each stands. Each card counts the last ${PULSE_DAYS} days of moves, a bar per day, in the colour of the family that made them.</p>
  <p class="meta">Across projects: <a href="/flow">the whole flow</a> · <a href="/history">the timeline of merges</a></p></header>
  ${views.length ? familyLegend([...vendors]) : ""}
  <ul class="project-cards">${cards}</ul>
  ${!views.length ? '<div class="empty"><h2>Start with one project.</h2><p>Run <code>atelier init</code> in its local checkout. It will appear here.</p></div>' : ""}
</div>`, "Home", ownerName);
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
  // What waits on the owner, one entry per task, as attentionFor places it
  // (src/attention.ts): the call, the sentence saying what to do and the link
  // to where it is done, with the brief's verdict after it; `kind`, `kinds`
  // and `reason` are the fields older clients read (legacyFields).
  waiting: (OwnerTask & LegacyFields & { brief: { verdict: string; line: string } | null })[];
  // The rest of the live tasks, counted by their pipeline stage, and the pairs
  // whose scopes overlap: the orchestrator's and the reviewers', not the owner's.
  pipeline: { stage: Stage; count: number }[];
  overlaps: [string, string][];
  queued: { id: string; title: string; to: string; agent: string | null; model: string | null; by: string; at: string; note: string }[];
  merged: { id: string; title: string; at: string; commit: string | null; line: string | null }[];
  // Every merge that went in on the owner's override of the independent
  // review (t371), newest first, with the reason recorded; `overrides.length`
  // is the count the page and `atelier status` show.
  overrides: { id: string; title: string; at: string; reason: string }[];
  handoffs: { id: string; title: string; from: string; to: string; note: string; at: string }[];
  controlPlane: { approval: string; protected: string[]; eligible: string[]; refuseOverlap: boolean } | null;
  // The project's model policy (t394): single-family mode naming the
  // company, or a recorded return to cross-family review; null when never
  // switched. `atelier status --project` says so under the project's name.
  familyMode: FamilyMode | null;
  // Each registered check, its class, that class in words (src/checks.ts),
  // and the paths it applies to, or null when it applies to every change.
  checks: { command: string; class: CheckClass; text: string; paths: string[] | null }[];
  // What this view could not read in full, in words. Empty when it read everything it shows.
  partial: string[];
  // The sources that failed outright (readStanding): the tasks, so nothing
  // drawn from them is known, or the notices, so the calls only they show are
  // not. Absent when both were read. The Overview says each as not read,
  // never as none.
  unread?: ("tasks" | "notices")[];
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
// `limit` of each; `attention` the project's placement (attentionFor), whose
// owner calls are what waits; `details` the Ledger's detail for those tasks, which
// the brief reads. Holders come from the items, since-when and handoff notes
// from the task's own events, and merges from the merged items. What an
// event window may have cut off is reported in `partial`, never guessed.
export function buildStanding(
  p: ProjectRecord, items: Item[], taskEvents: Map<string, LedgerEvent[]>, limit: number,
  attention: Attention, details: Map<string, Detail>, now: Date,
): Standing {
  const partial: string[] = [...attention.unknown];
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

  // One line per task waiting on the owner, in the rule's order, with the
  // brief's verdict after the call for the first few.
  const waiting = attention.owner.map((t, n) => {
    const d = n < STANDING_BRIEFS ? details.get(t.id) : undefined;
    const b = d ? briefFor(d, d.events) : null;
    return { ...t, ...legacyFields(t), brief: b ? { verdict: b.recommendation.verdict, line: b.recommendation.reason } : null };
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
    pipeline: stageCounts(attention).map(([stage, count]) => ({ stage, count })),
    overlaps: attention.overlaps,
    queued: items.filter((i) => i.state === "open" && !i.owner && i.dispatch).map((i) => ({
      id: i.id, title: i.title, to: i.dispatch!.to, agent: i.dispatch!.agent ?? null, model: i.dispatch!.model ?? null, by: i.dispatch!.by, at: i.dispatch!.at, note: i.dispatch!.note ?? "",
    })),
    merged,
    overrides: mergedByOverride(items).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((i) => ({ id: i.id, title: i.title, at: i.reviewOverride!.at, reason: i.reviewOverride!.reason })),
    handoffs,
    // A project governed by ControlPlane carries the owner's recorded approval.
    controlPlane: p.policy.approval
      ? { approval: p.policy.approval, protected: p.policy.protected, eligible: p.policy.eligible ?? [], refuseOverlap: !!p.policy.refuseOverlap }
      : null,
    familyMode: p.policy.familyMode ?? null,
    checks: checkClasses(p.policy).map((v) => ({ command: v.command, class: v.class, text: classText(v), paths: p.policy.checkPaths?.find((c) => c.command === v.command)?.paths ?? null })),
    partial,
  };
}

// ── a project's Overview, as the canvas draws it (PAVI's d29, t546) ────────
// One word per state (docs/design/brief.md §5), each with its colour role.
// A submitted task is split by the notice the Ledger gives it: accept is
// Ready to accept, assess Needs review, failing Checks failed. One with none
// of these, or read without the notices, stays In review: Sent back needs
// the task's reviews, which the Overview does not read.
export type StateWord = "open" | "working" | "ready-to-accept" | "needs-review" | "checks-failed" | "in-review" | "ready-to-merge" | "blocked" | "integrated" | "merged" | "closed";
export const STATE_WORDS: [word: StateWord, label: string, role: string][] = [
  ["open", "Ready to start", "neutral"], ["working", "Working", "neutral"], ["ready-to-accept", "Ready to accept", "go"],
  ["needs-review", "Needs review", "ask"], ["checks-failed", "Checks failed", "fault"], ["in-review", stateLabel.submitted, "neutral"],
  ["ready-to-merge", "Ready to merge", "go"], ["blocked", "Blocked", "caution"], ["integrated", stateLabel.integrated, "done"],
  ["merged", "Merged", "done"], ["closed", "Closed", "done"],
];
const WORD = new Map(STATE_WORDS.map(([w, label, role]) => [w, { label, role }]));
export const isStateWord = (v: unknown): v is StateWord => typeof v === "string" && WORD.has(v as StateWord);

// Each task's word, from its item and the notices naming it (null: not read).
export function stateWords(items: Item[], inbox: InboxEntry[] | null): Map<string, StateWord> {
  const kinds = new Map<string, Set<string>>();
  for (const x of inbox ?? []) kinds.set(x.itemId, (kinds.get(x.itemId) ?? new Set()).add(x.kind));
  return new Map(items.map((i) => {
    const has = (k: string) => kinds.get(i.id)?.has(k) ?? false;
    const word: StateWord = i.state === "blocked" || i.blocked ? "blocked"
      : i.state === "open" ? "open"
      : i.state === "claimed" ? "working"
      : i.state === "accepted" ? "ready-to-merge"
      : i.state === "integrated" ? "integrated"
      : i.state === "merged" ? "merged"
      : i.state === "abandoned" ? "closed"
      : has("accept") ? "ready-to-accept" : has("assess") ? "needs-review" : has("failing") ? "checks-failed" : "in-review";
    return [i.id, word];
  }));
}

const tasksIn = (p: ProjectRecord, word: StateWord) => `${href("p", p.name, "tasks")}?state=${word}`;
const stateText = (word: StateWord) => `<span class="state-word ${WORD.get(word)!.role}">${e(WORD.get(word)!.label)}</span>`;
const idLink = (p: ProjectRecord, id: string) => `<a class="row-id" href="${href("p", p.name, id)}">${e(id)}</a>`;
const bare = (s: string) => s.replace(/ ago$/, "");

// The counts by state as a grid of links, each to the tasks it counts; a
// state no task is in is left out. Working names how many are stale.
function stateGrid(p: ProjectRecord, words: Map<string, StateWord>, stale: number): string {
  const counts = new Map<StateWord, number>();
  for (const w of words.values()) counts.set(w, (counts.get(w) ?? 0) + 1);
  const cells = STATE_WORDS.filter(([w]) => counts.get(w)).map(([w, label, role]) =>
    `<li><a href="${tasksIn(p, w)}"><span class="state-n ${role}">${counts.get(w)}</span><span class="state-label">${e(label)}${w === "working" && stale ? ` (${stale} stale)` : ""}</span></a></li>`);
  return cells.length ? `<ul class="state-grid" aria-label="Tasks by state">${cells.join("")}</ul>` : "";
}

// What else the standing holds, folded under its figures: queued tasks, every
// merge by override (t371), handoff notes, the newest session and where the
// same record is read as text or JSON.
function standingMore(p: ProjectRecord, s: Standing): string {
  const link = (id: string) => `<a href="${href("p", p.name, id)}">${e(id)}</a>`;
  const group = (title: string, rows: string[]) => rows.length ? `<h3>${e(title)}</h3><ul class="standing-list">${rows.join("")}</ul>` : "";
  const runner = (q: Standing["queued"][number]) => `${q.to}${q.agent ? ` ${q.agent}` : ""}${q.model ? `/${q.model}` : ""}`;
  const overrides = s.overrides ?? [];
  const summary = s.unread?.includes("tasks") ? "Atelier's record: its tasks could not be read"
    : `${plural(s.queued.length, "task")} queued · <span class="merged-by-override">${plural(overrides.length, "merge")} by override</span> · ${plural(s.handoffs.length, "handoff note")}`;
  return `<details class="disclosure standing-more"><summary>${summary}</summary>
  ${group("Queued for a runner", s.queued.map((q) => `<li>${link(q.id)} <strong>${e(q.title)}</strong><span class="meta">for ${e(runner(q))} · sent by ${e(q.by)} ${e(when(q.at))}${q.note ? ` · ${e(notePreview(q.note))}` : ""}</span></li>`))}
  ${group(`Merged by override: ${plural(overrides.length, "merge")}`, overrides.map((o) => `<li>${link(o.id)} <strong>${e(o.title)}</strong><span class="meta">${e(when(o.at))} · the owner's override, not a review: ${e(o.reason)}</span></li>`))}
  ${group("Handoff notes", s.handoffs.map((h) => `<li>${link(h.id)} <strong>${e(h.title)}</strong><span class="meta">${e(h.from || "?")} to ${e(h.to || "?")}, ${e(when(h.at))}: ${e(h.note)}</span></li>`))}
  ${s.session ? `<h3>Newest session</h3>${sessionNoteText(s.session).split("\n").map((line) => `<p class="meta">${e(line)}</p>`).join("")}` : ""}
  ${overlapDisclosure({ project: p.name, owner: [], pipeline: [], overlaps: s.overlaps ?? [], unknown: [] })}
  <p class="meta">Read from Atelier's record ${e(when(s.generatedAt))}. <code>atelier status --project ${e(p.name)}</code> prints it as text; ${e(`/api/projects/${p.name}/standing`)} returns it as JSON.</p>
</details>`;
}

// The Overview's body: the figures line, the counts by state, what waits on
// the owner, who is working, the last five merges and the ship requests,
// each read from the Ledger and linked to the tasks it names. Without the
// standing only what the items tell is drawn; nothing is shown as zero
// that was not read. `items` null: the board could not be read, so the task
// count, the grid and who is running are said as not read, as are the
// sections the standing's own failed reads leave unknown (s.unread); a
// source read and empty still says it is empty.
function overviewSection(p: ProjectRecord, board: Item[] | null, inbox: InboxEntry[] | null, s: Standing | undefined, now: Date): string {
  const items = board ?? [];
  const tasksUnread = s?.unread?.includes("tasks") ?? false;
  const noticesUnread = s?.unread?.includes("notices") ?? false;
  const unreadLine = (what: string) => `<p class="meta" role="status">${what} could not be read.</p>`;
  const words = stateWords(items, inbox);
  const stale = new Set((inbox ?? []).filter((x) => x.kind === "stale").map((x) => x.itemId));
  const staleWorking = items.filter((i) => words.get(i.id) === "working" && stale.has(i.id)).length;
  const mergesUnread = s ? tasksUnread : board === null;
  const merged = s?.merged ?? lastMerged(items).map((i) => ({ id: i.id, title: i.title, at: i.updatedAt }));
  const since = new Map((s?.live ?? []).map((l) => [l.id, l.since]));
  const working = items.filter((i) => words.get(i.id) === "working")
    .map((i) => ({ i, push: i.lastPushAt, since: since.get(i.id) ?? null }))
    .sort((a, b) => (b.push ?? b.since ?? "").localeCompare(a.push ?? a.since ?? ""));
  const waiting = s?.waiting ?? [];
  const ships = waiting.filter((w) => w.call === "ship");
  // A count over a source that was read only in part carries a question mark,
  // as Home's does; one over a source not read at all is left out.
  const waitCount = `${waiting.length}${noticesUnread ? "?" : ""}`;
  const figures = [
    ...board ? [plural(items.length, "task")] : [],
    ...s && !tasksUnread ? [`${waitCount} waiting on you`] : [],
    ...merged.length ? [`last merge ${ago(merged[0].at, now)}`] : [],
  ].join(" · ");
  const list = (cls: string, rows: string[]) => `<ul class="overview-list ${cls}">${rows.join("")}</ul>`;
  const waitRows = waiting.slice(0, 5).map((w) => `<li>${idLink(p, w.id)}<span class="row-title">${e(w.title)}</span>${stateText(words.get(w.id) ?? "in-review")}<span class="row-why">${e(w.sentence)}</span></li>`);
  const runRows = working.slice(0, 5).map(({ i, push, since: at }) => `<li>${idLink(p, i.id)}<span class="row-title">${e(i.title)}</span><span class="row-who">${e(i.owner ?? "nobody")}${push ? ` · pushed ${e(ago(push, now))}` : at ? ` · taken ${e(ago(at, now))}` : ""}${stale.has(i.id) ? ' · <span class="state-word caution">stale</span>' : ""}</span></li>`);
  const mergeRows = merged.map((m) => `<li>${idLink(p, m.id)}<span class="row-title">${e(m.title)}</span><time class="row-when" datetime="${e(m.at)}">${e(bare(ago(m.at, now)))}</time></li>`);
  const shipRows = ships.map((w) => `<li>${idLink(p, w.id)}<span class="row-title">${e(w.title)}</span><span class="row-why">${e(w.sentence)} <a href="${e(w.href)}">Open Ship</a></span></li>`);
  const waitingSection = s ? `<section class="overview-block" aria-labelledby="wait-h">
      <h2 id="wait-h">Waiting on you${tasksUnread ? "" : ` · ${waitCount}`}</h2>
      ${tasksUnread ? unreadLine("What waits on you here")
        : waitRows.length ? list("wait-list", waitRows)
        : noticesUnread ? '<p class="meta" role="status">Nothing the tasks show waits on you; the notices could not be read, so a call only they show is not here.</p>'
        : '<p class="empty">Nothing waits on you here.</p>'}
      ${waiting.length ? `<p class="overview-more"><a href="/decisions">All ${waiting.length} waiting</a></p>` : ""}
    </section>` : "";
  const shipSection = s ? `<section class="overview-block" aria-labelledby="ship-h">
        <h2 id="ship-h">Ship requests</h2>
        ${shipRows.length ? list("wait-list", shipRows)
          : tasksUnread || noticesUnread ? `<p class="meta" role="status">The ship requests could not be read. Approvals are in <a href="${href("p", p.name, "ship")}">Ship</a>.</p>`
          : `<p class="meta">None pending. Approvals are in <a href="${href("p", p.name, "ship")}">Ship</a>.</p>`}
      </section>` : "";
  return `<section class="overview" id="standing" aria-label="Overview">
  ${figures ? `<p class="overview-figures">${e(figures)}</p>` : ""}
  ${s?.partial.length ? `<div class="notice" role="status"><h3>Part of this record is not shown</h3><ul>${s.partial.map((x) => `<li>${e(x)}</li>`).join("")}</ul></div>` : ""}
  ${stateGrid(p, words, staleWorking)}
  <div class="overview-cols">
    ${waitingSection}
    <div class="overview-side">
      <section class="overview-block" aria-labelledby="run-h">
        <h2 id="run-h">Running${board ? ` · ${working.length}` : ""}</h2>
        ${!board ? unreadLine("Who is working")
          : runRows.length ? list("run-list", runRows) : '<p class="empty">Nobody is working on a task.</p>'}
        ${working.length ? `<p class="overview-more"><a href="${tasksIn(p, "working")}">All ${working.length} working</a></p>` : ""}
      </section>
      <section class="overview-block" aria-labelledby="merge-h">
        <h2 id="merge-h">Last five merges</h2>
        ${mergeRows.length ? list("merge-list", mergeRows) : mergesUnread ? unreadLine("The merges") : '<p class="empty">Nothing merged yet.</p>'}
        <p class="overview-more"><a href="${href("p", p.name, "flow")}">Activity</a></p>
      </section>
      ${shipSection}
    </div>
  </div>
  ${s ? standingMore(p, s) : ""}
</section>`;
}

// Every task in one list: open, held, in review or closed, each row with its
// state, its holder and when it last moved. The separate Held now, Waiting
// and Work lists are gone; this is the one (finding 8).
function taskRows(p: ProjectRecord, items: Item[]): string {
  const closed = (i: Item) => i.state === "merged" || i.state === "abandoned";
  const ordered = [...items].sort((a, b) => Number(closed(a)) - Number(closed(b)) || b.updatedAt.localeCompare(a.updatedAt));
  return `<ul class="task-list">${ordered.map((i) => `<li><a href="${href("p", p.name, i.id)}">
    <span><strong>${e(i.title)}</strong><span class="meta">${e(i.id)} · ${e(i.owner ?? "No current owner")}</span></span>
    ${tag(stateLabel[i.state], i.state === "merged" ? "go" : "")}<time class="meta">${when(i.updatedAt)}</time>${icon("arrow")}</a></li>`).join("")}</ul>`;
}

// ── a project's area ───────────────────────────────────────────────────────
// Every page under /p/NAME shares the bar's second row, so the project is the
// unit the owner moves in (PAVI's direction, 2026-10-06): Project › page on
// the left, and five tabs (plan.md P10). The pages the eight tabs held stay
// at their URLs, each under the tab that holds it now: Plans under Tasks,
// Log, commits and path history under Code, Flow is Activity, and Ship's
// protected actions under Settings.

const PROJECT_TABS: [label: string, sub: string][] = [
  ["Overview", ""],
  ["Tasks", "tasks"],
  ["Code", "code"],
  ["Activity", "flow"],
  ["Settings", "settings"],
];
const TAB_OF: Record<string, string> = { Plans: "Tasks", Log: "Code", Flow: "Activity", Ship: "Settings" };
// The pages a tab holds, linked under it while it is current, so each stays
// one click from the bar (the shell's pre-review: without these links no
// page reached /plans, /log or /ship).
const HELD: Record<string, [label: string, sub: string][]> = {
  Tasks: [["Plans", "plans"]],
  Code: [["Log", "log"]],
  Settings: [["Ship", "ship"]],
};

// `active` is the page's own name, a tab's or one it holds; `crumb` ends the
// location instead of it, as a task's id does on the task's page. The row is
// drawn into the bar by page(), wherever in the body it is called.
export function projectTabs(p: ProjectRecord, active: string, crumb?: string): string {
  return `${ROW2[0]}${encodeURIComponent(titleOf(p))}-->${projectRow(p, active, crumb)}${ROW2[1]}`;
}

// The page of a project's area an address names, for the row of a page
// whose body drew none: `rest` is the path after /p/NAME, decoded. A task's
// pages, its fork's browsing included, are under Tasks with its id.
const PAGE_AT: Record<string, string> = { tasks: "Tasks", plans: "Plans", flow: "Flow", ship: "Ship", settings: "Settings", code: "Code", log: "Log", commit: "Code", history: "Code" };
export function projectPageAt(rest: string[]): { active: string; crumb?: string } {
  const [first] = rest;
  if (!first) return { active: "Overview" };
  return PAGE_AT[first] ? { active: PAGE_AT[first] } : { active: "Tasks", crumb: first };
}

function projectRow(p: ProjectRecord, active: string, crumb?: string): string {
  const tab = TAB_OF[active] ?? active;
  const tabs = PROJECT_TABS.map(([label, sub]) =>
    `<a href="${href("p", p.name, ...sub ? [sub] : [])}"${label === tab ? ' aria-current="page"' : ""}>${label}${label === "Tasks" ? `<span data-shell="tasks">${MARK.tasks(p.name)}</span>` : ""}</a>`).join("");
  return `
  <div class="bar-row project-row">
    <p class="crumb"><a href="${href("p", p.name)}">${e(titleOf(p))}</a> › <span>${e(crumb ?? (active === "Flow" ? "Activity" : active))}</span></p>
    <nav aria-label="Project">${tabs}</nav>${HELD[tab] ? `
    <nav aria-label="${tab} holds" class="held">${HELD[tab].map(([label, sub]) => `<a href="${href("p", p.name, sub)}"${label === active ? ' aria-current="page"' : ""}>${label}</a>`).join("")}</nav>` : ""}
  </div>`;
}

// The frame every page in a project's area shares: the project's name over
// its tab bar. `active` is the tab the page is, "Log" for a commit or a
// path's history (finding 24), and Tasks for a task's own page. `live` adds
// the live script without a refresh, as the Flow tab's replay needs.
// The model policy in words, for the project's pages (t394): single-family
// mode names the company, so nobody takes the project's reviews for
// cross-company ones; the default says so only where a switch back is
// recorded, with who made it and when.
export function familyModeText(policy: ProjectPolicy): string {
  const mode = policy.familyMode ?? null;
  const when = mode ? ` (set by ${mode.by} ${when_(mode.at)})` : "";
  if (mode?.single) return `Single-family mode, ${mode.single}: building and reviewing use ${mode.single} models only, and a review counts from a different ${mode.single} model than every contributor, not from another company${when}`;
  return `Cross-family, the default: a protected change needs approval from a model of another company than every contributor${when}`;
}
const when_ = (at: string) => (Number.isFinite(Date.parse(at)) ? `on ${at.slice(0, 10)}` : `at ${at}`);

// The line every tab of a single-family project's page carries under its
// title, so the mode is seen wherever the project is read.
const familyModeBanner = (p: ProjectRecord) => (singleFamily(p.policy) ? `<p class="meta family-mode" role="note">${e(familyModeText(p.policy))}.</p>` : "");

function projectPage(p: ProjectRecord, active: string, body: string, ownerName: string | null = null, title?: string, live?: Live): string {
  return page(title ?? titleOf(p), `<div class="page-width">
  <header class="proj-head"><h1>${e(titleOf(p))}</h1>${familyModeBanner(p)}${projectTabs(p, active)}</header>
  ${body}</div>`, "Home", ownerName, 0, true, live);
}

const newTaskForm = (p: ProjectRecord) => `<details class="new-task"><summary>+ Create a task</summary>
    <form method="post" action="${href("ui", p.name, "new")}" class="stack">
      <label>What should change?<input name="title" type="text" required maxlength="300" placeholder="A short title for the outcome"></label>
      <label>Brief<textarea name="brief" rows="4" maxlength="4000" placeholder="The whole task, for the agent that builds it (optional)"></textarea></label>
      <p class="meta">A title over 80 characters with no brief becomes the brief, and the title is its first clause.</p>
      <label>Files in scope<input name="scope" type="text" placeholder="src/**, test/**"></label>
      <p class="meta">Separate patterns with commas. Leave empty for unrestricted scope.</p>
      <button class="primary">Create task</button>
    </form>
  </details>`;

// Overview: the project as the canvas draws it (t546), with Atelier's own
// record of it under a disclosure named for what it is (finding 19). The
// whole task list is the Tasks tab's. `events` or `board` null: not read,
// which the page says rather than showing an empty record or no tasks.
// `inbox` holds the project's notices, which split a submitted task by its
// state word; null when they could not be read.
export function renderProject(p: ProjectRecord, items: Item[] | null, events: LedgerEvent[] | null, ownerName: string | null = null, standing?: Standing, board?: BoardSnapshot | null, inbox: InboxEntry[] | null = null, now = standing ? new Date(standing.generatedAt) : new Date(), mode: { mode: string; line: string } | null = null): string {
  const unread = (what: string) => `<p class="notice" role="status">${what} could not be read.</p>`;
  // The project's mode (t585): fast mode is said at the top while it stands.
  const modeNote = mode?.mode === "fast" ? `<p class="notice" role="status">${e(mode.line)}. Tasks land in fast mode from the owner's checkout, each with a receipt and a post-merge review; atelier mode full returns to the gated process.</p>` : "";
  return projectPage(p, "Overview", `
  ${modeNote}
  ${board === null ? unread("The task board") : ""}
  ${overviewSection(p, board === null ? null : items, inbox, standing, now)}
  <details class="disclosure"><summary>Ledger events</summary>${events ? eventTable(events, true) : unread("The project's events")}</details>
  `, ownerName);
}

// Tasks: the one list, with the form that starts a task. `state` narrows it
// to the tasks one state word counts, as the Overview's grid links them;
// `words` is each task's word (stateWords).
export function renderProjectTasks(p: ProjectRecord, items: Item[], ownerName: string | null = null, board?: BoardSnapshot, state?: { word: StateWord; words: Map<string, StateWord> }): string {
  if (state) {
    const shown = items.filter((i) => state.words.get(i.id) === state.word);
    return projectPage(p, "Tasks", `
  <section class="overview-block" aria-labelledby="state-h">
    <h2 id="state-h">${e(WORD.get(state.word)!.label)} · ${shown.length}</h2>
    ${shown.length ? taskRows(p, shown) : '<p class="empty">No task is in this state.</p>'}
    <p class="overview-more"><a href="${href("p", p.name, "tasks")}">All tasks</a></p>
  </section>`, ownerName, `${WORD.get(state.word)!.label} · ${titleOf(p)}`);
  }
  return projectPage(p, "Tasks", `
  ${newTaskForm(p)}
  ${board ? renderBoard(p.name, board) : items.length ? taskRows(p, items) : '<p class="empty">No tasks yet. Create one above.</p>'}
  `, ownerName);
}

// Flow: this project's own graph, with its replay (the scrubber the live
// script adds), the tally of who did what and its latest moves. What was
// /flow?project=NAME is this tab now.
export function renderProjectFlow(p: ProjectRecord, story: Story, owner: string, ownerName: string | null = null, imported: Map<string, ImportedHistory> = new Map(), live?: Live): string {
  const { stages, moments, shown } = flowParts([story], story.tally, owner, (s) => taskHref(s.project), "You", imported);
  const body = shown.length
    ? `${legendLine(vendorsIn(shown), shown.some(s => s.tally.localRuns > 0))}${stages}${moments}`
    : `<div class="empty"><h3>No work yet.</h3><p>When an agent claims a task, its thread appears here, from claim to merge.</p></div>`;
  return projectPage(p, "Flow", body, ownerName, `Flow · ${titleOf(p)}`, live);
}

// Plans (task t17): each plan as one unit, with its parts, each part's state
// and why it went to the agent that holds it, read from the same view as
// `atelier plan show` (GET items/tN/plan).
function routeLines(route: PartRoute | null | undefined, preview: boolean, policy: ProjectPolicy): string[] {
  if (!route) return [];
  const lead = preview ? "would be built by" : "built by";
  const lines: string[] = [];
  if (route.builder) lines.push(`${lead} ${route.builder.actor}: ${route.builder.reasons[0] ?? ""}`);
  if (route.alternates.length) lines.push(`alternates ${route.alternates.map((a) => a.actor).join(", ")}`);
  if (route.reviewer) {
    // A reviewer the plan picked in place of the routed one says whom it
    // replaced and why.
    const change = route.reviewerChange;
    lines.push(`reviewer ${route.reviewer.actor}, ${singleFamily(policy) ? `a different ${singleFamily(policy)} model from every contributor (single-family mode)` : "of another family"}${change ? `, in place of ${change.from ?? "no reviewer"}: ${change.reason}` : ""}`);
  }
  if (route.unrouted) lines.push(`unrouted: ${route.unrouted}`);
  return lines;
}

const ATTEMPT_WORDS: Record<Attempt["outcome"], string> = { "give-up": "released with no commit", failed: "released after a failed finish", finished: "finished" };

function planPartRow(p: ProjectRecord, v: PlanView, part: PlanPartView): string {
  const task = part.id ? `<a href="${href("p", p.name, part.id)}">${e(part.id)}</a>` : e(part.key);
  const state = part.state === "open" && part.dispatch
    ? `queued for ${part.dispatch.agent ?? part.dispatch.to}${part.dispatch.model ? `/${part.dispatch.model}` : ""}`
    : `${stateLabel[part.state]}${part.owner && part.state !== "open" ? ` · ${e(part.owner)}` : ""}`;
  const deps = part.dependsOn.length ? `depends on ${part.dependsOn.map((d) => `${d.key} (${d.id ?? "?"})`).join(", ")}` : "";
  const lines = [
    ...routeLines(part.route, false, p.policy),
    part.attempts.length ? `attempts: ${part.attempts.map((a) => `${a.actor} ${ATTEMPT_WORDS[a.outcome]}`).join("; ")}` : "",
    part.state === "integrated" && part.integration ? `integrated as ${part.integration.mergeCommit.slice(0, 8)}` : "",
    deps,
  ].filter(Boolean);
  return `<li class="plan-part"><div class="plan-part-head">${task} <strong>${e(part.title)}</strong>${tag(stateLabel[part.state], part.state === "merged" ? "go" : part.state === "open" ? "" : "ask")}</div>
    <p class="meta">${e(state)}${part.scope.length ? ` · scope ${e(part.scope.join(", "))}` : ""}</p>
    ${lines.length ? `<ul class="plan-lines">${lines.map((l) => `<li>${e(l)}</li>`).join("")}</ul>` : ""}</li>`;
}

function planUnit(p: ProjectRecord, v: PlanView): string {
  const a = v.approval;
  const proposal = v.proposal && v.plan && !a
    ? `<p class="meta">Proposal ${v.proposal.count}, by ${e(v.proposal.by)} at ${e(when(v.proposal.at))}: ${plural(v.plan.parts.length, "part")}. Hash <code>${e(v.proposal.hash.slice(0, 12))}</code>${v.proposal.answered ? "" : ", not yet answered"}.</p>
    <ul class="plan-parts">${v.plan.parts.map((part) => {
      const lines = routeLines(v.preview?.find((r) => r.key === part.key), true, p.policy);
      return `<li class="plan-part"><div class="plan-part-head">${e(part.key)} <strong>${e(part.title)}</strong>${tag(`${part.taskKind}, size ${part.size}`)}</div>
      <p class="meta">${e(part.brief.replace(/\s+/g, " ").trim())}</p>
      ${lines.length ? `<ul class="plan-lines">${lines.map((l) => `<li>${e(l)}</li>`).join("")}</ul>` : ""}</li>`;
    }).join("")}</ul>
    <p class="meta">The routing shown is what an approval would fix now; it is computed again when you approve.</p>`
    : "";
  const approval = a
    ? `<p class="meta">Approved by ${e(a.by)} at ${e(when(a.at))}, ${a.allowPaid ? "paid models allowed" : "no paid models"} · hash <code>${e(a.hash.slice(0, 12))}</code> · ${a.limits.maxParallel} parts live at once, ${a.limits.attempts} attempts a part, deadline ${e(when(a.deadline))} · ${a.jobsUsed} of ${a.limits.maxJobs} part dispatches used.</p>`
    : "";
  const parts = a && v.parts.length ? `<ul class="plan-parts">${v.parts.map((part) => planPartRow(p, v, part)).join("")}</ul>` : "";
  const integration = a
    ? `<p class="meta">${v.integration.integrationHead ? `Integration branch at <code>${e(v.integration.integrationHead.slice(0, 8))}</code>.` : "No part is integrated yet."}</p>`
    : "";
  return `<li class="plan-unit" id="${e(v.item.id)}">
  <div class="plan-head"><a href="${href("p", p.name, v.item.id)}">${e(v.item.id)}</a> <strong>${e(v.goal)}</strong>${tag(v.phase)}${tag(stateLabel[v.item.state], v.item.state === "merged" ? "go" : "")}</div>
  ${v.planner ? `<p class="meta">Planner ${e(v.planner)}${v.plannerReasons.length ? `: ${e(v.plannerReasons.join("; "))}` : ""}.</p>` : ""}
  ${v.blocked ? `<div class="notice" role="status"><h3>Blocked</h3><p>${e(v.blocked)}</p></div>` : ""}
  ${proposal || approval}
  ${parts}${integration}
</li>`;
}

export function renderProjectPlans(p: ProjectRecord, plans: PlanView[], ownerName: string | null = null): string {
  return projectPage(p, "Plans", `
  <p class="lead">Each plan as one unit: its parts, the state of each, and why each part went to the agent that holds it. <code>atelier plan show tN --project ${e(p.name)}</code> prints the same as text.</p>
  ${plans.length ? `<ul class="plan-units">${plans.map((v) => planUnit(p, v)).join("")}</ul>` : `<div class="empty"><h3>No plans yet.</h3><p>A plan turns a goal into parts, routes each to a model and integrates what they build. Start one with <code>atelier plan --project ${e(p.name)}</code>.</p></div>`}
  `, ownerName);
}

// Ship: protected actions and their history, drawn by src/actions-page.ts.
export function renderProjectShip(p: ProjectRecord, actions: string, ownerName: string | null = null): string {
  return projectPage(p, "Ship", actions, ownerName, `Ship · ${titleOf(p)}`);
}

// Settings: the project's own rules. Checks with their classes and path
// conditions, the protected paths, the eligible agents, and the ControlPlane
// policy when the project is governed by one.
export function renderProjectSettings(p: ProjectRecord, ownerName: string | null = null): string {
  const policy = `<dl>
    <dt>Required checks</dt><dd>${checkClasses(p.policy).map((v) => `<code>${e(v.command)}</code> <span class="meta">${e(classText(v))}${p.policy.checkPaths?.some((c) => c.command === v.command) ? `; ${e(appliesText(p.policy, v.command))}` : ""}</span>`).join("<br>") || "None configured"}</dd>
    <dt>Protected files</dt><dd>${p.policy.protected.map(e).join(", ") || "None configured"}</dd>
    <dt>Check execution</dt><dd>${p.policy.sandboxOnly ? "Only checks run in a Cloudflare container count" : "Checks count from a Cloudflare container or a runner's clean clone"}</dd>
    <dt>Models</dt><dd>${e(familyModeText(p.policy))}</dd>
    <dt>Eligible agents</dt><dd>${p.policy.eligible?.map(e).join(", ") || "Any agent"}</dd>
    <dt>Overlap</dt><dd>${p.policy.refuseOverlap ? "Refused" : "Flagged for review"}</dd>
    <dt>Overrides</dt><dd>${p.policy.noOverride ? "Refused: every change needs its independent review (<code>atelier init --no-override</code>)" : "Allowed with a reason, confirmed by the owner on the task's page with the Cloudflare Access sign-in or the server's confirmation secret, never the owner token"}</dd>
    <dt>Baseline</dt><dd><code>${e(p.repo)}</code></dd>
  </dl>`;
  const cp = p.policy.approval
    ? `<p class="meta standing-policy">ControlPlane policy, approved: ${e(p.policy.approval)}. Protected areas: ${p.policy.protected.map(e).join(", ") || "none"}. Eligible agents: ${p.policy.eligible?.map(e).join(", ") || "any"}. Overlapping claims: ${p.policy.refuseOverlap ? "refused" : "flagged"}.</p>`
    : '<p class="meta standing-policy">No ControlPlane policy is recorded for this project.</p>';
  return projectPage(p, "Settings", `<section class="standing" aria-label="Project policy">
  <h2 class="section-title">Policy</h2>
  ${policy}
  ${cp}
</section>`, ownerName, `Settings · ${titleOf(p)}`);
}

export function renderHistory(views: ProjectView[], ownerName: string | null = null, owner = DEFAULT_OWNER): string {
  const entries = buildTimeline(views.map((v) => ({ project: v.project, items: v.items, events: v.events ?? [] })), owner);
  const merged = entries.filter((x) => x.ending === "merged").length, closed = entries.length - merged;
  const projects = new Set(entries.map((x) => x.project.name)).size;
  const days = byDay(entries).map(({ day, entries: list }) => `<li class="timeline-day"><h2>${e(`${weekdayOf(list[0].at)} ${keyLabel(day, true)}`)}</h2><ol>${list.map((x) => {
    const model = x.holder ? splitActor(x.holder).model || x.holder : null;
    const mark = x.vendor
      ? `<i class="family-mark" title="${e(`${x.ending} while held by ${x.holder}`)}"></i>`
      : '<i class="family-mark unknown" title="who held it is not in the record read"></i>';
    const detail = [titleOf(x.project), x.item.id, model ?? "holder not in the record read", x.ending === "merged" ? (x.commit ? `merged as ${x.commit.slice(0, 8)}` : "merged") : "closed without merging"];
    return `<li class="merge-row ${x.ending}"><a href="${href("p", x.project.name, x.item.id)}">${mark}<time datetime="${e(x.at)}">${e(clock(x.at))}</time><span><strong>${e(x.item.title)}</strong><span class="meta">${detail.map(e).join(" · ")}</span></span>${tag(x.ending === "merged" ? "Merged" : "Closed", x.ending === "merged" ? "go" : "")}</a></li>`;
  }).join("")}</ol></li>`).join("");
  const lead = entries.length
    ? `${plural(merged, "task")} merged and ${closed} closed across ${plural(projects, "project")}, newest first. Each row names the model that held the task when it ended. The same work, move by move, is on <a href="/flow">Flow</a>.`
    : "Finished work, with its evidence intact. The work in motion is on <a href=\"/flow\">Flow</a>.";
  const capKey = closed ? '<li><i class="cap-key"></i>closed without merging</li>' : "";
  return page("History", `<div class="page-width">
  <header><h1>History</h1><p class="lead">${lead}</p></header>
  ${views.some((v) => v.unavailable) ? '<p class="error">Some project history is unavailable. Refresh to retry.</p>' : ""}
  ${entries.length ? familyLegend([], "You", capKey) : ""}
  <ol class="merge-timeline">${days}</ol>
  ${!entries.length ? '<p class="empty">Completed tasks will appear here after they merge or close.</p>' : ""}
</div>`, "History", ownerName);
}

// Whether a qualifying reviewer was available when the owner overrode the
// independent review, as review.overridden keeps it (t457). An override
// recorded before availability was kept says that it was not recorded.
function availabilityText(a: unknown): string {
  const r = (a ?? {}) as Partial<ReviewerAvailability>;
  if (r.known === true) {
    const at = typeof r.at === "string" ? `, ${when(r.at)}` : "";
    return r.reviewer
      ? `Reviewer availability: ${r.reviewer} qualified and was available (${str(r.source)}${at})`
      : `Reviewer availability: no qualifying reviewer was available (${str(r.source)}${at})`;
  }
  if (r.known === false) return `Reviewer availability: unknown, ${str(r.why)}${typeof r.at === "string" ? ` (${when(r.at)})` : ""}`;
  return "Reviewer availability: unknown, not recorded with this override";
}

function eventTable(events: LedgerEvent[], withItem = false): string {
  if (!events.length) return '<p class="empty">No activity recorded yet.</p>';
  return `<ol class="timeline">${events.map((v) => `<li><span class="timeline-dot"></span><div>
    <strong>${e(v.kind.replaceAll(".", " ").replaceAll("_", " "))}</strong>${withItem && v.itemId ? ` · ${e(v.itemId)}` : ""}
    <p class="meta">${e(v.actor)}${v.proved ? " · token proved" : ""} · ${when(v.at)}</p>${v.kind === "review.overridden" ? `<p class="meta">${e(availabilityText(v.data.availability))}</p>` : ""}
    <details><summary>Details</summary><pre>${e(JSON.stringify(v.data, null, 2))}</pre></details></div></li>`).join("")}</ol>`;
}

// ── a task ─────────────────────────────────────────────────────────────────

// The task's brief at body size under its short title, then its acceptance
// criteria numbered as the review brief numbers them. Nothing when neither
// is set.
function taskText(item: Item): string {
  const accept = item.accept ?? [];
  if (!item.brief && !accept.length) return "";
  return `<div class="task-text">
  ${item.brief ? `<p class="task-brief">${e(item.brief)}</p>` : ""}
  ${accept.length ? `<p class="section-title">Acceptance criteria</p><ol class="task-accept">${accept.map((c) => `<li>${e(c)}</li>`).join("")}</ol>` : ""}
</div>`;
}

// Where a task stands among the five steps, read from its recorded state and
// the required checks at its head, never from what an agent said. A step
// before the current one is done; a merged task has done all five, and a
// closed or blocked one keeps the steps it reached, with a note saying so.
export type StepState = "done" | "current" | "todo";
export interface TaskProgress { steps: { verb: Verb; line: string; state: StepState }[]; note: string | null }

export function taskProgress(item: Pick<Item, "state" | "head" | "base" | "fork" | "blocked">, checks: { grade: string; passed: boolean | null }[]): TaskProgress {
  // A fresh fork records its base as its head (Ledger.setFork), so the work
  // is pushed only once the head has moved off the base.
  const pushed = item.head !== null && item.head !== item.base;
  // Every required check observed passing at the head; with none required, a pushed head is proven.
  const proven = pushed && checks.every((c) => c.grade === "observed" && c.passed === true);
  const reached = (state: ItemState): number => {
    switch (state) {
      case "open": return 0;
      case "claimed": return pushed ? 2 : 1;
      case "submitted": return proven ? 3 : 2;
      case "accepted": case "integrated": return 4;
      case "merged": return STEPS.length;
      case "blocked": return reached(item.blocked?.from ?? "claimed");
      // Closed without landing: the steps its record shows it passed.
      case "abandoned": return !pushed ? (item.fork ? 1 : 0) : proven ? 3 : 2;
    }
  };
  const at = reached(item.state);
  const closed = item.state === "abandoned";
  const note = item.state === "blocked" ? `Blocked at ${STEPS[at]?.verb ?? "Land"}` : closed ? "Closed without landing" : item.state === "merged" ? "Landed" : null;
  return {
    steps: STEPS.map((s, i) => ({ verb: s.verb, line: s.line, state: i < at ? "done" : i === at && !closed ? "current" : "todo" })),
    note,
  };
}

function progressBlock(item: Item, checks: { grade: string; passed: boolean | null }[]): string {
  const { steps, note } = taskProgress(item, checks);
  return `<ol class="task-steps" aria-label="Progress: claim, fork, prove, review, land">${steps.map((s) =>
    `<li class="${s.state}"${s.state === "current" ? ' aria-current="step"' : ""}><b>${e(s.verb)}</b><span>${s.state === "current" ? (item.state === "blocked" ? "Blocked here" : "Now") : s.state === "done" ? "Done" : e(s.line)}</span></li>`).join("")}</ol>
  ${note && item.state !== "blocked" ? `<p class="meta task-steps-note">${e(note)}</p>` : ""}`;
}

// A task's page sits inside its project's area: the project's tab bar above
// the review sheet, the area reached from Home. The five steps sit above
// the sheet, the task's current one marked.
// A task landed in fast mode (t585): the receipt the owner's batch
// recorded, the same-family reviews it allowed, and the fix task a rejected
// post-merge review filed.
function fastLandingBlock(p: ProjectRecord, d: Detail): string {
  const ev = d.events.find((x) => x.kind === "item.landed_fast");
  if (!ev) return "";
  const r = ev.data as Record<string, unknown>;
  const tests = (r.tests ?? {}) as { command?: string; sha256?: string; where?: string };
  const short = (v: unknown) => e(String(v ?? "").slice(0, 12));
  const ran = tests.where === "clean clone" ? " in a clean clone of the batch's head" : tests.where === "checkout" ? " in the owner's checkout" : "";
  const sameFamily = d.reviews.filter((x) => x.independence).map((x) => `<li>${e(x.by)}: ${e(x.independence!)}</li>`).join("");
  const fixes = d.events.filter((x) => x.kind === "item.fix_filed" && typeof x.data.foundIn === "string").map((x) => `<p>Fix after fast landing: <a href="${href("p", p.name, String(x.data.foundIn))}">${e(String(x.data.foundIn))}</a></p>`).join("");
  return `<div class="fast-landing"><p><strong>Landed in fast mode</strong> on ${e(ev.at.slice(0, 16).replace("T", " "))} UTC: ${short(r.commit)} merged as ${short(r.mergeCommit)}, built by ${e(String(r.builder ?? ""))}. Reason: ${e(String(r.reason ?? ""))}.</p>
  <p class="meta">Tests: <code>${e(tests.command ?? "")}</code>${ran}, output sha256 <code>${short(tests.sha256)}</code>. It skipped the gate; its post-merge review audits it.</p>${sameFamily ? `<ul>${sameFamily}</ul>` : ""}${fixes}</div>`;
}

// A task a runner built in fast mode (t589) and reported ready: the commit
// the owner's batch takes, as atelier fast land takes it.
function fastReadyBlock(d: Detail): string {
  if (d.item.state === "merged" || d.item.state === "abandoned") return "";
  const ready = standingFastReady(d.events);
  if (!ready) return "";
  return `<div class="fast-ready"><p><strong>Ready for fast land at <code>${e(ready.commit.slice(0, 12))}</code></strong>: built by ${e(ready.builder)}${ready.runner ? ` on ${e(ready.runner)}` : ""} on main at <code>${e(ready.base.slice(0, 12))}</code>, reported ${e(ready.at.slice(0, 16).replace("T", " "))} UTC. No fork was made; the owner lands it with the next batch.</p>
  <p class="meta"><code>atelier fast land ${e(d.item.id)}=${e(ready.commit)}</code></p></div>`;
}

export function renderItem(p: ProjectRecord, d: Detail, ownerName: string | null = null, diff: ItemDiff | "unavailable" | null = null, live?: Live): string {
  return page(d.item.title, `<div class="page-width">
  ${projectTabs(p, "Tasks", d.item.id)}
  ${progressBlock(d.item, evidenceAt(d.policy, d.evidence, d.item.head).checks)}
  <article class="review-sheet standalone" id="review">${reviewBody({ project: p, detail: d, diff, thread: true, full: true })}</article>
</div>`, "Home", ownerName, 0, true, live);
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

// The task page's thread, full width on a time axis. The brief's one line
// stays in the brief below it; the graph itself is not annotated (finding 23).
function threadBlock(p: ProjectRecord, d: Detail): string {
  const story = taskStory(p.name, d);
  if (!story) return "";
  const owner = d.ownerActor ?? DEFAULT_OWNER;
  return `<section class="review-section task-thread" id="thread" aria-label="This task's thread">
  <h3>Thread</h3>
  ${legendLine(Object.keys(story.tally.byVendor) as Vendor[], story.tally.localRuns > 0)}
  <div class="stage-scroll">${drawStory(story, owner, { replaySeconds: 0 })}</div>
</section>`;
}

const shell = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

// ── where the owner's decision stands (t457) ───────────────────────────────
// On 2026-10-10 the owner's approval was recorded and the page looked the
// same, so it read as a button that did nothing. The task page now says, beside
// its actions and from the record alone, four separate things, and the one next
// move or what it waits for:
//
//   approval      the owner's latest review at this head and criteria. It is
//                 the owner's own opinion and never the independent review.
//   independent   a review from a qualifying model, the owner's override of it,
//                 or that this change needs none.
//   permission    `atelier accept --override-review` from the command line:
//                 active (revision, expiry), expired, consumed, invalidated by
//                 a new revision or a page override, never given, forbidden
//                 or not confirmable.
//   acceptance    accepted, ready, not ready (blockers), unavailable while the
//                 changes shown are not the recorded revision, or terminal.
//
// Each cell is plain text with its tone; nothing here records anything.
export type StateTone = "go" | "ask" | "bad" | "";
export interface StateCell { label: string; text: string; tone: StateTone }
export interface OwnerState {
  approval: StateCell & { review: Review | null };
  independent: StateCell;
  permission: StateCell & { status: "active" | "expired" | "consumed" | "invalidated" | "none" | "forbidden" | "unconfirmable" | "not-applicable" };
  acceptance: StateCell;
  next: { kind: "next" | "waiting" | "complete"; text: string };
}

// The CLI permission as the record shows it. The Ledger clears a permission
// when any override is made, from the command line (which consumes it) or
// from this page (which leaves it unused and ends it), so a cleared one is
// read from the events: an `override.allowed` followed by a
// `review.overridden`, whose `confirmed` says which. Expired is said only
// once its time has passed.
function permissionState(d: Detail, now: number, owner: string): OwnerState["permission"] {
  const { item } = d;
  const label = "Command-line permission";
  const cell = (status: OwnerState["permission"]["status"], text: string, tone: StateTone = "") => ({ label, status, text, tone });
  const events = [...d.events].sort((a, b) => a.seq - b.seq);
  const allowed = events.filter((v) => v.kind === "override.allowed").at(-1);
  const spent = allowed && events.find((v) => v.seq > allowed.seq && v.kind === "review.overridden");
  if (spent && str(spent.data.head) === item.head) {
    return spent.data.confirmed === "command line"
      ? cell("consumed", `Consumed by the command-line override at ${short(item.head)}, ${when(spent.at)}; it allows nothing more`)
      : cell("invalidated", `Invalidated by your override on this page at ${short(item.head)}, ${when(spent.at)}; it was never used`);
  }
  // A permission given before the project turned on noOverride stays on the
  // record, but the Ledger refuses its use, so it is said to be prohibited,
  // never active.
  const active = confirmationAt(item, now, owner);
  if (active && d.policy.noOverride) return cell("forbidden", `Prohibited by policy: given for revision ${short(active.head)} until ${when(active.until)}, but this project now refuses every override, so it allows nothing`, "bad");
  if (active) return cell("active", `Active for revision ${short(active.head)} until ${when(active.until)}, for one override`, "ask");
  // A permission spent at an earlier revision says nothing about this one.
  const standing = item.overrideConfirmation ?? (allowed && !spent ? { head: str(allowed.data.head), until: str(allowed.data.until) } : null);
  if (standing && standing.head !== item.head) return cell("invalidated", `Invalidated: given for revision ${short(standing.head)}, and the revision has changed since`);
  if (standing && standing.until && Date.parse(standing.until) <= now) return cell("expired", `Expired ${when(standing.until)}, unused`);
  if (standing) return cell("invalidated", "Invalidated: no longer on record, so it allows nothing");
  if (d.policy.noOverride) return cell("forbidden", "Forbidden: this project refuses every override");
  if (item.state !== "submitted" || !d.gate.needsAssessor) return cell("not-applicable", "Not given; there is no missing independent review to override");
  if ((d.ownerFactor ?? null) === null) return cell("unconfirmable", "Unavailable: this server takes no owner confirmation");
  return cell("none", "Not given");
}

export function ownerState(d: Detail, evidenceVisible: boolean, now = Date.now()): OwnerState {
  const { item, gate } = d;
  const owner = d.ownerActor ?? DEFAULT_OWNER;
  const binding = bindingOf(item);
  // Every review-based reading below — the owner's own, a rejection, a
  // send-back — takes the reviews the gate counts: a reviewer who has since
  // lost the authority to review is no more heard here than there.
  const latest = countingReviews(d.reviews, binding, d.policy, owner);
  const mine = latest.find((r) => r.by === owner) ?? null;
  const live = item.state === "claimed" || item.state === "submitted";
  const decision = decisionFor(item, d.policy, d.evidence, d.reviews, owner);

  // A review of an earlier head or of criteria since changed no longer
  // stands, and the page says so rather than show it as current.
  const stale = !mine && d.reviews.some((r) => r.by === owner && !r.withdrawn && (r.head !== item.head || r.criteria !== binding.criteria));
  const approval: OwnerState["approval"] = {
    label: "Your approval", review: mine,
    ...(mine?.approve
      ? { text: `Approved by you at ${short(mine.head)}, ${when(mine.at)}`, tone: "go" as const }
      : mine
        ? { text: `You requested changes at ${short(mine.head)}, ${when(mine.at)}`, tone: "ask" as const }
        : !item.head
          ? { text: "No revision to approve yet", tone: "" as const }
          : { text: stale ? "Not given at this revision; your earlier review was of another revision or other criteria" : "Not given", tone: "" as const }),
  };

  const overridden = overrideAt(item, owner);
  const voided = !!overridden && !!d.policy.noOverride && item.state !== "merged";
  const changed = evidenceAt(d.policy, d.evidence, item.head).changedPaths;
  // The approval credited as the independent review is the one the gate
  // itself would count: an authorised reviewer's latest at this head and
  // criteria that passes independentApproval for the change's class, the
  // latest of them when several do. An earlier approval of a contributor's
  // own family is never named in its place.
  const kind = changed === null ? null : changeClass(changed, d.policy);
  const reviewed = kind === "protected" || (d.policy.execution !== undefined && kind === "coordinated") ? kind : null;
  const contributors = contributorsOf(item);
  const independentReview = reviewed
    ? countingReviews(d.reviews, binding, d.policy, owner).filter((r) => independentApproval(r, reviewed, contributors, owner, singleFamily(d.policy))).sort((a, b) => b.at.localeCompare(a.at))[0]
    : undefined;
  const independentRejection = latest.find((r) => r.by !== owner && !r.approve);
  const independent: StateCell = { label: "Independent review", ...(
    overridden && !voided ? { text: `Overridden by you, ${when(overridden.at)}: not a review`, tone: "ask" as const }
    : independentRejection ? { text: `Rejected by ${independentRejection.by} at ${short(independentRejection.head)}`, tone: "bad" as const }
    : gate.needsAssessor ? { text: decision.action === "review" ? "Required, not yet given" : "Required and not yet given; your approval does not count as it", tone: "ask" as const }
    : independentReview ? { text: `Approved by ${independentReview.by}`, tone: "go" as const }
    : !item.head ? { text: "No revision to review yet", tone: "" as const }
    : changed === null && live ? { text: "Pending: the changed paths are not yet observed", tone: "ask" as const }
    : { text: "Not required for this change", tone: "" as const }) };

  const permission = permissionState(d, now, owner);

  const secretHeld = !!item.head && (item.secretScan === item.head || (item.secret ?? []).some((f) => f.head === item.head && !f.cleared));
  const blockers = gate.blockers.length;
  const acceptance: StateCell = { label: "Acceptance", ...(
    item.state === "merged" ? { text: item.acceptedHead ? `Accepted at ${short(item.acceptedHead)}` : "Accepted", tone: "go" as const }
    : item.state === "abandoned" ? { text: "Closed without merging", tone: "" as const }
    : item.state === "accepted" ? { text: `Accepted at ${short(item.acceptedHead)}; not yet merged`, tone: "go" as const }
    : item.state === "integrated" ? { text: `Integrated into ${item.plan ?? "its plan"}${item.head ? ` at ${short(item.head)}` : ""}; lands with the plan`, tone: "go" as const }
    : item.state === "blocked" ? { text: "Not possible while the task is blocked", tone: "ask" as const }
    : live && item.head && !evidenceVisible ? { text: "Unavailable until the changes shown match the recorded revision", tone: "ask" as const }
    : item.state !== "submitted" ? { text: "Not submitted yet", tone: "" as const }
    : gate.ready ? { text: "Not yet recorded; nothing blocks it", tone: "go" as const }
    : { text: `Not ready: ${plural(blockers, "blocker")}`, tone: "bad" as const }) };

  // The headline above states the state and its reason; this line gives only
  // the move that follows, or who it waits on, never the state again (t498).
  const sentBack = item.state === "submitted" && latest.some((r) => !r.approve);
  const holder = item.owner ? `the task owner, ${item.owner}` : "the task owner";
  const holderMid = item.owner ? `${holder},` : holder;
  const next: OwnerState["next"] =
    item.state === "merged" || item.state === "abandoned" ? { kind: "complete", text: "Nothing waits on you." }
    : item.state === "blocked" ? { kind: "next", text: "Unblock the task once what it waits on is settled." }
    : item.state === "accepted" ? { kind: "next", text: "Merging, with the command below." }
    : item.state === "integrated" ? { kind: "waiting", text: `For ${item.plan ?? "its plan"} to land: this part is submitted and integrated into the plan's branch, and is accepted and merged with the plan, not on its own.` }
    : live && item.head && !evidenceVisible ? { kind: "next", text: "Reload this task; approval and acceptance wait until the changes shown match the recorded revision." }
    : secretHeld ? { kind: item.secretScan === item.head ? "waiting" : "next", text: item.secretScan === item.head ? "For the secret scan of this revision to complete." : "Check the flagged line and clear the flag if it is not a secret." }
    : decision.action === "accept" ? { kind: "next", text: "Accept revision, below; the merge command follows." }
    : item.state === "submitted" && mine && !mine.approve && !gate.needsAssessor && gate.blockers.length === 1 ? { kind: "next", text: "Approve the revision if your concern is met; otherwise wait for the task owner's next push." }
    // A rejection at this revision blocks whatever review is asked next, so
    // the way on is a new revision, not a landing (which asks for a review).
    : sentBack ? { kind: "waiting", text: `For ${holderMid} to address the review and push a new revision; a landing then asks for a fresh review.` }
    : decision.action === "review" ? { kind: "next", text: "Run the landing command below." }
    : item.state === "open" ? { kind: item.dispatch ? "waiting" : "next", text: item.dispatch ? "For a runner to claim the task." : "Send the task to an agent, or wait for one to claim it." }
    : { kind: "waiting", text: `For ${holder}.` };

  return { approval, independent, permission, acceptance, next };
}

const NEXT_LABEL: Record<OwnerState["next"]["kind"], string> = { next: "Next", waiting: "Waiting", complete: "Done" };

function ownerStateBlock(s: OwnerState): string {
  const row = (c: StateCell) => `<div><dt>${e(c.label)}</dt><dd${c.tone ? ` class="${c.tone}"` : ""}>${e(c.text)}</dd></div>`;
  // The owner's own approval, once recorded, is said here once, beside the
  // actions below it, with its short head and zoned time (t457); Approve is
  // then not offered again.
  const mine = s.approval.review;
  const approval = mine?.approve
    ? `<div><dt>${e(s.approval.label)}</dt><dd class="go"><span class="approval-recorded" role="status"><strong>Approved by you</strong> at <code>${e(short(mine.head))}</code> · <time datetime="${e(mine.at)}">${e(stamp(mine.at))}</time></span></dd></div>`
    : row(s.approval);
  return `<section class="owner-state" aria-label="Where this revision stands">
  <dl>${approval}${[s.independent, s.permission, s.acceptance].map(row).join("")}</dl>
  <p class="next-action"><strong>${NEXT_LABEL[s.next.kind]}:</strong> ${e(s.next.text)}</p>
</section>`;
}

// A refused submission, beside the form it came from: what was refused, that
// nothing was recorded, and the way on. Linked to the form's button.
function formErrorText(err: FormError | undefined, verb: FormError["verb"], reload: string): string {
  if (err?.verb !== verb) return "";
  // The Ledger's refusals are clauses ("this task changed since…"); drawn as
  // a sentence, leaving one that opens on a task id ("t1's…") as it is.
  const said = /^[a-z]+[\s,;:]/.test(err.message) ? err.message.charAt(0).toUpperCase() + err.message.slice(1) : err.message;
  return `<p class="error form-error" role="alert" id="error-${verb}">${e(/[.!?]$/.test(said) ? said : `${said}.`)} Nothing was recorded from this attempt. <a href="${reload}">Reload this task</a> to see its current revision, then try again.</p>`;
}

function submissionRounds(d: Detail): string {
  const { rounds } = taskPage(d);
  return `<section class="review-section" aria-label="Submission rounds"><h3>Submission rounds</h3>
    ${rounds.length ? rounds.map(({ submission: s, verdicts }, i) => `<details class="disclosure"${i === 0 ? " open" : ""}><summary>Submission · event ${e(String(s.seq))} · Head ${e(String(s.data.head ?? "unknown"))} · ${when(s.at)}</summary>
      <p>${e(String(s.data.summary ?? "No submission summary recorded."))}</p>
      ${verdicts.length ? verdicts.map(v => `<article><h4>${e(v.kind === "review.rejected" ? "Changes requested" : v.kind === "review.approved" ? "Approved" : v.kind)} · ${e(v.actor)}</h4><p>${e(String(v.data.note ?? v.data.reason ?? "No verdict reason recorded."))}</p>
        ${Array.isArray(v.data.findings) ? `<ul>${v.data.findings.filter((f): f is Finding => !!f && typeof f.file === "string" && typeof f.text === "string" && typeof f.severity === "string" && (f.line === null || typeof f.line === "number")).map(f => `<li>${e(f.file)}${f.line ? `:${f.line}` : ""} · ${e(f.severity)} · ${e(f.text)}</li>`).join("")}</ul>` : ""}</article>`).join("") : "<p>No triage or review verdict recorded for this submission.</p>"}
      </details>`).join("") : "<p>Submission history is unavailable.</p>"}</section>`;
}

// A standing secret flag (t332) names its file and line, never the value,
// and offers the one way on: the owner clears it with a reason, which is
// recorded. A scan still pending for the head blocks the same way, with
// nothing to clear: it completes on the next push event retry or `atelier push`.
// The task page and the Decisions detail draw the same notice and form.
function secretNotice(item: Item, revision: string, action: (verb: string) => string): string {
  const secrets = (item.secret ?? []).filter((f) => f.head === item.head && !f.cleared);
  const scanPending = !!item.head && item.secretScan === item.head;
  return scanPending
    ? `<div class="notice" role="status"><h3>Secret scan pending</h3>
        <p class="meta">The push at <code>${e(item.head!.slice(0, 8))}</code> has not been scanned for key patterns yet. Acceptance and merge are refused until the scan completes; it is retried on its own, and <code>atelier push</code> runs it again.</p></div>`
    : secrets.length
    ? `<div class="notice" role="status"><h3>Secret flagged</h3>
        <ul>${secrets.map((f) => `<li><code>${e(f.file)}${f.unscanned ? "" : `:${f.line}`}</code>${f.unscanned ? ` not scanned${f.reason ? `: ${e(f.reason)}` : ""}` : ""}</li>`).join("")}</ul>
        <p class="meta">A key pattern was found in the added lines. Acceptance and merge are refused until it is cleared. Clear it only after checking the line is not a real secret; the reason you give is recorded.</p>
        <form class="stack" method="post" action="${action("clear-secret")}">${revision}
          <label>Why is this line not a secret?<textarea name="note" required rows="2" maxlength="${REASON_MAX}"></textarea></label>
          <button class="primary">Clear the flag</button>
        </form></div>`
    : "";
}

function reviewBody({ project: p, detail: d, diff, thread, full }: ReviewContext): string {
  const { item, gate } = d;
  // The company the project runs on alone (t394), named wherever the page
  // says what review the change needs, so the ask is never a cross-company one.
  const single = singleFamily(d.policy);
  const presentation = taskPage(d);
  const notices = presentation.notices.map(n => `<details class="disclosure"><summary>${e(n.kind)} · ${n.originals.length} reports · ${e(n.check || "check unknown")} · ${n.originals.every(r => r.superseded) ? "Superseded" : `${n.originals.filter(r => !r.superseded).length} unresolved`}</summary>
    <p class="meta">Criteria binding: ${e(n.criteria || "unknown")}. A reported limitation is superseded only by an observed pass covering the same check and binding.</p>
    ${n.originals.map(r => `<article><p>${e(r.detail)}</p><p class="meta">${e(r.actor)} · ${e(r.runner)} · ${e(r.at)} · Head ${e(r.head || "unknown")} · ${r.superseded ? "Superseded by an observed pass" : "Coverage unconfirmed"}</p></article>`).join("")}</details>`).join("");
  const view = evidenceAt(d.policy, d.evidence, item.head);
  const decision = decisionFor(item, d.policy, d.evidence, d.reviews, d.ownerActor);
  const live = item.state === "claimed" || item.state === "submitted";
  const action = (verb: string) => href("ui", p.name, item.id, verb);
  // The criteria the page shows are the ones an approval or rejection from it judged.
  const revision = `<input type="hidden" name="head" value="${e(item.head ?? "")}"><input type="hidden" name="criteria" value="${e(bindingOf(item).criteria)}">`;
  const evidenceVisible = !!diff && diff !== "unavailable" && diff.head === item.head;
  // The checks on the would-be merge, read against main's head as the
  // preview read it, so a run main has moved past is marked stale.
  const mergedChecks = diff && diff !== "unavailable" && diff.main ? mergedChecksAt(d.policy, d.evidence, item.head, diff.main.head) : undefined;

  const reject = live && item.head
    ? `<details class="request-changes"${d.formError?.verb === "reject" ? " open" : ""}><summary>Request changes</summary>
      <form class="stack" method="post" action="${action("reject")}">${revision}
        <label>What needs to change?<textarea name="note" required rows="3" maxlength="2000">${e(d.formError?.verb === "reject" ? d.formError.note ?? "" : "")}</textarea></label>
        <button${d.formError?.verb === "reject" ? ' aria-describedby="error-reject"' : ""}>Send review</button>${formErrorText(d.formError, "reject", href("p", p.name, item.id))}
      </form></details>`
    : "";
  const evidenceNotice = live && item.head && !evidenceVisible
    ? `<div class="notice" role="status"><h3>${diff && diff !== "unavailable" ? "The displayed revision has changed" : "Changes are unavailable"}</h3>
      <p>Approval and acceptance are unavailable until the displayed changes match this task’s recorded revision. <a href="${href("p", p.name, item.id)}">Reload this task</a>. If the revision changed, the task owner should run <code>atelier push</code> and rerun checks.</p></div>`
    : "";
  const counted = countingReviews(d.reviews, bindingOf(item), d.policy, d.ownerActor ?? DEFAULT_OWNER);
  const reviewWanted = decision.action === "review" || counted.some((r) => !r.approve);
  // While the gate needs the independent review, the owner's approval cannot
  // satisfy it — the decision line and the protected note below both say so —
  // so Approve records the owner's own opinion as a secondary action, never
  // the primary one. Where the owner's approval counts, on a revision a review
  // at this head sent back, it stays primary.
  // The owner's own approval at this head and criteria, once recorded, is
  // said once, in the owner-state block just above the actions, and Approve
  // is not offered again while it approves (t457): a press that changed
  // nothing on the page read as failed.
  const state = ownerState(d, evidenceVisible);
  const mine = state.approval.review;
  const reload = href("p", p.name, item.id);
  const fail = (verb: FormError["verb"]) => formErrorText(d.formError, verb, reload);
  const described = (verb: FormError["verb"]) => d.formError?.verb === verb ? ` aria-describedby="error-${verb}"` : "";
  const approve = evidenceVisible && live && item.head && reviewWanted && !mine?.approve
    ? `<form method="post" action="${action("approve")}">${revision}<button${gate.needsAssessor ? "" : ' class="primary"'}${described("approve")}>Approve revision</button>${fail("approve")}</form>`
    : "";
  const accept = evidenceVisible && decision.action === "accept"
    ? `<form method="post" action="${action("accept")}">${revision}<button class="primary"${described("accept")}>Accept revision</button>${fail("accept")}</form>`
    : "";
  // The owner's override, offered only while the missing independent review
  // is the one thing blocking this revision, since it waives that and nothing
  // else. Its reason is required and recorded.
  // A project that forbids overrides (t371) offers neither form and says so.
  // The forms carry the owner's confirmation, a factor no agent holds: the
  // Access identity every page carries behind Access, or the server's
  // confirmation secret, typed into the form (a session alone is not it,
  // since the owner token buys one). A server with neither offers no form
  // and says what to set. The second form gives `atelier accept
  // --override-review` a quarter of an hour's permission for this head,
  // which the owner token alone never has, and the note says while one stands.
  const overridable = evidenceVisible && item.state === "submitted" && !!item.head && gate.needsAssessor && gate.blockers.length === 1;
  const allowed = confirmationAt(item, Date.now(), d.ownerActor ?? DEFAULT_OWNER);
  const factor = d.ownerFactor ?? null;
  const confirmField = factor === "secret"
    ? `<label>Confirmation secret<input type="password" name="confirmation" required autocomplete="off"></label>`
    : "";
  const confirmWords = factor === "access"
    ? "Your Cloudflare Access sign-in is the confirmation an override needs; the owner token alone cannot give it."
    : "The confirmation secret is the confirmation an override needs: the server's own OVERRIDE_SECRET, which no session is given, so the owner token alone cannot give it.";
  const override = overridable && d.policy.noOverride
    ? `<p class="meta">This project forbids overrides of the independent review (<code>atelier init --no-override</code>): the revision lands only with an approval from ${single ? `a different ${single} model from every contributor (single-family mode)` : "a model of another family than every contributor"}.</p>`
    : overridable && factor === null
    ? `<p class="meta">An override of the independent review needs the owner's own confirmation, which ${e(NO_OWNER_FACTOR)}; then reopen this page. The owner token alone, and the session it signs in, cannot confirm one.</p>`
    : overridable
    // A native disclosure (t457), drawn as one and not as a button: a marker
    // that turns and words that change when it opens. Opening it submits
    // nothing; each of its two forms has its own explicit button. A refused
    // override reopens it with the reason kept and the secret never refilled.
    ? `<details class="override-disclosure"${d.formError?.verb === "override" || d.formError?.verb === "allow-override" ? " open" : ""}><summary><span class="disclosure-marker" aria-hidden="true"></span>Accept without an independent review <span class="meta disclosure-hint"><span class="when-closed">show the override and command-line permission</span><span class="when-open">hide</span></span></summary>
      <form class="stack" method="post" action="${action("override")}">${revision}
        <h4>Override and accept</h4>
        <label>Why are you overriding the independent review?<textarea name="note" required rows="3" maxlength="${OVERRIDE_REASON_MAX}">${e(d.formError?.verb === "override" ? d.formError.note ?? "" : "")}</textarea></label>${confirmField}
        <p class="meta">This records your override and its reason on the task and in the inbox, and accepts the revision. It is not a review. ${confirmWords}</p>
        <button${described("override")}>Override the review and accept</button>${fail("override")}
      </form>
      <form class="stack" method="post" action="${action("allow-override")}">${revision}
        <h4>Command-line permission</h4>${confirmField}
        <p class="meta">${allowed
          ? `You allowed an override from the command line for this revision until ${e(when(allowed.until))}: <code>atelier accept ${e(item.id)} --override-review "reason"</code> is taken until then, once.`
          : `Or allow <code>atelier accept ${e(item.id)} --override-review "reason"</code> from the command line for this revision, for ${OVERRIDE_CONFIRMATION_MS / 60000} minutes and one override; without it the command is refused.`} Allowing it approves, overrides and accepts nothing by itself.</p>
        <button${described("allow-override")}>${allowed ? "Allow it again from now" : "Allow an override from the command line"}</button>${fail("allow-override")}
      </form></details>`
    : "";
  // The primary action while the gate waits for the independent review is the
  // move that settles it: asking a qualifying reviewer, which a landing does
  // (it requests the review and waits for its verdict), or waiting for one.
  // The owner's Approve cannot satisfy the gate, so it is not that action,
  // and the override above stays the way on when no reviewer qualifies.
  const askReview = decision.action === "review" && !counted.some((r) => !r.approve)
    ? `<div class="merge-command"><p>To move this task, ask ${single ? `a different ${single} model (single-family mode)` : "a model of another family"} to review the revision. In the registered checkout, run:</p>
      <pre tabindex="0">${e(`atelier land ${item.id} --project ${shell(p.name)}`)}</pre>
      <p class="meta">The landing merges main into the workspace, runs the required checks, requests this review — from the model <code>--reviewer</code> names, or one ${single ? `that is a different ${single} model from every contributor` : "of another family than every contributor"} — and waits for its verdict, then accepts and merges. Until then the task waits.</p></div>`
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
  // A refused form the page no longer draws (an Accept refused as not ready,
  // an override the project now forbids) has its refusal said first among
  // the actions, so no refusal is lost, and the reason typed into it is shown
  // beside it, unrecorded, so it can be copied rather than typed again.
  const unplaced = d.formError && ![approve, accept, override, reject].some((f) => f.includes(`id="error-${d.formError!.verb}"`))
    ? formErrorText(d.formError, d.formError.verb, reload) + (d.formError.note
      ? `<div class="kept-note"><p class="meta">The reason you typed, which was not recorded:</p><blockquote>${e(d.formError.note)}</blockquote></div>`
      : "")
    : "";

  // An open task can be sent to a runner; a queued one shows who it waits for.
  const dispatchBox = item.state === "open" && !item.owner
    ? item.dispatch
      ? `<div class="notice" role="status"><h3>Waiting for ${e(describeDispatch(item.dispatch))}</h3>
        <p>Sent by ${e(item.dispatch.by)} ${when(item.dispatch.at)}. The first matching runner to ask for work claims it.</p>
        ${item.dispatch.note ? `<p class="dispatch-note">${e(item.dispatch.note)}</p>` : ""}
        <form method="post" action="${action("undispatch")}">${revision}<button>Withdraw</button></form></div>`
      : `<details class="request-changes dispatch-form"><summary>Send to an agent</summary>
        <form class="stack" method="post" action="${action("dispatch")}">${revision}
          <label>Where<select name="to"><option value="any">Any runner</option><option value="home">Home runner (your Macs and the Mac Studio)</option><option value="cloud">Cloud runner</option></select></label>
          <label>Agent<select name="agent"><option value="">Runner's choice</option><option value="claude-code">Claude Code</option><option value="codex">Codex</option><option value="zcode">ZCode (GLM)</option><option value="opencode">OpenCode (local models)</option><option value="antigravity">Antigravity (Gemini)</option><option value="gemini-cli">Gemini CLI</option></select></label>
          <label>Model <span class="meta">optional, as the runner names it</span><input type="text" name="model" placeholder="e.g. glm-5.3-flash"></label>
          <label>Note for the agent <span class="meta">optional; a full set of findings fits</span><textarea name="note" rows="4" maxlength="${DISPATCH_NOTE_MAX}"></textarea></label>
          <button class="primary">Send</button>
        </form></details>`
    : "";

  const secretBox = secretNotice(item, revision, action);

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

  // One task headline; check outcomes stay with their evidence below.
  const header = `<header class="review-header">
  <p class="context">${e(titleOf(p))} · ${e(item.id)}</p>
  <h2>${e(item.title)}</h2>
  ${full ? taskText(item) : ""}
  <p class="decision-status ${decision.tone}"><strong>${e(presentation.title)}</strong></p>
  <p class="review-description">${e(presentation.detail)}</p>
  ${presentation.unknowns.map(x => `<p class="meta">${e(x)}</p>`).join("")}
  ${evidenceNotice}
  ${ownerStateBlock(state)}
  <div class="actions">${unplaced}${approve}${accept}${override}${reject}${dispatchBox}${blockBox}</div>
  ${secretBox}
  ${askReview}${merge}${reaccept}
  <p class="meta revision">${item.head ? `Revision <code>${short(item.head)}</code>` : "No revision pushed yet"}${item.owner ? ` · ${e(item.owner)}` : ""}</p>
</header>`;

  // The owner's framing, set with atelier new or atelier edit: shown only
  // when any of it is set, above the brief, where an agent or reviewer reads first.
  const list = (entries: string[]) => `<ul>${entries.map((x) => `<li>${e(x)}</li>`).join("")}</ul>`;
  const defectOrigin = d.events.filter((ev) => ev.kind === "item.defect_of" && typeof ev.data.itemId === "string").map((ev) => `<p>Defect from post-merge review of <a href="${href("p", p.name, String(ev.data.itemId))}">${e(String(ev.data.itemId))}</a>.</p>`).join("");
  const framing = item.nonGoals?.length || item.stopWhen?.length || item.nextGate
    ? `<section class="review-section framing" id="framing" aria-label="How the task is framed"><h3>Framing</h3><dl>
    ${item.nonGoals?.length ? `<dt>Non-goals</dt><dd>${list(item.nonGoals)}</dd>` : ""}
    ${item.stopWhen?.length ? `<dt>Stop when</dt><dd>${list(item.stopWhen)}</dd>` : ""}
    ${item.nextGate ? `<dt>Next gate</dt><dd>${e(item.nextGate)}</dd>` : ""}
  </dl></section>`
    : "";

  // A task with nothing pushed is not a review: there is no revision to
  // check, no diff to read and no checks that ran, so the page shows its
  // framing, its scope and the dispatch box, nothing shaped like a review
  // (finding 17). Whoever holds it can still be changed, so the ownership
  // forms stay under Technical details.
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
  const technical = `<dl>
    <dt>Workspace</dt><dd><code>${e(item.fork ?? "Not created")}</code></dd>
    <dt>Forked at</dt><dd><code>${short(item.base)}</code></dd>
    <dt>Scope</dt><dd>${item.scope.map(e).join(", ") || "Unrestricted"}</dd>
    <dt>Last push</dt><dd>${when(item.lastPushAt)}</dd>
  </dl>`;
  if (item.head === null) {
    const openScope = `<section class="review-section" aria-label="Scope"><h3>Scope</h3>
      <p>${item.scope.map(e).join(", ") || "Unrestricted"}</p>
      <p class="meta">${item.owner ? `${e(item.owner)} holds it; nothing is pushed for review yet.` : "Any eligible agent can claim it; until then nothing is pushed for review."}</p></section>`;
    return `${header}
${defectOrigin}${framing}${openScope}${fastReadyBlock(d)}
${notices}
${submissionRounds(d)}
<details class="disclosure" id="history"><summary>Task history</summary>${eventTable(d.events)}</details>
<details class="disclosure"><summary>Technical details${live ? " and ownership" : ""}</summary>${technical}${ownership}${close}</details>`;
  }

  const scope = gate.outOfScope.length
    ? `<details class="notice"><summary>Scope changed · ${gate.outOfScope.length} file${gate.outOfScope.length === 1 ? "" : "s"}</summary>
      <p>These changes extend beyond the original task scope. Include them in your review.</p>
      <ul>${gate.outOfScope.map((f) => `<li><code>${e(f)}</code></li>`).join("")}</ul></details>`
    : "";
  const protectedNote = gate.needsAssessor
    ? `<div class="notice"><h3>${gate.changeClass === "coordinated" ? "Coordinated change" : "Protected change"}</h3><p>${e(gate.requirement ? `${gate.requirement}.` : `These files affect protected behavior and need an approval from ${single ? `a different ${single} model than every contributor (single-family mode)` : "a model of another family than every contributor"}.`)} Your own approval does not count as that review.</p></div>`
    : "";

  // The head's own runs: a merged check ran on another tree and is shown
  // beside the merge preview instead.
  const checkRows = view.checks.map((c) => {
    const runs = d.evidence
      .filter((x) => x.head === item.head && x.claim === c.claim && x.grade === "observed" && !x.merged && !x.notApplicable && (!d.policy.sandboxOnly || x.where === "sandbox"))
      .sort((a, b) => a.at.localeCompare(b.at));
    const last = runs.at(-1);
    const status = c.grade === "pending" ? tag("Waiting", "ask") : c.passed ? tag("Passed", "go") : tag("Failed", "bad");
    const where = c.grade === "observed" ? whereChip(c.where) : "";
    const uncounted = !last && d.policy.sandboxOnly && d.evidence.some((x) => x.head === item.head && x.claim === c.claim && x.grade === "observed" && !x.merged && x.where !== "sandbox");
    // The load the run started at, one decimal, so a failure under a
    // saturated machine stays legible beside a later pass (t403).
    const loadOf = (x: Evidence) => (x.load !== undefined ? `load ${Math.round(x.load * 10) / 10}` : "");
    const detail = last
      ? `${e(last.by)} · ${e(WHERE[last.where ?? "runner"][0])} · ${when(last.at)}${loadOf(last) ? ` · ${loadOf(last)}` : ""}`
      : uncounted
        ? "This check ran on a runner, which does not count for this project. Run <code>atelier check --sandbox</code> to run it in a Cloudflare container."
        : "The task owner must run this required check.";
    // Every result at this head is kept and shown, each with its load, so a
    // later pass of an unchanged command does not replace its earlier failure.
    const history = runs.length > 1
      ? `<ul class="check-runs">${runs.map((x) => `<li>${x.passed ? tag("Passed", "go") : tag("Failed", "bad")}<span class="meta">${e(x.by)} · ${when(x.at)}${loadOf(x) ? ` · ${loadOf(x)}` : ""}</span></li>`).join("")}</ul>`
      : "";
    return `<details class="check-row"${c.passed === false ? " open" : ""}>
      <summary>${status}<code>${e(c.claim)}</code>${where}</summary>
      <p class="meta">${detail}</p>${history}${last?.outputTail ? `<pre tabindex="0">${e(last.outputTail)}</pre>` : ""}</details>`;
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
  // A review by someone no longer authorised to review stays on the record,
  // but marked as not counted, as the gate does not count it. A post-merge
  // review of the landed head (t396) audits the merge and is shown beside them.
  const reviewBinding = bindingOf(item);
  const counting = new Set(countingReviews(d.reviews, reviewBinding, d.policy, d.ownerActor ?? DEFAULT_OWNER));
  const landedHead = landingOf(item, d.events.toReversed())?.commit ?? null;
  const current = latestReviews(d.reviews, reviewBinding);
  const shownReviews = [...current, ...(typeof landedHead === "string" && landedHead !== item.head ? latestReviews(d.reviews, { ...reviewBinding, head: landedHead }) : [])];
  const notCounted = (r: Review) => current.includes(r) && !counting.has(r);
  const reviews = shownReviews.map((r) => `<div class="review-note">${tag(r.approve ? "Approved" : "Changes requested", r.approve ? "go" : "ask")}${notCounted(r) ? ` ${tag("Not counted")}` : ""}
    <p>${e(r.note || "No note provided.")}</p>${r.findings?.length ? `<ul>${r.findings.map((f) => `<li>${e(f.severity)} · ${e(f.file)}${f.line === null ? "" : `:${f.line}`} — ${e(f.text)}</li>`).join("")}</ul>` : ""}<p class="meta">${notCounted(r) ? "not counted: the reviewer is no longer authorised to review this project · " : ""}${r.postMerge ? "post-merge review · " : ""}${r.tier ? "tier review · " : r.topTier ? "gate review, top tier · " : ""}${e(r.by)} · ${when(r.at)}${recordedText(r, d.ownerActor ?? DEFAULT_OWNER) ? ` · ${e(recordedText(r, d.ownerActor ?? DEFAULT_OWNER)!)}` : ""}</p></div>`).join("");
  // The newest pre-review (t524): evidence beside the gate, never a review
  // of it, so it is drawn apart, with its binding, reviewer, findings and
  // recovery action, and the fence a blocking one left on the landing.
  const pre = d.prereviews?.[0], fence = d.prereviewFence ?? null;
  const prereview = pre || fence
    ? `<div class="review-note">${tag(fence ? "Pre-review blocked the landing" : "Pre-review", fence || pre?.state === "blocked" ? "ask" : undefined)}
    ${pre ? `<ul>${prereviewLines(pre).map((l) => `<li>${e(l.trim())}</li>`).join("")}</ul>` : ""}${fence ? `<p>${e(fenceText(item.id, fence))}</p>` : ""}
    <p class="meta">Pre-review evidence: it neither satisfies nor rejects the gate.</p></div>`
    : "";
  const overridden = overrideAt(item, d.ownerActor ?? DEFAULT_OWNER);
  // An override recorded before the project forbade overrides (t371) counts
  // for nothing on a task still in hand, as gate counts none; a merged task's
  // went in on it, and keeps its label.
  const voided = !!overridden && !!d.policy.noOverride && item.state !== "merged";
  const overrideEvent = overridden ? d.events.filter((v) => v.kind === "review.overridden" && str(v.data.head) === overridden.head).sort((a, b) => a.seq - b.seq).at(-1) : undefined;
  const overrideNote = overridden
    ? `<div class="review-note">${tag(voided ? "Override not counted" : "Review overridden", "ask")}
    <p>${e(overridden.reason)}</p><p class="meta">${e(overridden.by)} · ${when(overridden.at)} · the project owner's override, not a review${voided ? "; this project now forbids overrides, so the change waits for its independent review" : ""}</p>${overrideEvent ? `<p class="meta">${e(availabilityText(overrideEvent.data.availability))}</p>` : ""}</div>`
    : "";
  const blockers = live && !gate.ready
    ? `<details class="disclosure"><summary>Readiness details</summary><ul>${gate.blockers.map((b) => `<li>${e(b)}</li>`).join("")}</ul></details>`
    : "";

  return `${header}
${defectOrigin}${framing}${thread ? threadBlock(p, d) : ""}${briefBlock(d)}
<nav class="review-nav" aria-label="In this review"><a href="#changes">Changes</a><a href="#checks">Checks</a><a href="#history">History</a>${item.fork ? `<a href="${href("p", p.name, item.id, "code")}">Browse the fork</a><a href="${href("p", p.name, item.id, "log")}">Its log</a>` : ""}</nav>
<section id="changes" class="review-section"><h3>Changes</h3>${renderDiff(diff, item.head, mergedChecks)}${scope}${protectedNote}</section>
<section id="checks" class="review-section"><h3>Checks and reviews</h3>
  <p class="meta">${view.checks.length ? `${decision.passed} of ${view.checks.length} required checks passed at this revision.` : view.notApplicable.length ? "No required check applies to this revision." : "This project requires no checks."}${view.checks.length && view.notApplicable.length ? ` ${view.notApplicable.length} more ${view.notApplicable.length === 1 ? "does" : "do"} not apply to it.` : ""}${d.policy.sandboxOnly ? " Only checks run in a Cloudflare container count for this project." : ""}</p>
  ${notices}
  ${checkRows}${notApplicableRows}${reports}${reviews}${prereview}${overrideNote}${blockers}
  ${item.state === "merged" ? d.events.filter((ev) => ev.kind === "item.defect" && ev.data.mergeCommit && typeof ev.data.foundIn === "string").map((ev) => `<p>Post-merge defect: <a href="${href("p", p.name, String(ev.data.foundIn))}">${e(String(ev.data.foundIn))}</a></p>`).join("") : ""}
  ${fastLandingBlock(p, d)}${fastReadyBlock(d)}
</section>
${submissionRounds(d)}
<details class="disclosure" id="history"><summary>Task history</summary>${eventTable(d.events)}</details>
<details class="disclosure"><summary>Technical details${live ? " and ownership" : ""}</summary>${technical}${ownership}${close}</details>`;
}

// The error page keeps the owner's name and the rail, and highlights nothing:
// it does not know which page failed (finding 18). `back` says where Go back
// returns to; an empty `back` leaves the advice and the button out, for a
// refusal that has no page to go back to (the Access 401). The public error
// paths pass no ownerName, so the name never reaches a page anyone can read.
export function renderError(message: string, back = "/home", ownerName: string | null = null, active = ""): string {
  return page("Action needs attention", `<section class="page-width error-page">
  <h1>Let’s resolve this.</h1><p class="lead" role="alert">${e(message)}</p>
  ${back ? `<p>Go back, refresh the evidence, and try the available action again.</p>
  <a class="button" href="${e(back)}">Go back</a>` : ""}
</section>`, active, ownerName);
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
  if (diff.merged) return renderMergedDiff(diff, diff.merged);
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

// A merged task's change as it landed (mergedDiff in src/diff.ts): main has
// moved on since, so there is no comparison with today's main, no merge
// preview and no conflict warning (t321).
function renderMergedDiff(diff: ItemDiff, m: Landed): string {
  const against = m.from === "first-parent"
    ? `its first parent <span class="mono">${short(diff.base)}</span>`
    : `the task's fork point <span class="mono">${short(diff.base)}</span>`;
  if (!diff.files.length) return `<p class="empty">Merged at <span class="mono">${short(m.commit)}</span>, which holds the same tree as ${against}.</p>`;
  const added = diff.files.reduce((n, f) => n + f.added, 0);
  const removed = diff.files.reduce((n, f) => n + f.removed, 0);
  const summary = `${tag("Merged", "go")} ${diff.files.length}${diff.truncated ? "+" : ""} file${diff.files.length === 1 ? "" : "s"} changed by the merge <span class="mono">${short(m.commit)}</span> against ${against}, +${added} −${removed}.`;
  return `<p class="meta">${summary}${diff.truncated ? " Only the first files are listed." : ""}</p>
${diff.files.map((f) => renderFile(f, diff.files.length <= 8)).join("")}`;
}

// Whether the task would merge into main as main is now, with the checks run
// on that merge beside it. Read only; the merge itself is still made by
// atelier merge.
export function renderMainPreview(m: MainPreview | null | undefined, merged?: MergedCheckView): string {
  if (m === undefined) return "";
  if (m === null) return `<p class="meta">Whether this merges cleanly into main could not be read just now.</p>`;
  const plural = (n: number, w: string) => `${n.toLocaleString("en")} ${w}${n === 1 ? "" : "s"}`;
  if (m.ahead === 0) return `<p class="merge-preview">${tag("Up to date")} Main has not moved since this task forked; it merges as it is.</p>${renderMergedChecks(merged, m, false)}`;
  const moved = `Main has moved ${m.aheadCapped ? "at least " : ""}${plural(m.ahead, "commit")} along its first-parent line since this task forked (a merge counts once), changing ${plural(m.merge.ours, "path")}`;
  // Declared generated outputs (bin/merge-manifest.json, t463) are never
  // conflicts: the merge pipeline regenerates them once the sources merge.
  const regenerable = m.merge.regenerable ?? [];
  const regen = regenerable.length ? `<p class="meta">Regenerated by the merge, not conflicts${m.merge.generators?.length ? ` (${e(m.merge.generators.join(", "))})` : ""}: ${regenerable.map((p) => `<code>${e(p)}</code>`).join(", ")}.</p>` : "";
  if (m.merge.clean) {
    const shared = m.merge.both.length ? `; both sides changed ${plural(m.merge.both.length, "path")}, and the changes do not overlap` : "; none of them are paths this task changed";
    const body = `${tag("Merges cleanly")} ${moved}${shared}.`;
    return `${regen ? `<div class="merge-preview"><p>${body}</p>${regen}</div>` : `<p class="merge-preview">${body}</p>`}${renderMergedChecks(merged, m, true)}`;
  }
  const rows = m.merge.conflicts.map((c) => `<li><code>${e(c.path)}</code> <span class="meta">${e(c.reason)}</span></li>`).join("");
  return `<div class="merge-preview">${tag(plural(m.merge.conflicts.length, "conflict"), "bad")} ${moved}. Merging now would stop at:<ul class="merge-conflicts">${rows}</ul><p class="meta">Bring main into the task's workspace and resolve these before accepting.</p>${regen}</div>${renderMergedChecks(merged, m, false)}`;
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
