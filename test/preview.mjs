// Read-only visual fixtures for design review: no Artifacts, tokens or live
// project actions. Run `node test/preview.mjs` and open the printed address.
// Every page the bar and a project's tabs link to is drawn by its own
// renderer from the illustrative data below, with the bar filled as the
// server fills it (fillShell). `route(url)` answers one address without a
// server; test/preview.test.mjs requests each page from a running preview.
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENTRIES = ["ui", "floor", "how", "attention", "graph", "actions-page", "models/record", "usage/page", "usage/report", "browse/view"];
// The bundles are loaded once, then their folder is removed (t658: it was
// left in the temp folder on every run).
const dir = mkdtempSync(join(tmpdir(), "atelier-preview-"));
const modules = {};
try {
  await build({ entryPoints: ENTRIES.map((x) => join(ROOT, "src", `${x}.ts`)), bundle: true, platform: "node", format: "esm", loader: { ".css": "text" }, outdir: dir, outbase: join(ROOT, "src"), logLevel: "error" });
  for (const x of ENTRIES) modules[x] = await import(pathToFileURL(join(dir, `${x}.js`)));
} finally { rmSync(dir, { recursive: true, force: true }); }
const load = (x) => modules[x];
const ui = load("ui");
const { buildFloor } = load("floor");
const { renderHow } = load("how");
const { attentionFor } = load("attention");
const { buildStory, addTally, emptyTally } = load("graph");
const { renderActions } = load("actions-page");
const { buildRecord } = load("models/record");
const { renderUsage } = load("usage/page");
const { DEFAULT_THRESHOLDS } = load("usage/report");
const browse = load("browse/view");

// Fixed revisions that look like real ones, so screenshots never show placeholders.
const HEAD = "9621fac2436196a267f96ec81225c2cc3181512d";
const BASE = "049ebcc0b7f2e41d9c5a1e8f3d62b7a90c4e5f13";
const now = new Date("2026-10-04T09:30:00Z");
const at = (minAgo) => new Date(now.getTime() - minAgo * 60_000).toISOString();

