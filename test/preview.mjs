// Read-only visual fixtures for design review: no Artifacts, tokens or live
// project actions. Run `node test/preview.mjs` and open the printed address.
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";

const dir = mkdtempSync(join(tmpdir(), "atelier-preview-"));
await build({ entryPoints: ["src/ui.ts", "src/floor.ts"], bundle: true, platform: "node", format: "esm", loader: { ".css": "text" }, outdir: dir });
const ui = await import(pathToFileURL(join(dir, "ui.js")));
const { buildFloor } = await import(pathToFileURL(join(dir, "floor.js")));

// Fixed revisions that look like real ones, so screenshots never show placeholders.
const HEAD = "9621fac2436196a267f96ec81225c2cc3181512d";
const BASE = "049ebcc0b7f2e41d9c5a1e8f3d62b7a90c4e5f13";
const now = new Date("2026-10-04T09:30:00Z");
const at = (minAgo) => new Date(now.getTime() - minAgo * 60_000).toISOString();

const policy = { checks: ["npm ci && npm test", "npm run types && npm run typecheck"], protected: ["src/rules.ts", "src/ledger.ts", "src/index.ts"], sandboxOnly: true };
const project = { name: "cloudflare-git", repo: "cloudflare-git", policy, createdAt: at(900) };
const make = (id, title, state, owner, head = HEAD) => ({
  id, title, state, scope: ["src/**"], owner, fork: `cloudflare-git--${id}`, base: BASE, head,
  acceptedHead: state === "accepted" || state === "merged" ? head : null, lastPushAt: at(4), updatedAt: at(4), createdAt: at(300),
});
const items = [
  make("t1", "Run checks in a Cloudflare container", "submitted", "claude-code/opus-5.5"),
  make("t4", "Test the ledger end to end", "submitted", "zcode/glm-5.3", "8c44da71e2b04f3a9d6c1e7f5a3b2c1d0e9f8a7b"),
  make("t2", "Record pushes from Artifacts events", "claimed", "codex/gpt-6", "78554465c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6"),
];
let seq = 0;
const ev = (minAgo, actor, kind, data, itemId) => ({ seq: ++seq, itemId, at: at(minAgo), actor, kind, data });
const events = [
  ev(170, "codex/gpt-5.5", "item.claimed", {}, "t2"),
  ev(150, "codex/gpt-5.5", "push.observed", { head: "1a2b3c4d" }, "t2"),
  ev(120, "pavi", "item.handoff", { from: "codex/gpt-5.5", to: "codex/gpt-6" }, "t2"),
  ev(112, "codex/gpt-6", "item.claimed", {}, "t2"),
  ev(60, "codex/gpt-6", "push.observed", { head: "5e6f7a8b" }, "t2"),
  ev(58, "codex/gpt-6", "evidence.observed", { claim: "npm ci && npm test", passed: false }, "t2"),
  ev(31, "codex/gpt-6", "push.observed", { head: "78554465" }, "t2"),
  ev(29, "codex/gpt-6", "evidence.observed", { claim: "npm ci && npm test", passed: true }, "t2"),
  ev(9, "codex/gpt-6", "evidence.reported", { claim: "Tried a live push event" }, "t2"),
  ev(140, "zcode/glm-5.3", "item.claimed", {}, "t4"),
  ev(95, "zcode/glm-5.3", "push.observed", { head: "8c44da71" }, "t4"),
  ev(93, "atelier/sandbox", "evidence.observed", { claim: "npm ci && npm test", passed: true, where: "sandbox" }, "t4"),
  ev(92, "atelier/sandbox", "evidence.observed", { claim: "npm run types && npm run typecheck", passed: true, where: "sandbox" }, "t4"),
  ev(90, "zcode/glm-5.3", "item.submitted", {}, "t4"),
  ev(70, "claude-code/opus-5.5", "review.approved", { note: "Covers the ledger" }, "t4"),
  ev(130, "claude-code/opus-5.5", "item.claimed", {}, "t1"),
  ev(80, "claude-code/opus-5.5", "push.observed", { head: "72701920" }, "t1"),
  ev(45, "claude-code/opus-5.5", "push.observed", { head: "9621fac2" }, "t1"),
  ev(43, "atelier/sandbox", "evidence.observed", { claim: "npm ci && npm test", passed: true, where: "sandbox" }, "t1"),
  ev(42, "atelier/sandbox", "evidence.observed", { claim: "npm run types && npm run typecheck", passed: true, where: "sandbox" }, "t1"),
  ev(40, "claude-code/opus-5.5", "item.submitted", {}, "t1"),
];
const floor = buildFloor([{ project, items, events }], now);

