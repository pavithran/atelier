// The design captures' fixture (t499): one seeded portfolio, at a fixed
// time, that every page and state in docs/design/brief.md is drawn from. It
// is written into the Workers test pool's own Ledger Durable Objects through
// their methods, as the other specs do, so the pages read it exactly as they
// read production records; only the Artifacts binding (test/fixtures/design/
// git.ts), the Access keys and a broken Ledger for one project are stood in.
//
// Three projects hold the work, 310 tasks in all; two more are registered
// with none, one of them unreadable. fixture.spec.ts asserts the totals and
// each state; render.design.ts draws the pages for scripts/design/capture.ts.

import { vi } from "vitest";
import { FakeGit } from "./git.ts";

export const FIXED_NOW = "2026-10-10T12:00:00.000Z";
export const START = "2026-09-12T09:00:00.000Z";
export const OWNER = "owner";
export const OWNER_NAME = "Owner";

// The agents, one per family, so every family colour is drawn.
export const AGENTS = ["claude-code/opus-5.5", "codex/gpt-6-astra", "zcode/glm-5.3", "antigravity/gemini-3.1-pro", "opencode/qwen-4"] as const;
const agent = (i: number) => AGENTS[i % AGENTS.length];
// A reviewer from another family than the holder.
const reviewer = (holder: string) => AGENTS.find((a) => a.split("/")[0] !== holder.split("/")[0])!;

// The one long title and brief, for the pages' long-text state.
export const LONG_TITLE = "Say in the decision line which revision, where each check ran and what is asked";
export const LONG_BRIEF = `${"The owner reads the decision line first and should not need to open the technical details to know whether the evidence is current. ".repeat(6)}This brief is long on purpose: the design captures need a task whose words overflow every card that shows them.`;

// Strings the anonymised project holds that must never reach a public page.
export const SECRETS = ["field-notes", "Field Notes", "Keychain.swift", "jo@private.example", "xcodebuild -scheme FieldNotes test", "secret reviewer note"];

export type Shape =
  | "merged" | "abandoned" | "open" | "working" | "stale" | "blocked" | "failed"
  | "ready" | "protected" | "sentBack" | "accepted" | "scope" | "overlap";

export interface ProjectPlan { name: string; title: string; checks: string[]; protected: string[]; shapes: Partial<Record<Shape, number>> }

// The three projects with work. The counts are what fixture.spec.ts asserts.
export const PLANS: ProjectPlan[] = [
  {
    name: "ledger-core", title: "Ledger Core", checks: ["npm test", "npm run typecheck"], protected: ["src/auth/**"],
    shapes: { merged: 156, abandoned: 6, open: 14, working: 4, overlap: 2, stale: 3, blocked: 2, failed: 3, ready: 4, protected: 2, sentBack: 1, accepted: 2, scope: 1 },
  },
  {
    name: "field-notes", title: "Field Notes", checks: ["xcodebuild -scheme FieldNotes test"], protected: [],
    shapes: { merged: 50, abandoned: 4, open: 8, working: 4, ready: 2, failed: 1, blocked: 1 },
  },
  {
    name: "open-tool", title: "Open Tool", checks: ["npm test"], protected: [],
    shapes: { merged: 25, open: 10, working: 3, ready: 2 },
  },
];
// Registered with no work, and registered but unreadable.
export const EMPTY_PROJECT = "blank-slate";
export const UNAVAILABLE_PROJECT = "cold-storage";
// The project with git history from before Atelier, and how many days of it.
export const HISTORY_PROJECT = "open-tool";
export const HISTORY_DAYS = 60;

export const total = (p: ProjectPlan) => Object.values(p.shapes).reduce((n, k) => n + (k ?? 0), 0);
export const TOTAL_TASKS = PLANS.reduce((n, p) => n + total(p), 0);

// The Ledger state each shape leaves a task in.
export const STATE_OF: Record<Shape, string> = {
  merged: "merged", abandoned: "abandoned", open: "open", working: "claimed", overlap: "claimed", stale: "claimed",
  blocked: "blocked", failed: "submitted", ready: "submitted", protected: "submitted", sentBack: "submitted", accepted: "accepted", scope: "submitted",
};

