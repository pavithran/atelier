// The public How it works page, rendered by the Worker. It reads no project and
// no setting, so it is the same for every visitor. Content is in src/how-data.ts;
// the command reference is drawn from src/usage.ts, which the CLI prints from.

import how from "./how.css";
import { ORCHESTRATOR, LIMITS, LOOP, LOOP_CAPTION, LOOP_LABEL, LOOP_RETURN, RULES, TERMS, type Lane } from "./how-data.ts";
import { HELP_GROUPS, guideText } from "./usage.ts";
import { REPO_URL, escapeText as e, publicPage } from "./ui";

// Escape, then turn `code` spans into <code>.
const md = (s: string) => e(s).replace(/`([^`]+)`/g, "<code>$1</code>");
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// ── the diagram ────────────────────────────────────────────────────────────
// Inline SVG, drawn here and not by a script. Text is currentColor or a site
// token through the classes in how.css, so it follows light and dark.

const W = 980, X0 = 96, CW = 124, NW = 100, NH = 44;
const LANES: { key: Lane | "atelier"; label: string[]; y: number; h: number }[] = [
  { key: "owner", label: ["Owner"], y: 36, h: 68 },
  { key: "agent", label: ["Agent"], y: 108, h: 68 },
  { key: "reviewer", label: ["Reviewer"], y: 180, h: 68 },
  { key: "atelier", label: ["Atelier", "records"], y: 268, h: 96 },
];
const H = 380;
const cx = (i: number) => X0 + CW * i + CW / 2;
const cyOf = (lane: Lane) => { const l = LANES.find((x) => x.key === lane)!; return l.y + l.h / 2; };

function diagram(): string {
  const parts: string[] = [];
  for (const l of LANES) {
    parts.push(`<rect class="hw-lane${l.key === "atelier" ? " hw-lane-rec" : ""}" x="4" y="${l.y}" width="${W - 8}" height="${l.h}" rx="6"/>`);
    const mid = l.y + l.h / 2, lines = l.label.length;
    parts.push(`<text class="hw-lane-label" x="14" y="${mid + 4 - (lines - 1) * 7}">${l.label.map((t, i) => `<tspan x="14" dy="${i ? 14 : 0}">${e(t)}</tspan>`).join("")}</text>`);
  }
  // The order of the steps: right edge to left edge, with an elbow between lanes.
  LOOP.slice(0, -1).forEach((s, i) => {
    const next = LOOP[i + 1], y1 = cyOf(s.lane), y2 = cyOf(next.lane), xa = cx(i) + NW / 2, xb = cx(i + 1) - NW / 2, xm = (xa + xb) / 2;
    parts.push(`<path class="hw-flow" d="M${xa} ${y1}${y1 === y2 ? "" : `H${xm}V${y2}`}H${xb}" marker-end="url(#hw-arrow-flow)"/>`);
  });
  // A push after step 4 returns to it: from the acceptance step to the checks.
  const accept = LOOP.findIndex((s) => s.name === "Accept"), checks = LOOP.findIndex((s) => s.name === "Checks");
  const top = 22;
  parts.push(`<path class="hw-return" d="M${cx(accept)} ${cyOf(LOOP[accept].lane) - NH / 2}V${top}H${cx(checks)}V${cyOf(LOOP[checks].lane) - NH / 2 - 2}" marker-end="url(#hw-arrow-return)"/>`);
  parts.push(`<text class="hw-note" x="${(cx(accept) + cx(checks)) / 2}" y="${top - 7}" text-anchor="middle">${e(LOOP_RETURN)}</text>`);
  LOOP.forEach((s, i) => {
    const x = cx(i), cy = cyOf(s.lane), lane = s.lane === "owner" ? " hw-owner" : "";
    parts.push(`<line class="hw-drop" x1="${x}" y1="${cy + NH / 2}" x2="${x}" y2="${276 - 2}" marker-end="url(#hw-arrow)"/>`);
    parts.push(`<text class="hw-move" x="${x - 8}" y="262" text-anchor="end">${e(s.moves)}</text>`);
    parts.push(`<rect class="hw-node${lane}${s.conditional ? " hw-cond" : ""}" x="${x - NW / 2}" y="${cy - NH / 2}" width="${NW}" height="${NH}" rx="6"/>`);
    parts.push(`<text class="hw-name" x="${x}" y="${cy - 3}" text-anchor="middle">${i + 1} ${e(s.name)}</text>`);
    parts.push(`<text class="hw-cmd" x="${x}" y="${cy + 13}" text-anchor="middle">${e(s.command)}</text>`);
    parts.push(`<rect class="hw-rec" x="${x - 56}" y="276" width="112" height="80" rx="6"/>`);
    parts.push(`<text class="hw-recs" text-anchor="middle">${s.records.map((t, j) => `<tspan x="${x}" y="${296 + j * 14}">${e(t)}</tspan>`).join("")}</text>`);
  });
  const arrow = (id: string, cls: string) => `<marker id="${id}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path class="${cls}" d="M0 0L8 4L0 8z"/></marker>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${e(LOOP_LABEL)}" xmlns="http://www.w3.org/2000/svg">
<defs>${arrow("hw-arrow", "hw-head")}${arrow("hw-arrow-flow", "hw-head hw-head-flow")}${arrow("hw-arrow-return", "hw-head hw-head-return")}</defs>
${parts.join("\n")}
</svg>`;
}

// ── sections ───────────────────────────────────────────────────────────────

const section = ([heading, body]: [string, string]) => `<section id="${slug(heading)}" class="how-section"><h2>${e(heading)}</h2>${body}</section>`;

const terms = (): string => `<dl class="how-terms">${TERMS.map((t) => `<div><dt>${e(t.term)}</dt><dd>${md(t.meaning)}</dd></div>`).join("")}</dl>`;

function loop(): string {
  return `
