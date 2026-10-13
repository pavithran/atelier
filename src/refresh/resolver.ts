// Who may resolve a refresh's mechanical conflicts (t462). The resolver is a
// model, run by a home runner, that resolves the conflicts a refresh found
// to be mechanical (src/refresh/mechanical.ts); what it writes is verified
// against the transformations before anything is pushed.
//
// A resolver is eligible when:
//   - it is in the project's configured resolver set (ProjectPolicy.resolvers,
//     atelier init --resolver), the frontier models the owner trusts with it;
//   - its model is a frontier model by name, as the reviewer picker reads one;
//   - its provider is recognised from its model's name, the identity review
//     independence compares (actorFamily), so it can be shown independent;
//   - it is independent of every review the refresh seeks to retain: the
//     standing approvals of the head it refreshes. The resolver becomes a
//     contributor of the task, so a reviewer it shares a family with — or,
//     in single-family mode, a model — would no longer be independent of the
//     change, and the resolver may never be that reviewer itself.
// The first eligible one in the configured order is chosen; with none, the
// refresh waits, explicitly, saying why each candidate was refused.
import { frontier } from "../models/suggest.ts";
import type { ModelEntry, PoolFamily } from "../models/pool.ts";
import { actorFamily, contributed, familyRefusal, modelKey, validActor } from "../rules.ts";

// Whether a model is a frontier one by its name, as the reviewer picker reads it.
const isFrontier = (actor: string): boolean => frontier({ id: modelKey(actor), aliases: [] } as unknown as ModelEntry);

export interface ResolverContext {
  configured: readonly string[];          // ProjectPolicy.resolvers, in the owner's order
  retained: readonly { by: string }[];    // the reviews the refresh seeks to retain
  single: PoolFamily | null;              // single-family mode's company, if any
}

export function resolverRefusal(actor: string, ctx: ResolverContext): string | null {
  if (!ctx.configured.some((c) => c.toLowerCase() === actor.toLowerCase())) return "not in the project's configured resolver set (atelier init --resolver)";
  if (!isFrontier(actor)) return "not a frontier model";
  const provider = actorFamily(actor);
  if (provider === "other") return "its provider is not recognised from its model's name";
  if (ctx.single && provider !== ctx.single) return `not one of ${ctx.single}'s models, and this project runs in single-family mode`;
  for (const r of ctx.retained) {
    if (contributed(actor, [r.by])) return `it gave the review by ${r.by} the refresh would retain`;
    const why = familyRefusal(r.by, [actor], ctx.single);
    if (why) return `the review by ${r.by} would no longer be independent of it: ${why}`;
  }
  return null;
}

export type ResolverPick =
  | { actor: string; provider: PoolFamily }
  | { actor: null; wait: string; refusals: { actor: string; why: string }[] };

// The resolver for a refresh, from `candidates` (the actors live runners
// offer, or the configured set itself), in the configured order.
export function pickResolver(candidates: readonly string[], ctx: ResolverContext): ResolverPick {
  const refusals: { actor: string; why: string }[] = [];
  const offered = new Set(candidates.map((c) => c.toLowerCase()));
  for (const actor of ctx.configured) {
    if (!validActor(actor) || !actor.includes("/")) { refusals.push({ actor, why: "not harness/model" }); continue; }
    if (!offered.has(actor.toLowerCase())) { refusals.push({ actor, why: "no live runner offers it the resolve job" }); continue; }
    const why = resolverRefusal(actor, ctx);
    if (why) { refusals.push({ actor, why }); continue; }
    return { actor, provider: actorFamily(actor) };
  }
  const wait = !ctx.configured.length
    ? "the project names no resolver (atelier init --resolver H/M), so a mechanical conflict waits for one"
    : `no configured resolver may take it: ${refusals.map((r) => `${r.actor}, ${r.why}`).join("; ")}`;
  return { actor: null, wait, refusals };
}

// The configured resolver set as the policy takes it: harness/model actors,
// each once; "" or an empty list clears it.
export function parseResolvers(value: unknown): string[] {
  const list = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : null;
  if (!list || list.some((v) => typeof v !== "string")) throw new Error("resolvers must be harness/model actors, comma-separated");
  const out: string[] = [];
  for (const raw of list as string[]) {
    const actor = raw.trim();
    if (!actor) continue;
    if (!validActor(actor) || !actor.includes("/")) throw new Error(`${JSON.stringify(actor)} is not harness/model`);
    if (actorFamily(actor) === "other") throw new Error(`${actor}'s provider is not recognised from its model's name, so it cannot be shown independent of a review`);
    if (!isFrontier(actor)) throw new Error(`${actor} is not a frontier model`);
    if (!out.some((a) => a.toLowerCase() === actor.toLowerCase())) out.push(actor);
  }
  return out;
}
