// Where Atelier runs, layer by layer: who acts, the owner's Mac, the agents,
// their model providers, and Cloudflare. Inline SVG drawn here, not by a
// script; every colour is a site token through the lay-* classes in
// layout.css, so it follows light and dark. Shown on /how and the showcase.

// Its own escape, so ui.ts can import this module without a cycle.
const e = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const W = 1000, H = 620, NH = 44;

interface Node { x: number; y: number; w: number; name: string; sub: string; cloud?: boolean }

// Bands, top to bottom, with the label in the left column.
const BANDS: { label: string; y: number; h: number; cloud?: boolean }[] = [
  { label: "Who acts", y: 16, h: 76 },
  { label: "Your Mac", y: 104, h: 152 },
  { label: "Agents", y: 268, h: 76 },
  { label: "Model providers", y: 356, h: 76 },
  { label: "Cloudflare", y: 444, h: 160, cloud: true },
];

// Four columns share one grid, so a column's arrows run straight down.
const COL = [160, 366, 572, 778], CW = 180;
const mid = (x: number, w = CW) => x + w / 2;

const NODES: Node[] = [
  { x: COL[0], y: 32, w: CW, name: "Browser", sub: "atelier.zone pages" },
  { x: COL[1], y: 32, w: CW, name: "Terminal", sub: "the owner runs atelier" },
  { x: COL[2], y: 32, w: CW, name: "Orchestrator", sub: "a session; starts agents" },
  { x: COL[3], y: 32, w: CW, name: "Home runner", sub: "takes jobs; starts agents" },
  { x: COL[1], y: 118, w: COL[3] + CW - COL[1], name: "atelier CLI, in the checkout and in each workspace", sub: "the one path to Cloudflare; runs checks in a fresh clone of the pushed head" },
  { x: 512, y: 196, w: 300, name: "Workspaces", sub: "one per task: a clone of its fork" },
  { x: COL[0], y: 284, w: CW, name: "opencode", sub: "GLM, DeepSeek, OpenRouter" },
  { x: COL[1], y: 284, w: CW, name: "Antigravity", sub: "Gemini, GPT-OSS" },
  { x: COL[2], y: 284, w: CW, name: "Codex", sub: "gpt-6-astra" },
  { x: COL[3], y: 284, w: CW, name: "Claude Code", sub: "Opus, Sonnet, Fable" },
  { x: COL[0], y: 372, w: CW, name: "Z.ai, DeepSeek", sub: "and OpenRouter" },
  { x: COL[1], y: 372, w: CW, name: "Google", sub: "Gemini plan" },
  { x: COL[2], y: 372, w: CW, name: "OpenAI", sub: "Codex plan" },
  { x: COL[3], y: 372, w: CW, name: "Anthropic", sub: "Claude plan" },
  { x: 512, y: 460, w: 300, name: "Worker at atelier.zone", sub: "the pages, the API and the gate", cloud: true },
  { x: COL[1], y: 540, w: CW, name: "Durable Objects", sub: "a Ledger per project", cloud: true },
  { x: COL[2], y: 540, w: CW, name: "Check container", sub: "with --sandbox; internet off", cloud: true },
  { x: COL[3], y: 540, w: CW, name: "Artifacts", sub: "the baseline and task forks", cloud: true },
];

// Connectors: [path, kind]. A flow is the main direction of work; a rail
// carries a request across the layers between.
const FLOWS: string[] = [
  // Each driver acts through the CLI.
  ...[1, 2, 3].map((i) => `M${mid(COL[i])} ${32 + NH}V${118 - 2}`),
  // The CLI makes the workspace a task is built in.
  `M662 ${118 + NH}V${196 - 2}`,
  // Each agent calls its own provider.
  ...COL.map((x) => `M${mid(x)} ${284 + NH}V${372 - 2}`),
  // Inside Cloudflare: the Worker writes the Ledger and, with --sandbox,
  // starts a check container, which is given the task's exact tree from
  // Artifacts.
  `M620 ${460 + NH}V522H${mid(COL[1])}V${540 - 2}`,
  `M662 ${460 + NH}V${540 - 2}`,
  `M${COL[3]} 562H${COL[2] + CW + 2}`,
  // The Worker makes each task's fork and mints its scoped Git token.
  `M760 ${460 + NH}V522H${mid(COL[3])}V${540 - 2}`,
];
const RAILS: string[] = [
  // The browser reaches the Worker directly.
  `M${COL[0]} 54H146V482H${512 - 2}`,
  // The CLI's API calls reach the Worker.
  `M${COL[3] + CW} 150H972V482H${812 + 2}`,
  // The CLI's git pushes reach Artifacts.
  `M${COL[3] + CW} 130H988V562H${COL[3] + CW + 2}`,
];

