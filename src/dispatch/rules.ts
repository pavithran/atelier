// Dispatch: the project owner (and, later, an orchestrator holding an approved
// plan) puts an open task in a queue for a kind of runner. Runners do not get
// work pushed to them; they ask for it, describing what they can run, and then
// claim it through the ordinary atomic claim. A runner at home therefore only
// ever makes outgoing requests, and every runner's work is judged the same way.

import { RuleError, validActor, type Item } from "../rules.ts";

export type RunnerKind = "cloud" | "home";
export const RUNNER_KINDS: RunnerKind[] = ["cloud", "home"];

export interface Dispatch {
  to: RunnerKind | "any";
  agent: string | null;   // an agent harness family, e.g. "claude-code", "codex", "opencode"; null for any
  model: string | null;   // a model id as the runner names it; null for the runner's choice
  by: string;
  at: string;
  note: string;
  // A job other than building the item: "plan" asks the runner to write the
  // plan item's plan document (docs/orchestrator.md, section 2). Absent for
  // ordinary work.
  job?: "plan";
}

// What a runner says it can run when it asks for work. `jobs` names the
// jobs besides building that it runs; a dispatch for any other job is never
// offered to it.
export interface RunnerOffer {
  runner: string;          // "home:studio", "cloud:atelier"
  kind: RunnerKind;
  agents: { agent: string; models: string[] }[];
  jobs?: string[];
}

export interface Assignment {
  agent: string;
  model: string;
  actor: string;           // the name the runner claims under: agent/model
}

const NAME = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;
const AGENT = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

// Every name a runner could be told to claim under must be one a claim accepts.
function claimable(agent: string, model: string): boolean {
  return AGENT.test(agent) && NAME.test(model) && validActor(`${agent}/${model}`);
}

const RUNNER_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

// A runner is exactly kind:name, with no further colon, and is returned
// normalized, all in lower case, so what is stored is what was matched and
// home:Studio and home:studio are one runner.
export function parseRunner(header: string | null): { runner: string; kind: RunnerKind } | null {
  if (!header) return null;
  const at = header.indexOf(":");
  const kind = header.slice(0, at), name = header.slice(at + 1);
  if (at < 0 || !RUNNER_KINDS.includes(kind.toLowerCase() as RunnerKind) || !RUNNER_NAME.test(name)) {
    throw new RuleError("bad_runner", `"${header}" is not a runner; use cloud:NAME or home:NAME`, 400);
  }
  return { runner: header.toLowerCase(), kind: kind.toLowerCase() as RunnerKind };
}

export function makeDispatch(input: { to?: unknown; agent?: unknown; model?: unknown; note?: unknown }, by: string, at: string): Dispatch {
  const to = String(input.to ?? "any");
  if (to !== "any" && !RUNNER_KINDS.includes(to as RunnerKind)) {
    throw new RuleError("bad_dispatch", `send to cloud, home or any, not "${to}"`, 400);
  }
  const optional = (v: unknown, what: string) => {
    if (v === undefined || v === null || v === "") return null;
    const s = String(v);
    if (!NAME.test(s)) throw new RuleError("bad_dispatch", `"${s}" is not a valid ${what}`, 400);
    return s;
  };
  const agent = optional(input.agent, "agent");
  const model = optional(input.model, "model");
  if (agent && !AGENT.test(agent)) throw new RuleError("bad_dispatch", `"${agent}" is not a valid agent`, 400);
  if (model && !claimable(agent ?? "agent", model)) throw new RuleError("bad_dispatch", `no runner could claim as "${agent ?? "agent"}/${model}"`, 400);
  return { to: to as Dispatch["to"], agent, model, by, at, note: String(input.note ?? "").slice(0, 500) };
}

export function assertDispatchable(item: Item): void {
  if (item.state !== "open" || item.owner) {
    throw new RuleError("not_open", `${item.id} is ${item.owner ? `owned by ${item.owner}` : item.state}; only an open task can be sent to a runner`);
  }
}

// The agent and model a runner should use for a dispatch, or null if it cannot.
export function assign(d: Dispatch, offer: RunnerOffer): Assignment | null {
  if (d.to !== "any" && d.to !== offer.kind) return null;
  if (d.job && !(offer.jobs ?? []).includes(d.job)) return null;
  for (const { agent, models } of offer.agents) {
    if (d.agent && agent !== d.agent) continue;
    const usable = models.filter((m) => claimable(agent, m));
    const model = d.model ? (usable.includes(d.model) ? d.model : null) : usable[0] ?? null;
    if (model) return { agent, model, actor: `${agent}/${model}` };
  }
  return null;
}

// A dispatched task may be claimed only by a matching runner, under a name
// that matches the agent and model asked for. An undispatched task is claimed
// as before, by anyone eligible.
export function assertDispatchedClaim(item: Item & { dispatch?: Dispatch | null }, actor: string, runner: { runner: string; kind: RunnerKind } | null): void {
  const d = item.dispatch;
  if (!d || item.state !== "open") return;
  if (!runner) {
    throw new RuleError("dispatched", `${item.id} is waiting for a ${d.to === "any" ? "" : `${d.to} `}runner; withdraw the dispatch to claim it by hand`);
  }
  if (d.to !== "any" && d.to !== runner.kind) {
    throw new RuleError("wrong_runner", `${item.id} is for a ${d.to} runner, not ${runner.runner}`, 403);
  }
  const [harness, model] = actor.split("/");
  if (d.agent && harness !== d.agent) throw new RuleError("wrong_agent", `${item.id} asks for ${d.agent}, not ${harness}`, 403);
  if (d.model && model !== d.model) throw new RuleError("wrong_model", `${item.id} asks for ${d.model}, not ${model ?? "no model"}`, 403);
}

export function describe(d: Dispatch): string {
  const where = d.to === "any" ? "any runner" : `a ${d.to} runner`;
  const what = d.agent ? `${d.agent}${d.model ? ` with ${d.model}` : ""}` : d.model ? d.model : "its choice of agent";
  return `${where}, ${what}`;
}