<p>A task goes through seven steps. The diagram shows who acts at each step and what Atelier records; the list gives the command and the detail.</p>
<figure class="how-fig"><div class="scroll">${diagram()}</div><figcaption>${e(LOOP_CAPTION)}</figcaption></figure>
<ol class="how-steps">${LOOP.map((s) => `<li><h3>${e(s.name)}</h3><p>${md(s.detail)}</p></li>`).join("")}</ol>`;
}

// "`a` and `b` in `src/x.ts`; `c` in `src/y.ts`", in the order the rule lists them.
function enforcedIn(where: { file: string; symbol: string }[]): string {
  const byFile = new Map<string, string[]>();
  for (const w of where) byFile.set(w.file, [...(byFile.get(w.file) ?? []), w.symbol]);
  const list = (names: string[]) => { const code = names.map((n) => `<code>${e(n)}</code>`); return code.length < 2 ? code.join("") : `${code.slice(0, -1).join(", ")} and ${code.at(-1)}`; };
  return [...byFile].map(([file, symbols]) => `${list(symbols)} in <code>${e(file)}</code>`).join("; ");
}

function rules(): string {
  return `
<p>Each rule is enforced by code, which it names, and each says why it exists.</p>
<ol class="how-rules">${RULES.map((r) => `<li><h3>${e(r.title)}</h3><p>${md(r.enforced)}</p><p class="how-why"><strong>Why.</strong> ${md(r.why)}</p><p class="how-where">Enforced in ${enforcedIn(r.where)}.</p></li>`).join("")}</ol>
<h3 class="how-sub">Limits of enforcement</h3>
<ul class="how-limits">${LIMITS.map((t) => `<li>${md(t)}</li>`).join("")}</ul>`;
}

function orchestrator(): string {
  return `
<p>The orchestrator turns a goal into work: a planner proposes a plan of parts, the owner approves it once, and Atelier then dispatches the parts, routes each to a model, reviews it and integrates the results. <code>docs/orchestrator.md</code> holds the design and its build sequence, and the list below says which parts are built. The plan code in <code>src/plans</code> runs in the project's ledger: a plan's proposals, its approval and the tick that dispatches its parts. The review code in <code>src/review</code> is pure functions with tests, and nothing else calls it yet. <code>atelier plan</code> starts a plan and takes the owner's decisions on it. A runner that offers plan jobs takes the plan job, and each part's runner is given the brief the server wrote for it; a planner may still post a plan by hand. Outside plans the owner sends each task to a runner by hand: <code>atelier dispatch</code> queues it, and <code>atelier runner</code> claims it and works it.</p>
<ul class="how-status">${ORCHESTRATOR.map((p) => `<li><span class="tag ${p.built ? "go" : "ask"}">${p.built ? "Built" : "Not built yet"}</span><div><h3>${e(p.name)} <span class="meta">${e(p.stage)}</span></h3><p>${md(p.what)}</p></div></li>`).join("")}</ul>`;
}

// The command reference is most of the page's bytes, so each group arrives
// closed in a details element: the page opens at its explanation, and a
// reader opens the group they need.
function commands(): string {
  const groups = HELP_GROUPS.map((g) => `<details class="how-group"><summary>${e(g.name)}</summary><dl class="how-cmds">${g.lines.flat().map((c) => `<div class="how-cmd"><dt><code>atelier ${e(c.form)}</code></dt><dd>${md(c.about)}</dd></div>`).join("")}</dl></details>`).join("");
  return `
<p>Every command the CLI's help lists, in its groups and order, each group closed until opened. The list is drawn from <code>src/usage.ts</code>, the table <code>atelier help</code> prints from, so the two cannot differ. <code>H/M</code> stands for harness/model, such as <code>claude-code/opus-5.5</code>. Square brackets mark what is optional, a bar separates alternatives, and <code>...</code> marks a flag that may repeat.</p>
${groups}
<h3 class="how-sub">Agent instructions</h3>
<details class="disclosure"><summary>The text <code>atelier guide</code> prints</summary><pre>${e(guideText())}</pre></details>`;
}

export function renderHow(): string {
  const sections: [string, string][] = [["Terms", terms()], ["The loop", loop()], ["Rules", rules()], ["The orchestrator", orchestrator()], ["Commands", commands()]];
  return publicPage({
    title: "How it works · Atelier",
    description: "What Atelier is, the loop from task to merge, the rules it enforces and why, which parts of the orchestrator are built, and every command.",
    brand: "/",
    nav: [["Source on GitHub", REPO_URL], ["Sign in", "/login"]],
    mainClass: "page-width how",
    css: how,
    main: `
<header class="how-hero">
  <span class="kicker">How it works · public · reads no project data</span>
  <h1>How Atelier works</h1>
  <p class="lead">Atelier is a Git platform for several coding agents working on one project at the same time. Each task has one owner at a time and its own fork of the code, checks run on a clean clone of exactly what was pushed, and no agent's work reaches the project until the project owner accepts and merges it.</p>
  <p class="lead">It runs on Cloudflare Workers, Durable Objects and Artifacts. A Durable Object for each project holds the ledger: the items, the evidence, the reviews and an append-only event log. Artifacts holds the repositories. Agents and the owner work through one command, <code>atelier</code>, which needs only Node and git; the owner also has a web inbox that ranks what needs a decision.</p>
  <nav class="how-toc" aria-label="On this page">${sections.map(([h]) => `<a href="#${slug(h)}">${e(h)}</a>`).join("")}</nav>
</header>
${sections.map(section).join("")}
`,
  });
}