export const LAYERS_LABEL = "Where Atelier runs, in five layers. The owner works through a browser and the terminal, and an orchestrating session or a home runner can act for them; all three act through the atelier CLI, which makes one workspace per task, a clone of the task's fork. An agent works in its own workspace and calls its own model provider. The CLI is the one path to Cloudflare: its API calls reach the Worker and its git pushes reach Artifacts, and the browser reaches the Worker directly. The Worker keeps each project's Ledger in a Durable Object, makes each task's fork in Artifacts, and with --sandbox runs checks in a container with the internet off.";

export const LAYERS_CAPTION = "Dashed lines cross the layers: the browser reaches the Worker, and the CLI's API calls reach the Worker and its git pushes reach Artifacts. An agent reaches Cloudflare only through the CLI, with a token bound to it whose Git write access covers its own task's fork alone; the session or runner that started it may push and check for it instead. Checks run in a fresh clone of exactly the pushed head, on the machine that asks for them, or with --sandbox in a Cloudflare container. Either way the result is recorded against that head, and the Worker's gate reads it.";

export function layersDiagram(): string {
  const p: string[] = [];
  for (const b of BANDS) {
    p.push(`<rect class="lay-band${b.cloud ? " lay-band-cloud" : ""}" x="4" y="${b.y}" width="${W - 8}" height="${b.h}" rx="6"/>`);
    p.push(`<text class="lay-label" x="14" y="${b.y + 22}">${e(b.label)}</text>`);
  }
  for (const d of FLOWS) p.push(`<path class="lay-flow" d="${d}" marker-end="url(#lay-arrow)"/>`);
  // Every agent works in a workspace: one bracket from the agents to it.
  p.push(`<path class="lay-flow" d="${COL.map((x) => `M${mid(x)} 284V262`).join("")}M${mid(COL[0])} 262H${mid(COL[3])}"/>`);
  p.push(`<path class="lay-flow" d="M662 262V${196 + NH + 2}" marker-end="url(#lay-arrow)"/>`);
  for (const d of RAILS) p.push(`<path class="lay-rail" d="${d}" marker-end="url(#lay-arrow-rail)"/>`);
  for (const n of NODES) {
    p.push(`<rect class="lay-node${n.cloud ? " lay-node-cloud" : ""}" x="${n.x}" y="${n.y}" width="${n.w}" height="${NH}" rx="6"/>`);
    p.push(`<text class="lay-name" x="${mid(n.x, n.w)}" y="${n.y + 18}" text-anchor="middle">${e(n.name)}</text>`);
    p.push(`<text class="lay-sub" x="${mid(n.x, n.w)}" y="${n.y + 34}" text-anchor="middle">${e(n.sub)}</text>`);
  }
  const arrow = (id: string, cls: string) => `<marker id="${id}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path class="${cls}" d="M0 0L8 4L0 8z"/></marker>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${e(LAYERS_LABEL)}" xmlns="http://www.w3.org/2000/svg">
<defs>${arrow("lay-arrow", "lay-head")}${arrow("lay-arrow-rail", "lay-head lay-head-rail")}</defs>
${p.join("\n")}
</svg>`;
}

// The figure as both pages show it: the diagram in a frame that scrolls
// sideways on a narrow screen rather than shrinking its text.
export function layersFigure(): string {
  return `<figure class="lay-fig"><div class="scroll">${layersDiagram()}</div><figcaption>${e(LAYERS_CAPTION)}</figcaption></figure>`;
}

// ── the plan flow ──────────────────────────────────────────────────────────
// One plan's path from the owner's goal to its merge into main, drawn the same
// way: every colour is a site token through the pf-* classes in layout.css.
// The lanes run down the page and time runs top to bottom, so the eleven steps
// keep their text at full size inside a frame that scrolls on a narrow screen.
// Each step is something the code does: the plan job and planner (runPlanTask
// in cli/runner.mjs), approval and routing (routeParts in src/plans/route.ts),
// dispatch once dependencies land (planActions in src/plans/phase.ts), the
// review request (src/review/needed.ts) and runReview, and the integrator
// (runIntegrate in cli/runner.mjs, by the rules in src/plans/integrate.ts).