const policy = { checks: ["npm ci && npm test", "npm run types && npm run typecheck"], protected: ["src/rules.ts", "src/ledger.ts", "src/index.ts"], sandboxOnly: true };
const project = { name: "atelier", repo: "atelier", policy, createdAt: at(900) };
const make = (id, title, state, owner, head = HEAD) => ({
  id, title, state, scope: ["src/**"], owner, fork: `atelier--${id}`, base: BASE, head,
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
  gate: { ready: false, blockers: ["touches a protected path; needs approval from a model of another family than every contributor"], outOfScope: [], needsAssessor: true },
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

const OWNER = "pavi";
const attention = attentionFor(project.name, items, entries, [], now);
const story = buildStory(project.name, items, events, OWNER, false, ui.titleOf(project));

// The pool the Models page lists: the models the fixture's tasks name, with
// their record replayed from the fixture's events.
const added = { addedBy: OWNER, addedAt: at(2000), aliases: [] };
const models = [
  { ...added, id: "opus-5.5", harness: "claude-code", where: "cloud", provider: "subscription", family: "anthropic", note: "", roles: ["build", "review"], tier: "frontier" },
  { ...added, id: "gpt-6", harness: "codex", where: "cloud", provider: "subscription", family: "openai", note: "", roles: ["build"], tier: "frontier" },
  { ...added, id: "glm-5.3", harness: "zcode", where: "home", provider: "ai-studio", family: "zai", note: "Runs on the studio Mac", status: { state: "available", at: at(30), by: "home:studio" } },
];

// What two runners reported for the Usage page.
const span = (requests, tokens, cost) => ({ requests, tokens, cost });
const usage = [
  { tool: "codex", runner: "home:studio", at: at(12), windows: [{ name: "weekly", usedPercent: 46, resetsAt: at(-3 * 24 * 60), at: at(12) }, { name: "5-hour", usedPercent: 18, resetsAt: at(-140), at: at(12) }], models: [], balances: [], notes: [] },
  { tool: "opencode", runner: "home:studio", at: at(12), windows: [], models: [
    { model: "glm-5.3", provider: "ai-studio", spans: { "5h": span(14, 210_000, 0), "24h": span(61, 1_900_000, 0), "7d": span(240, 7_400_000, 0) } },
  ], balances: [], notes: ["glm-5.3 runs locally and records no cost"] },
];

// One plan, still with its planner, for the Plans tab.
const planItem = { ...make("t6", "Plan: run every check in a container", "claimed", "claude-code/opus-5.5"), kind: "plan" };
const plans = [{
  item: planItem, phase: "planning", goal: "Run every required check in a Cloudflare container", scope: ["src/sandbox/**", "src/rules.ts"],
  planner: "claude-code/opus-5.5", plannerReasons: ["the strongest planner in the pool"], blocked: null, completedAt: null,
  proposal: null, plan: null, approval: null, parts: [], preview: null, integration: { integrationHead: null }, harnessFailure: null, pastDeadline: false,
}];

// Tasks the pages link to beyond the board's: the merged task History lists
// and the plan the Plans tab shows.
const merged = make("t5", "Add guarded cache cleanup", "merged", null, "5c0ffee1a2b3c4d5e6f708192a3b4c5d6e7f8091");
const tasks = [...items, merged, planItem];

// A small repository for the Code and Log tabs and each fork's browsing
// (src/browse/view.ts): the same files at every commit, and each fork's
// commits as its pushes name them, on the baseline's.
const FILES = {
  "README.md": "# Atelier\n\nA Git platform for coding agents.\n",
  "package.json": '{\n  "name": "atelier",\n  "type": "module"\n}\n',
  "src/rules.ts": "// The policy, as pure functions.\nexport const DEFAULT_OWNER = \"owner\";\n",
  "src/sandbox/runner.ts": diff.files[0].hunks[0].lines.map((l) => l.text).join("\n") + "\n",
};
const full = (short) => (short + "0123456789abcdef0123456789abcdef01234567").slice(0, 40);
const commitOf = (hash, message, parent, minAgo, author = "pavi thomas") =>
  ({ hash, treeHash: full("7ee"), message, author: { name: author, email: "dev@example.com" }, parents: parent ? [parent] : [], authoredAt: Math.floor((now.getTime() - minAgo * 60_000) / 1000) });
const baseline = [
  commitOf(merged.head, "t5: add guarded cache cleanup\n\nAgent: codex/gpt-6\nCo-Authored-By: GPT-6 <noreply@openai.com>", BASE, 600),
  commitOf(BASE, "Start the ledger", null, 2000),
];
const forkLine = (pushes, author) => {
  const line = [];
  let parent = BASE;
  pushes.forEach(([hash, message], i) => { line.unshift(commitOf(hash, `${message}\n\nAgent: ${author}`, parent, 200 - i * 30, author)); parent = hash; });
  return [...line, baseline[1]];
};
const repos = {
  "": baseline,
  t1: forkLine([[full("72701920"), "t1: a container runs the checks"], [HEAD, "t1: count only sandbox runs under sandboxOnly"]], "claude-code/opus-5.5"),
  t2: forkLine([[full("1a2b3c4d"), "t2: read push events"], [full("5e6f7a8b"), "t2: record each push"], [items[2].head, "t2: fix the failing test"]], "codex/gpt-6"),
  t4: forkLine([[items[1].head, "t4: test the ledger end to end"]], "zcode/glm-5.3"),
  t5: baseline,
  t6: [baseline[1]],
};
function treeAt(path) {
  const prefix = path.length ? path.join("/") + "/" : "";
  const names = new Map();
  for (const file of Object.keys(FILES)) {
    if (!file.startsWith(prefix)) continue;
    const [first, ...more] = file.slice(prefix.length).split("/");
    names.set(first, more.length ? "tree" : "blob");
  }
  if (!names.size) return null;
  const entries = [...names].sort(([a, x], [b, y]) => (x === "tree" ? 0 : 1) - (y === "tree" ? 0 : 1) || a.localeCompare(b))
    .map(([name, type]) => ({ name, type, mode: type === "tree" ? "040000" : "100644", hash: full("b10b") }));
  return { kind: "tree", hash: full("7ee"), entries, total: entries.length };
}

// A browsing page under /p/atelier or /p/atelier/tN: code, log, commit/HASH
// or history/PATH. Null when the address names nothing here.
function browsePage(item, rest, url) {
  const commits = repos[item ?? ""];
  if (!commits) return null;
  const find = (hash) => Object.values(repos).flat().find((c) => hash && c.hash.startsWith(hash));
  const atHash = url.searchParams.get("at");
  const head = atHash ? find(atHash) : commits[0];
  if (!head) return null;
  const w = { project, item, at: atHash ? head.hash : null };
  const [what, ...path] = rest;
  // Only the fixture's own files: a name every object inherits
  // (constructor, toString, __proto__) is no file.
  const file = Object.hasOwn(FILES, path.join("/")) ? FILES[path.join("/")] : null;
  if (what === "code") {
    if (file !== null) {
      const lines = file.split("\n").slice(0, -1);
      return browse.renderBlob(w, head, path, { kind: "text", lines, bytes: file.length }, "PAVI");
    }
    const node = treeAt(path);
    return node && browse.renderTree(w, head, path, node, "PAVI", { by: new Map(node.entries.map((x) => [x.name, commits[0]])), examined: commits.length, complete: true });
  }
  if (what === "log" && !path.length) return browse.renderLog(w, head, commits, 0, false, "PAVI");
  if (what === "commit" && path.length === 1) {
    const c = find(path[0]);
    return c && browse.renderCommit(w, { commit: c, parent: c.parents[0] ?? null, files: c.parents.length ? diff.files : [], truncated: false }, "PAVI");
  }
  if (what === "history" && file !== null) return browse.renderHistory(w, head, path, commits, true, "PAVI");
  return null;
}

// The bar as the server fills it (src/index.ts, withShell): the Decisions
// count, the project switcher, and under /p/NAME the project's row.
function shellFor(pathname) {
  const [first, name, ...rest] = pathname.split("/").slice(1);
  return {
    waiting: attention.owner.length,
    incomplete: false,
    projects: [{ name: project.name, title: ui.titleOf(project), tasks: items.length, waiting: attention.owner.length }],
    here: first === "p" && name === project.name ? { project, ...ui.projectPageAt(rest.filter(Boolean)) } : null,
  };
}

// One address to its page: { status, html }. Nothing here reaches a server.
export function route(url) {
  const state = url.searchParams.get("state");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const parts = path.split("/").slice(1).map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
  // The task first: the one the address names, or ?task= on Decisions; the
  // ?state= variants then apply to it.
  const named = parts[0] === "p" && parts[1] === project.name && parts[2] ? tasks.find((i) => i.id === parts[2]) : undefined;
  const chosen = named ?? (url.searchParams.get("task") === "t4" ? items[1] : items[0]);
  const d = structuredClone(detail);
  if (chosen.id !== "t1") {
    d.item = structuredClone(chosen);
    d.events = events.filter((x) => x.itemId === chosen.id).reverse();
    if (chosen.id === "t4") d.gate = { ...d.gate, ready: true, needsAssessor: false, blockers: [] };
  }
  if (state === "local" || state === "local-strict") d.evidence.forEach((x) => { delete x.where; x.by = "codex/gpt-6"; });
  if (state === "local") d.policy = { ...policy, sandboxOnly: false };
  if (state === "failed") { d.evidence[0].passed = false; d.gate.needsAssessor = false; }
  if (state === "ready") d.gate = { ...d.gate, ready: true, needsAssessor: false, blockers: [] };
  if (state === "accepted" || state === "merged") { d.item.state = state; d.item.acceptedHead = d.item.head; d.gate.needsAssessor = false; }
  if (state === "long") d.item.title = "Review a project with a very long title, extensive agent output, and deeply nested files that must remain readable on a phone";
  const empty = state === "empty";
  const decisions = () => ui.renderInbox(empty ? [] : [attention], [project], "PAVI", empty ? undefined : { project, detail: d, diff }, [{ project, items }]);
  const pages = {
    "/": decisions,
    "/decisions": decisions,
    "/login": () => ui.renderLogin(),
    "/how": () => renderHow(),
    // /projects is Home now; the server redirects it there.
    "/home": () => ui.renderHome(empty ? [] : [{ project, items, events, waiting: attention }], "PAVI", now, OWNER),
    "/projects": () => pages["/home"](),
    "/studio": () => ui.renderStudio(empty ? { benches: [], from: floor.from, to: floor.to } : floor, "PAVI", now),
    "/flow": () => ui.renderFlow(empty ? [] : [story], empty ? emptyTally() : addTally(emptyTally(), story.tally), OWNER, "PAVI"),
    "/history": () => ui.renderHistory([{ project, items: [merged] }], "PAVI"),
    "/models": () => ui.renderModels(models, buildRecord(events), "PAVI"),
    "/usage": () => renderUsage(empty ? [] : usage, DEFAULT_THRESHOLDS, [], now, "PAVI"),
    "/error": () => ui.renderError("This task changed since you opened it. Refresh and review the new revision."),
    "/p/atelier": () => ui.renderProject(project, items, events.slice(-8).reverse(), "PAVI"),
    "/p/atelier/tasks": () => ui.renderProjectTasks(project, items, "PAVI"),
    "/p/atelier/flow": () => ui.renderProjectFlow(project, story, OWNER, "PAVI"),
    "/p/atelier/plans": () => ui.renderProjectPlans(project, empty ? [] : plans, "PAVI"),
    "/p/atelier/ship": () => ui.renderProjectShip(project, renderActions(project.name, [], [], HEAD), "PAVI"),
    "/p/atelier/settings": () => ui.renderProjectSettings(project, "PAVI"),
  };
  let html = pages[path]?.() ?? null;
  if (!html && parts[0] === "p" && parts[1] === project.name) {
    // /p/atelier/tN is the task; past it, or past /p/atelier, a browsing page.
    if (named && parts.length === 3) html = ui.renderItem(project, d, "PAVI", state === "unavailable" ? "unavailable" : diff);
    else if (named) html = browsePage(named.id, parts.slice(3), url);
    else html = browsePage(null, parts.slice(2), url);
  }
  if (!html) return { status: 404, html: "Not found." };
  html = html.replace(/<meta http-equiv="refresh" content="\d+">/, "");
  if (ui.hasShell(html)) html = ui.fillShell(html, shellFor(path));
  return { status: 200, html };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const server = createServer((req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "text/plain" });
      return res.end("Read-only preview; no live action was taken.");
    }
    const { status, html } = route(new URL(req.url, "http://localhost"));
    res.writeHead(status, { "content-type": "text/html" });
    res.end(html);
  });
  server.listen(Number(process.env.PORT || 0), "127.0.0.1", () => console.log(`http://127.0.0.1:${server.address().port}`));
}
