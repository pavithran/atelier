// A fixed portfolio for the waiting rule (src/attention.ts, t504): one
// project holding a task for every owner call and every pipeline stage the
// rule places, and one whose notices are all the pipeline's. The node tests
// (CLI views) and the Workers tests (pages) read the same fixture and the
// same expected placement, so the four views are checked against one answer.
import type { InboxEntry, Item } from "../../src/rules.ts";
import type { SeenOffer } from "../../src/dispatch/rules.ts";

export const NOW = new Date("2026-10-11T12:00:00.000Z");
const HEAD = "a".repeat(40);
const at = (m: number) => new Date(Date.UTC(2026, 9, 11, 9, m)).toISOString();

const dispatch = (model: string) => ({ to: "home" as const, agent: "codex", model, by: "atelier/orchestrator", at: at(1), note: "" });

export function item(id: string, state: Item["state"], over: Partial<Item> = {}, n = Number(id.replace(/\D/g, ""))): Item {
  return {
    id, title: `Task ${id}`, state, owner: null, scope: [], fork: null, base: null, head: null, acceptedHead: null,
    createdAt: at(n), updatedAt: at(n), lastPushAt: null, ...over,
  };
}

export function entry(project: string, itemId: string, kind: InboxEntry["kind"], reason = `because ${kind}`, over: Partial<InboxEntry> = {}): InboxEntry {
  return { project, itemId, title: `Task ${itemId}`, kind, reason, weight: 1, ...over };
}
// A reviewer the pool offers for an assess entry, as the Ledger's inbox sets it
// when given the pool; null when none qualifies.
const REVIEWER = { reviewer: "claude-code/opus-5.5" };

export const OFFERS: SeenOffer[] = [
  { runner: "home:studio", kind: "home", jobs: ["build"], agents: [{ agent: "codex", models: ["gpt-6"] }], at: NOW.toISOString() } as SeenOffer,
];

export const ALPHA_ITEMS: Item[] = [
  item("a1", "submitted", { owner: "codex/gpt-6", head: HEAD }),
  item("a2", "submitted", { owner: "codex/gpt-6", head: HEAD, scope: ["src/**"] }),
  item("a3", "claimed", { owner: "claude-code/opus-5.5", scope: ["src/a.ts"] }),
  item("a4", "blocked", { owner: "codex/gpt-6", blocked: { by: "codex/gpt-6", reason: "no acceptance criteria", at: at(4), from: "claimed" } }),
  item("a5", "open", { kind: "plan" }),
  item("a6", "open", { kind: "plan" }),
  item("a7", "open"),
  item("a8", "open", { dispatch: dispatch("gpt-9") }),
  item("a9", "open", { dispatch: dispatch("gpt-6") }),
  item("a10", "submitted", { owner: "codex/gpt-6", head: HEAD, secret: [{ file: "src/key.ts", line: 3, fingerprint: "f", head: HEAD, by: "atelier/scan", at: at(10) }] }),
  item("a11", "merged", { acceptedHead: HEAD }),
  item("a12", "accepted", { owner: "codex/gpt-6", head: HEAD, acceptedHead: HEAD }),
  item("a13", "merged", { acceptedHead: HEAD }),
  item("a14", "submitted", { owner: "codex/gpt-6", head: HEAD, scope: ["wrangler.toml"] }),
  item("a15", "open", { dispatch: dispatch("gpt-6") }),
];

export const ALPHA_ENTRIES: InboxEntry[] = [
  entry("alpha", "a1", "accept", "all checks observed passing at this head"),
  entry("alpha", "a2", "assess", "a protected change needs an independent review", REVIEWER),
  entry("alpha", "a2", "overlap", "scope overlaps a3 (claude-code/opus-5.5)"),
  entry("alpha", "a3", "overlap", "scope overlaps a2 (codex/gpt-6)"),
  entry("alpha", "a3", "stale", "claude-code/opus-5.5 has not pushed for 14h; hand it off or release it"),
  entry("alpha", "a4", "blocked", "blocked by codex/gpt-6: no acceptance criteria"),
  entry("alpha", "a5", "approve-plan", "the planner proposed 3 parts"),
  entry("alpha", "a6", "plan-blocked", "blocked: the planner failed twice"),
  entry("alpha", "a10", "failing", "npm test failed"),
  entry("alpha", "a11", "ship", "merged with deploy declared by the ship files and not yet run"),
  entry("alpha", "a14", "assess", "a protected change needs an independent review; ask a reviewer with atelier land a14 --reviewer H/M, and override only as the owner's last resort", { reviewer: null, weight: 80 }),
  entry("alpha", "a12", "merge", "accepted; run `atelier merge` in the project checkout"),
  entry("alpha", "a15", "gave-up", "the merge failed twice (its commits are pushed); run `atelier dispatch a15` to send it out again"),
];

export const BETA_ITEMS: Item[] = [item("b1", "submitted", { owner: "codex/gpt-6", head: HEAD }), item("b2", "claimed", { owner: "codex/gpt-6" })];
export const BETA_ENTRIES: InboxEntry[] = [entry("beta", "b1", "assess", "because assess", REVIEWER), entry("beta", "b1", "scope", "changes outside its scope: x")];

// Every notice, as the server's GET /inbox returns them across projects.
export const ALL_ENTRIES = [...ALPHA_ENTRIES, ...BETA_ENTRIES];

// The one answer every view must give: per project, the tasks waiting on the
// owner, in the rule's order, and the pipeline's tasks.
export const EXPECTED = {
  alpha: {
    owner: [["a10", "clear-secret"], ["a4", "unblock"], ["a6", "decide-plan"], ["a5", "approve-plan"], ["a1", "accept"], ["a14", "override"], ["a11", "ship"], ["a15", "gave-up"], ["a8", "start-runner"]],
    pipeline: [["a2", "submitted"], ["a3", "building"], ["a7", "open"], ["a9", "queued"], ["a12", "accepted"]],
    overlaps: [["a2", "a3"]],
  },
  beta: { owner: [] as string[][], pipeline: [["b1", "submitted"], ["b2", "building"]], overlaps: [] as string[][] },
};
