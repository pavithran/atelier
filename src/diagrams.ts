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