type FlowLane = "owner" | "runner" | "atelier";

const PF_W = 1000, PF_H = 816, PF_NW = 272, PF_NH = 52, PF_ROW = 68, PF_TOP = 56, PF_LW = 320;

// Three lanes side by side, each with its label at the top.
const PF_LANES: { key: FlowLane; label: string; x: number }[] = [
  { key: "owner", label: "Owner", x: 16 },
  { key: "runner", label: "Home runners and their agents", x: 340 },
  { key: "atelier", label: "Atelier", x: 664 },
];

// The steps, top to bottom. Each has a name and two lines of detail.
export const PLAN_FLOW: { lane: FlowLane; name: string; sub: [string, string] }[] = [
  { lane: "owner", name: "State a goal", sub: ['atelier plan "goal" makes a plan task', "and queues a plan job"] },
  { lane: "runner", name: "Plan", sub: ["a home runner takes the plan job; its", "planner posts a plan document"] },
  { lane: "owner", name: "Approve the plan", sub: ["atelier plan approve, once, by the", "hash of the newest proposal"] },
  { lane: "atelier", name: "Route the parts", sub: ["routeParts names a builder, two alternates", "and a reviewer of another family"] },
  { lane: "atelier", name: "Dispatch build jobs", sub: ["a part goes out once its dependencies", "have landed, two parts live at a time"] },
  { lane: "runner", name: "Build and check", sub: ["the builder works in the part's fork;", "atelier finish pushes, checks, submits"] },
  { lane: "atelier", name: "Request a review", sub: ["checks pass at the head, paths measured;", "routed to another family"] },
  { lane: "runner", name: "Review", sub: ["a review job: runReview gives the brief", "and diff, and posts the verdict"] },
  { lane: "runner", name: "Integrate", sub: ["atelier runner --integrate merges the", "part, runs the plan's checks"] },
  { lane: "runner", name: "Submit the plan", sub: ["the integrator submits the plan task", "once every part is integrated"] },
  { lane: "owner", name: "Accept and merge", sub: ["the owner accepts the plan task and", "merges it into main"] },
];

const laneX = (lane: FlowLane) => PF_LANES.find((l) => l.key === lane)!.x;
const nodeX = (lane: FlowLane) => laneX(lane) + (PF_LW - PF_NW) / 2;
const nodeMid = (lane: FlowLane) => laneX(lane) + PF_LW / 2;
const rowTop = (i: number) => PF_TOP + i * PF_ROW;
const rowMid = (i: number) => rowTop(i) + PF_NH / 2;
const stepAt = (name: string) => PLAN_FLOW.findIndex((s) => s.name === name);

// The returns: a part sent back to its builder, and the tick dispatching the
// parts that depend on one just integrated.
export const PLAN_FLOW_RETURNS = {
  rework: "rejected with blocking findings: rework",
  failed: "conflict or failing checks: rolled back, rework",
  next: "integrated: the parts that depend on it go out",
};

export const PLAN_FLOW_LABEL = "One plan's path from goal to merge, in three lanes: the owner, the home runners and their agents, and Atelier. The owner states a goal with atelier plan, which makes a plan task and queues a plan job. A home runner takes the job and its planner posts a plan document. The owner approves it once by its hash, and Atelier routes each part to a builder, two alternates and a reviewer of another model family. Atelier dispatches each part as a build job once its dependencies have landed. The builder pushes, checks and submits; Atelier requests a review from another family, and a review job on a home runner posts the verdict. A rejection with blocking findings returns the part to its builder. The integrator merges an approved part into the plan's integration branch and runs the plan's checks; a conflict or a failure rolls the branch back and returns the part to its builder, and an integrated part lets the parts that depend on it go out. Once every part is integrated the integrator submits the plan task, and the owner accepts it and merges it into main.";

export const PLAN_FLOW_CAPTION = "The plan flow from goal to merge. The owner acts three times: to state the goal, to approve the plan, and to accept and merge it. Between those, Atelier's tick dispatches build, review and integrate jobs and home runners take them. Dashed lines are returns: a rejection with blocking findings, or a merge that conflicts or whose checks fail, sends the part back to its builder; an integrated part lets the parts that depend on it be dispatched.";