const sandbox = (claim, head = HEAD) => ({ itemId: "t1", claim, grade: "observed", head, passed: true, by: "atelier/sandbox", where: "sandbox", at: at(42), changedPaths: ["src/sandbox/runner.ts", "src/rules.ts"], outputTail: "ℹ tests 34\nℹ pass 34\nℹ fail 0\n[atelier] ran in a Cloudflare container in 21s, exit 0" });
const detail = {
  item: items[0], policy, ownerActor: "pavi", reviews: [], events: events.filter((x) => x.itemId === "t1").reverse(),
  evidence: policy.checks.map((c) => sandbox(c)),
  gate: { ready: false, blockers: ["touches a protected path; needs approval from a different model or the project owner"], outOfScope: [], needsAssessor: true },
};
const diff = { base: BASE, head: HEAD, truncated: false, files: [
  { path: "src/sandbox/runner.ts", status: "added", added: 6, removed: 0, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 6, lines: [
    { op: "+", text: "// Runs a project's required checks in a Cloudflare container." },
    { op: "+", text: "export class CheckRunner extends DurableObject<Env> {" },
    { op: "+", text: "  async start(request: RunRequest): Promise<RunState> {" },
    { op: "+", text: "    await this.ctx.storage.setAlarm(Date.now());" },
    { op: "+", text: "  }" },
    { op: "+", text: "}" }] }] },
  { path: "src/rules.ts", status: "modified", added: 2, removed: 1, hunks: [{ oldStart: 181, oldLines: 3, newStart: 181, newLines: 4, lines: [
    { op: " ", text: "  const atHead = head ? evidence.filter((e) => e.head === head) : [];" },
    { op: "-", text: "  const counts = (e: Evidence) => e.grade === \"observed\";" },
    { op: "+", text: "  // Under sandboxOnly, a check run on someone's machine is shown but does not count." },
    { op: "+", text: "  const counts = (e: Evidence) => e.grade === \"observed\" && (!policy.sandboxOnly || e.where === \"sandbox\");" },
    { op: " ", text: "  const latest = (claim: string) =>" }] }] },
] };
const entries = [
  { project: project.name, itemId: "t1", title: items[0].title, kind: "assess", reason: "Review required", weight: 80 },
  { project: project.name, itemId: "t4", title: items[1].title, kind: "accept", reason: "Ready to accept", weight: 100 },
];

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const state = url.searchParams.get("state");
  const d = structuredClone(detail);
  if (url.searchParams.get("task") === "t4") { d.item = items[1]; d.gate = { ...d.gate, ready: true, needsAssessor: false, blockers: [] }; }
  if (state === "local" || state === "local-strict") d.evidence.forEach((x) => { delete x.where; x.by = "codex/gpt-6"; });
  if (state === "local") d.policy = { ...policy, sandboxOnly: false };
  if (state === "failed") { d.evidence[0].passed = false; d.gate.needsAssessor = false; }
  if (state === "ready") d.gate = { ...d.gate, ready: true, needsAssessor: false, blockers: [] };
  if (state === "accepted" || state === "merged") { d.item.state = state; d.item.acceptedHead = HEAD; d.gate.needsAssessor = false; }
  if (state === "long") d.item.title = "Review a project with a very long title, extensive agent output, and deeply nested files that must remain readable on a phone";
  let html;
  if (url.pathname === "/login") html = ui.renderLogin();
  else if (url.pathname === "/studio") html = ui.renderStudio(state === "empty" ? { benches: [], from: floor.from, to: floor.to } : floor, "PAVI", now);
  else if (url.pathname === "/projects") html = ui.renderProjects([{ project, items }], "PAVI");
  else if (url.pathname === "/history") html = ui.renderHistory([{ project, items: [make("t5", "Add guarded cache cleanup", "merged", null)] }], "PAVI");
  else if (url.pathname === "/p/cloudflare-git") html = ui.renderProject(project, items, events.slice(-8).reverse(), "PAVI");
  else if (url.pathname.startsWith("/p/")) html = ui.renderItem(project, d, "PAVI", state === "unavailable" ? "unavailable" : diff);
  else if (url.pathname === "/error") html = ui.renderError("This task changed since you opened it. Refresh and review the new revision.");
  else html = ui.renderInbox(state === "empty" ? [] : entries, [project], "PAVI", state === "empty" ? undefined : { project, detail: d, diff }, [{ project, items }], state === "empty" ? undefined : floor, now);
  html = html.replace('<meta http-equiv="refresh" content="15">', "");
  res.writeHead(req.method === "GET" ? 200 : 405, { "content-type": "text/html" });
  res.end(req.method === "GET" ? html : "Read-only preview; no live action was taken.");
});
server.listen(Number(process.env.PORT || 0), "127.0.0.1", () => console.log(`http://127.0.0.1:${server.address().port}`));