const L = (env: Env, name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
const I = (env: Env) => env.LEDGER.get(env.LEDGER.idFromName("__index"));

// Fake time: every Ledger write takes its time from Date, which the pool's
// isolate shares with this test, so each step is stamped where it is set.
let clock = Date.parse(START);
const at = (ms: number) => { clock = ms; vi.setSystemTime(new Date(ms)); return new Date(ms).toISOString(); };
const advance = (minutes: number) => at(clock + minutes * 60_000);

const FILES = ["src/ledger.ts", "src/ui.ts", "src/layout.css", "src/rules.ts", "test/ui.spec.ts", "docs/guide.md", "src/auth/session.ts", "README.md"];

// Where each seeded task ended up, for the spec's assertions and the pages list.
export interface Seeded { byShape: Record<string, Record<Shape, string[]>>; git: FakeGit; mainHead: Record<string, string> }

function workTitle(project: string, i: number, shape: Shape): string {
  const verbs = ["Fix", "Add", "Refactor", "Document", "Test", "Tidy"];
  const things = project === "field-notes"
    ? ["the Keychain.swift crash for jo@private.example", "offline sync of notes", "the share sheet", "photo attachments", "search across notebooks"]
    : ["the decision line", "the project tabs", "paging on the log", "the review gate", "the merge preview", "the usage alerts", "the showcase cards"];
  return `${verbs[i % verbs.length]} ${things[i % things.length]} (${shape} ${i + 1})`;
}

export async function seed(env: Env): Promise<Seeded> {
  const git = new FakeGit();
  const seeded: Seeded = { byShape: {}, git, mainHead: {} };
  at(Date.parse(START));
  for (const plan of PLANS) {
    const record = { name: plan.name, repo: plan.name, title: plan.title, policy: { checks: plan.checks, protected: plan.protected }, createdAt: new Date(clock).toISOString() };
    await I(env).registerProject(record);
    await L(env, plan.name).setProject(record, OWNER);
  }
  for (const name of [EMPTY_PROJECT, UNAVAILABLE_PROJECT]) {
    const record = { name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date(clock).toISOString() };
    await I(env).registerProject(record);
    await L(env, name).setProject(record, OWNER);
  }

  // Each project's main line: a first commit, then a merge per merged task.
  const files = new Map<string, Map<string, string>>();
  for (const plan of PLANS) {
    const tree = new Map(FILES.map((f) => [f, `// ${f} of ${plan.name}\n`]));
    files.set(plan.name, tree);
    let parent: string[] = [];
    // The named project has git history from before its first task, so the
    // imported history has a "before" to draw: one commit a day, two in
    // three naming an agent the way commit messages do.
    if (plan.name === HISTORY_PROJECT) {
      for (let d = HISTORY_DAYS; d > 0; d--) {
        const named = d % 3 === 0 ? "" : `\n\nCo-Authored-By: ${d % 3 === 1 ? "Claude Opus 4.7 <noreply@anthropic.com>" : "Codex gpt-5.5 <codex@example.com>"}`;
        parent = [git.commit(plan.name, { treeHash: git.tree(tree), message: `Change ${HISTORY_DAYS - d + 1} before Atelier${named}`, author: { name: OWNER_NAME, email: "owner@example.com" }, parents: parent, authoredAt: Math.floor((clock - d * 86_400_000) / 1000) })];
      }
    }
    seeded.mainHead[plan.name] = git.commit(plan.name, { treeHash: git.tree(tree), message: "Initial commit\n\nAgent: owner", author: { name: OWNER_NAME, email: "owner@example.com" }, parents: parent, authoredAt: Math.floor(clock / 1000) });
  }

  // The merged work is spread over the four weeks before FIXED_NOW, so the
  // cards' two-week bars and the timeline have something to draw; the rest
  // of the shapes happen in the last two days.
  const end = Date.parse(FIXED_NOW);
  const merges = PLANS.flatMap((plan) => Array.from({ length: plan.shapes.merged ?? 0 }, (_, i) => ({ plan, i })));
  // Interleave the projects' merges in time.
  merges.sort((a, b) => a.i / (a.plan.shapes.merged ?? 1) - b.i / (b.plan.shapes.merged ?? 1));
  const span = end - 2 * 86_400_000 - Date.parse(START);
  const counters = new Map<string, number>();
  const record = (project: string, shape: Shape, id: string) => {
    const p = (seeded.byShape[project] ??= {} as Record<Shape, string[]>);
    (p[shape] ??= []).push(id);
  };
  const next = (project: string) => { const n = (counters.get(project) ?? 0) + 1; counters.set(project, n); return n; };

  // A task with a pushed revision: claimed, forked from main, one commit.
  const work = async (plan: ProjectPlan, shape: Shape, i: number, opts: { scope?: string[]; touch?: string; title?: string; fields?: Record<string, unknown> } = {}) => {
    const l = L(env, plan.name);
    const holder = agent(i + plan.name.length);
    const item = await l.newItem(opts.title ?? workTitle(plan.name, i, shape), opts.scope ?? [], OWNER, opts.fields ?? {});
    const id = item.id;
    next(plan.name);
    advance(7);
    await l.claim(id, holder);
    const base = git.heads.get(plan.name)!;
    const fork = `${plan.name}--${id}`;
    await l.setFork(id, fork, base, holder);
    const tree = new Map(files.get(plan.name)!);
    const touch = opts.touch ?? FILES[i % 6];
    tree.set(touch, `${tree.get(touch)}// ${id}: ${shape}\n`);
    advance(25);
    const head = git.commit(fork, { treeHash: git.tree(tree), message: `${opts.title ?? workTitle(plan.name, i, shape)}\n\nAgent: ${holder}`, author: { name: holder, email: "agent@example.com" }, parents: [base], authoredAt: Math.floor(clock / 1000) });
    git.heads.set(fork, head);
    await l.recordPush(id, holder, head, head);
    return { l, id, holder, head, tree, touch };
  };
  const check = async (plan: ProjectPlan, w: { l: ReturnType<typeof L>; id: string; holder: string; head: string; touch: string }, passed: boolean, where: "sandbox" | "runner" = "runner") => {
    advance(4);
    for (const claim of plan.checks) {
      await w.l.addEvidence({ itemId: w.id, claim, grade: "observed", head: w.head, passed: claim === plan.checks[0] ? passed : true, by: w.holder, at: new Date(clock).toISOString(), changedPaths: [w.touch], where, ...(passed ? {} : { outputTail: "FAIL test/ui.spec.ts > the decision line names the revision\nExpected: \"Checks passed at 1a2b3c4d\"\nReceived: \"Checks passed\"" }) });
    }
  };

  for (const [n, { plan, i }] of merges.entries()) {
    at(Date.parse(START) + Math.round((n / merges.length) * span) + (i % 3) * 3_600_000);
    const w = await work(plan, "merged", i);
    await check(plan, w, true, i % 3 === 0 ? "sandbox" : "runner");
    advance(5);
    await w.l.submit(w.id, w.holder);
    advance(40);
    await w.l.accept(w.id, OWNER, w.head);
    advance(10);
    const main = git.heads.get(plan.name)!;
    const merged = new Map(files.get(plan.name)!);
    merged.set(w.touch, w.tree.get(w.touch)!);
    files.set(plan.name, merged);
    const mergeCommit = git.commit(plan.name, { treeHash: git.tree(merged), message: `Merge ${w.id}: ${workTitle(plan.name, i, "merged")}\n\nAgent: ${w.holder}`, author: { name: OWNER_NAME, email: "owner@example.com" }, parents: [main, w.head], authoredAt: Math.floor(clock / 1000) });
    await w.l.merged(w.id, OWNER, mergeCommit, true, w.head);
    record(plan.name, "merged", w.id);
  }

  // Everything else, in the two days before FIXED_NOW.
  at(end - 2 * 86_400_000);
  for (const plan of PLANS) {
    const s = plan.shapes;
    for (let i = 0; i < (s.abandoned ?? 0); i++) {
      const w = await work(plan, "abandoned", i);
      advance(30);
      await w.l.abandon(w.id, OWNER, "Superseded by a smaller change; closing without merging.");
      record(plan.name, "abandoned", w.id);
    }
    for (let i = 0; i < (s.stale ?? 0); i++) {
      // Claimed and pushed two days ago, nothing since: "Needs a handoff".
      const w = await work(plan, "stale", i);
      record(plan.name, "stale", w.id);
    }
    for (let i = 0; i < (s.blocked ?? 0); i++) {
      const w = await work(plan, "blocked", i);
      advance(20);
      await w.l.block(w.id, w.holder, "The baseline's test fixture for sessions is missing; the owner must say which login flow is current.");
      record(plan.name, "blocked", w.id);
    }
  }
  at(end - 6 * 3_600_000);
  for (const plan of PLANS) {
    const s = plan.shapes;
    for (let i = 0; i < (s.open ?? 0); i++) {
      const long = plan.name === "ledger-core" && i === 0;
      const item = await L(env, plan.name).newItem(long ? LONG_TITLE : workTitle(plan.name, i, "open"), [], OWNER, long ? { brief: LONG_BRIEF } : {});
      next(plan.name);
      advance(3);
      record(plan.name, "open", item.id);
    }
    for (let i = 0; i < (s.working ?? 0); i++) record(plan.name, "working", (await work(plan, "working", i)).id);
    for (let i = 0; i < (s.overlap ?? 0); i++) record(plan.name, "overlap", (await work(plan, "overlap", i, { scope: ["src/ui.ts", "src/layout.css"] })).id);
    for (let i = 0; i < (s.failed ?? 0); i++) {
      const w = await work(plan, "failed", i);
      await check(plan, w, false);
      advance(5);
      await w.l.submit(w.id, w.holder);
      record(plan.name, "failed", w.id);
    }
    for (let i = 0; i < (s.ready ?? 0); i++) {
      const w = await work(plan, "ready", i);
      await check(plan, w, true, i % 2 ? "sandbox" : "runner");
      advance(5);
      await w.l.submit(w.id, w.holder, "Implements the change and its test; nothing else moved.");
      record(plan.name, "ready", w.id);
    }
    for (let i = 0; i < (s.protected ?? 0); i++) {
      const w = await work(plan, "protected", i, { touch: "src/auth/session.ts" });
      await check(plan, w, true);
      advance(5);
      await w.l.submit(w.id, w.holder);
      record(plan.name, "protected", w.id);
    }
    for (let i = 0; i < (s.sentBack ?? 0); i++) {
      // The live t435 shape: checks pass, then a reviewer sends it back.
      const w = await work(plan, "sentBack", i);
      await check(plan, w, true);
      advance(5);
      await w.l.submit(w.id, w.holder);
      advance(30);
      await w.l.addReview({ itemId: w.id, criteria: await w.l.criteria(w.id), by: reviewer(w.holder), head: w.head, approve: false, note: "The decision line still says Ready after this rejection; keep the state and the line in step.", at: new Date(clock).toISOString() });
      record(plan.name, "sentBack", w.id);
    }
    for (let i = 0; i < (s.accepted ?? 0); i++) {
      const w = await work(plan, "accepted", i);
      await check(plan, w, true);
      advance(5);
      await w.l.submit(w.id, w.holder);
      advance(20);
      await w.l.accept(w.id, OWNER, w.head);
      record(plan.name, "accepted", w.id);
    }
    for (let i = 0; i < (s.scope ?? 0); i++) {
      const w = await work(plan, "scope", i, { scope: ["docs/**"], touch: "src/rules.ts" });
      await check(plan, w, true);
      advance(5);
      await w.l.submit(w.id, w.holder);
      record(plan.name, "scope", w.id);
    }
  }

  // Usage as two runners last reported it, one of them stale.
  advance(30);
  await I(env).putUsage({ tool: "codex", runner: "home:studio", at: new Date(clock).toISOString(), windows: [{ name: "5-hour", usedPercent: 41, resetsAt: new Date(clock + 3 * 3_600_000).toISOString(), at: new Date(clock).toISOString() }, { name: "weekly", usedPercent: 86, resetsAt: new Date(clock + 3 * 86_400_000).toISOString(), at: new Date(clock).toISOString() }], models: [{ model: "gpt-6-astra", provider: "openai", spans: { "5h": { requests: 41, tokens: 912_000, cost: null }, "24h": { requests: 160, tokens: 3_400_000, cost: null }, "7d": { requests: 820, tokens: 17_000_000, cost: null } } }], balances: [], notes: [] }, { weeklyPercent: 80, windowPercent: 90, dailySpend: 10, balanceFloor: 10 }, "https://atelier.test/api/usage/codex");
  await I(env).putUsage({ tool: "opencode", runner: "home:laptop", at: new Date(end - 9 * 3_600_000).toISOString(), windows: [], models: [{ model: "qwen-4", provider: "ai-studio", spans: { "5h": { requests: 0, tokens: 0, cost: 0 }, "24h": { requests: 12, tokens: 210_000, cost: 0.42 }, "7d": { requests: 90, tokens: 1_900_000, cost: 3.1 } } }], balances: [{ currency: "USD", amount: 6.5 }], notes: ["The 5-hour window could not be read from this tool."] }, { weeklyPercent: 80, windowPercent: 90, dailySpend: 10, balanceFloor: 10 }, "https://atelier.test/api/usage/opencode");

  // One live task's workspace cannot be read: its page draws the "unavailable" diff.
  git.broken.add(`ledger-core--${seeded.byShape["ledger-core"].ready[0]}`);
  at(end);
  return seeded;
}

// The Ledger namespace the pages read, with one project's Ledger unreadable,
// as a Durable Object that is reset or overloaded is: retryable, so the
// pages answer 503 as they would in production.
export function withUnavailable(real: DurableObjectNamespace, name: string): DurableObjectNamespace {
  const lost = real.idFromName(`project:${name}`);
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "get") {
        return (id: DurableObjectId, opts?: unknown) => {
          if (id.equals(lost)) return new Proxy({}, { get: () => async () => { throw Object.assign(new Error(`${name}'s Ledger is unavailable (design fixture)`), { retryable: true }); } });
          return (target.get as (id: DurableObjectId, opts?: unknown) => unknown)(id, opts);
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}
