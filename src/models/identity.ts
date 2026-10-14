// Model identity for role assignments and the readers they order (t622):
// which pool entry a name is. It reads names only, and enforces nothing:
// the owner's standing is src/models/pool.ts's (actorStanding,
// withStanding), unchanged, and every reader that needs it calls those.
//
// A pool alias is a name a person types: on a CLI flag, in the project's
// policy text (its review tier, triage, resolvers), as --as. It is
// converted once, where it enters (canonicalNames in src/index.ts), to the
// exact pool entry it names (entryNamed), refusing an ambiguous name. What
// t622 stores (assignment choices, tier picks, recorded reviewers) holds
// that exact harness/id, and its readers find an entry by it with
// exactEntry: plain equality, in any letter case. Stored data from before
// that may hold an alias, and is not marked exact (a policy's exactNames, an
// event's actingExact), is converted when read by storedActor.

import { modelKey, RuleError, sameActor } from "../rules.ts";
import type { ModelEntry } from "./pool.ts";

// The entry an exact harness/id is, or undefined.
export function exactEntry<E extends Pick<ModelEntry, "id" | "harness">>(pool: readonly E[], actor: string): E | undefined {
  const lower = actor.toLowerCase();
  return pool.find((m) => `${m.harness}/${m.id}`.toLowerCase() === lower);
}

// The rule for a name a person types (gpt-6-astra's fourteenth review of
// t622), in one place. A harness/model resolves, within its harness, to:
//   (a) the entry whose id is the name exactly (any letter case); else
//   (b) the one entry whose id is the same model by modelKey, as main's
//       sameActor reads it: a ":profile" suffix stripped, letter case, the
//       static registry's names (codex/gpt-6-astra:high is gpt-6-astra);
//   (c) else the one entry listing the name as an alias, exactly or as the
//       same model by sameActor.
// Two entries answering at a step are ambiguous and refused; a step answers
// only when the earlier ones did not. Undefined when none answers: a model
// outside the pool. storedActor reads legacy stored names by the same rule.
export function entryNamed<E extends Pick<ModelEntry, "id" | "harness" | "aliases">>(pool: readonly E[], name: string): E | undefined {
  const { found, how } = namedCandidates(pool, name);
  if (found.length > 1) throw new RuleError("ambiguous_model", `${name} ${how} ${found.map((m) => `${m.harness}/${m.id}`).join(" and ")}; name one by its id`, 400);
  return found[0];
}

// The entries answering a typed name at the first step of the rule above
// that any answers: one, several (ambiguous), or none.
export function namedCandidates<E extends Pick<ModelEntry, "id" | "harness" | "aliases">>(pool: readonly E[], name: string): { found: E[]; how: string } {
  const exact = exactEntry(pool, name);
  if (exact) return { found: [exact], how: "is" };
  const slash = name.indexOf("/");
  const harness = slash === -1 ? null : name.slice(0, slash).toLowerCase();
  const inHarness = pool.filter((m) => harness === null || m.harness.toLowerCase() === harness);
  const same = inHarness.filter((m) => sameActor(`${m.harness}/${m.id}`, name));
  if (same.length) return { found: same, how: "is the same model as" };
  const lower = name.toLowerCase();
  return { found: inHarness.filter((m) => m.aliases.some((alias) => `${m.harness}/${alias}`.toLowerCase() === lower || sameActor(`${m.harness}/${alias}`, name))), how: "is an alias of" };
}

// The exact harness/id a typed name stands for, or the name as typed when
// no pool entry is it (a model outside the pool, which some places allow).
export function typedActor(pool: readonly Pick<ModelEntry, "id" | "harness" | "aliases">[], name: string): string {
  const entry = entryNamed(pool, name);
  return entry ? `${entry.harness}/${entry.id}` : name;
}

// A bare model a person types (dispatch --suggest --model, no harness): by
// the same rule, over every harness: (a) an entry's id exactly, else (b)
// the one id that is the same model by modelKey, else (c) the one id listing
// it as an alias. The result is a pool entry's id, or the model as typed
// when none answers; two distinct ids at a step are refused.
export function typedModel(pool: readonly Pick<ModelEntry, "id" | "harness" | "aliases">[], model: string): string {
  const lower = model.toLowerCase();
  const exact = pool.find((m) => m.id.toLowerCase() === lower);
  if (exact) return exact.id;
  const one = (ids: string[], how: string): string | undefined => {
    const distinct = [...new Set(ids)];
    if (distinct.length > 1) throw new RuleError("ambiguous_model", `${model} ${how} ${distinct.join(" and ")}; name one by its id`, 400);
    return distinct[0];
  };
  return one(pool.filter((m) => modelKey(m.id) === modelKey(model)).map((m) => m.id), "is the same model as")
    ?? one(pool.filter((m) => m.aliases.some((a) => a.toLowerCase() === lower || modelKey(a) === modelKey(model))).map((m) => m.id), "is an alias of")
    ?? model;
}

// Stored data from before identities were converted where typed may hold
// an alias: it is converted when read, here, as a typed name is, except
// that an ambiguous one is left as stored rather than refused. Only such
// legacy data comes here. Values written since carry a mark (a policy's
// exactNames, an event's actingExact), and a marked value is an exact id,
// compared as it is and never read again through the aliases (gpt-6-astra's
// ninth review of t622, finding 3).
export function storedActor(pool: readonly Pick<ModelEntry, "id" | "harness" | "aliases">[], name: string): string {
  try { return typedActor(pool, name); } catch { return name; }
}