export function planFlowDiagram(): string {
  const p: string[] = [];
  for (const l of PF_LANES) {
    p.push(`<rect class="pf-lane${l.key === "atelier" ? " pf-lane-atelier" : ""}" x="${l.x}" y="8" width="${PF_LW}" height="${PF_H - 16}" rx="6"/>`);
    p.push(`<text class="pf-label" x="${l.x + 12}" y="32">${e(l.label)}</text>`);
  }
  // The order of the steps: straight down within a lane, with an elbow
  // halfway between rows where the next step is in another lane.
  PLAN_FLOW.slice(0, -1).forEach((s, i) => {
    const next = PLAN_FLOW[i + 1], x1 = nodeMid(s.lane), x2 = nodeMid(next.lane), y1 = rowTop(i) + PF_NH, y2 = rowTop(i + 1), ym = (y1 + y2) / 2;
    p.push(`<path class="pf-flow" d="M${x1} ${y1}${x1 === x2 ? "" : `V${ym}H${x2}`}V${y2 - 2}" marker-end="url(#pf-arrow)"/>`);
  });
  // Returns to the builder run down the runner lane's left margin; their
  // labels sit beside them in the owner lane, which is empty at those rows.
  const build = stepAt("Build and check"), review = stepAt("Review"), integrate = stepAt("Integrate"), dispatch = stepAt("Dispatch build jobs");
  const left = nodeX("runner"), right = left + PF_NW;
  p.push(`<path class="pf-return" d="M${left} ${rowMid(review)}H${left - 8}V${rowMid(build) + 8}H${left - 2}" marker-end="url(#pf-arrow-return)"/>`);
  p.push(`<text class="pf-note" x="${laneX("runner") - 6}" y="${rowMid(build + 1) + 4}" text-anchor="end">${e(PLAN_FLOW_RETURNS.rework)}</text>`);
  p.push(`<path class="pf-return" d="M${left} ${rowMid(integrate)}H${left - 18}V${rowMid(build) - 8}H${left - 2}" marker-end="url(#pf-arrow-return)"/>`);
  p.push(`<text class="pf-note" x="${laneX("runner") - 6}" y="${rowMid(integrate) + 4}" text-anchor="end">${e(PLAN_FLOW_RETURNS.failed)}</text>`);
  // The tick runs again on an integration and dispatches the dependants.
  p.push(`<path class="pf-return" d="M${right} ${rowMid(integrate)}H${right + 16}V${rowMid(dispatch)}H${nodeX("atelier") - 2}" marker-end="url(#pf-arrow-return)"/>`);
  p.push(`<text class="pf-note" x="${nodeX("atelier") - 12}" y="${rowMid(integrate) + 4}">${e(PLAN_FLOW_RETURNS.next)}</text>`);
  PLAN_FLOW.forEach((s, i) => {
    const x = nodeX(s.lane), y = rowTop(i), cx = x + PF_NW / 2;
    p.push(`<rect class="pf-node${s.lane === "runner" ? "" : ` pf-${s.lane}`}" x="${x}" y="${y}" width="${PF_NW}" height="${PF_NH}" rx="6"/>`);
    p.push(`<text class="pf-name" x="${cx}" y="${y + 17}" text-anchor="middle">${i + 1} ${e(s.name)}</text>`);
    p.push(`<text class="pf-sub" text-anchor="middle">${s.sub.map((t, j) => `<tspan x="${cx}" y="${y + 32 + j * 13}">${e(t)}</tspan>`).join("")}</text>`);
  });
  const arrow = (id: string, cls: string) => `<marker id="${id}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path class="${cls}" d="M0 0L8 4L0 8z"/></marker>`;
  return `<svg viewBox="0 0 ${PF_W} ${PF_H}" role="img" aria-label="${e(PLAN_FLOW_LABEL)}" xmlns="http://www.w3.org/2000/svg">
<defs>${arrow("pf-arrow", "pf-head")}${arrow("pf-arrow-return", "pf-head pf-head-return")}</defs>
${p.join("\n")}
</svg>`;
}

// The figure as /how shows it, in a frame that scrolls sideways on a narrow
// screen rather than shrinking its text.
export function planFlowFigure(): string {
  return `<figure class="pf-fig"><div class="scroll">${planFlowDiagram()}</div><figcaption>${e(PLAN_FLOW_CAPTION)}</figcaption></figure>`;
}
