// Model identity for role assignments and the readers they order (t622):
// which pool entry a name is. It reads names only, and enforces nothing:
// the owner's standing is src/models/pool.ts's (actorStanding,
// withStanding). They read an entry's own state and roles before any alias
// owner's, hold an actor when any entry running its model is held, and check
// a dispatch naming only a model (t649); every reader that needs the
// standing calls those.
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
//
// Case-sensitive: what a reader compares is an exact id, stored or
// converted, and two pool ids may differ only in letter case (gpt-6-astra
// and GPT-6-ASTRA are two entries). Only the naming rule below, resolving
// a typed name, reads letter case loosely (gpt-6-astra's sixteenth and
// seventeenth reviews of t622).
export function exactEntry<E extends Pick<ModelEntry, "id" | "harness">>(pool: readonly E[], actor: string): E | undefined {
  return pool.find((m) => `${m.harness}/${m.id}` === actor);
}

// The entries a harness/id names exactly: the case-sensitive one alone when
// there is one, else every case-insensitive match.
function exactEntries<E extends Pick<ModelEntry, "id" | "harness">>(pool: readonly E[], actor: string): E[] {
  const same = pool.filter((m) => `${m.harness}/${m.id}` === actor);
  if (same.length) return same;
  const lower = actor.toLowerCase();
  return pool.filter((m) => `${m.harness}/${m.id}`.toLowerCase() === lower);
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
  const { found } = namedCandidates(pool, name);
  // The refusal names no pool entry: a caller who may not read the pool
  // learns nothing of it (gpt-6-astra's fifteenth review of t622, finding 2).
  if (found.length > 1) throw new RuleError("ambiguous_model", `${name} names more than one model in the pool; use its exact harness/id`, 400);
  return found[0];
}

// The entries answering a typed name at the first step of the rule above
// that any answers: one, several (ambiguous), or none.
export function namedCandidates<E extends Pick<ModelEntry, "id" | "harness" | "aliases">>(pool: readonly E[], name: string): { found: E[]; how: string } {
  const exact = exactEntries(pool, name);
  if (exact.length) return { found: exact, how: "is" };
  const slash = name.indexOf("/");
  const harness = slash === -1 ? null : name.slice(0, slash).toLowerCase();
  const inHarness = pool.filter((m) => harness === null || m.harness.toLowerCase() === harness);
  const same = inHarness.filter((m) => sameActor(`${m.harness}/${m.id}`, name));
  if (same.length) return { found: same, how: "is the same model as" };
  const lower = name.toLowerCase();
  return { found: inHarness.filter((m) => m.aliases.some((alias) => `${m.harness}/${alias}`.toLowerCase() === lower || sameActor(`${m.harness}/${alias}`, name))), how: "is an alias of" };
}

// The registered entries a harness-qualified reviewer name stands for,
// given the entries that share its model by modelKey in any harness. One
// model sold through two harnesses (claude-code/sonnet-5.5 and
// antigravity/claude-sonnet-5.5) is two entries, and a name that is exactly
// one of them is that one (t697, found when atelier land t52 --reviewer
// claude-code/sonnet-5.5 was refused as ambiguous). Several entries still
// answering after the harness is read stay several.
export function reviewerEntries<E extends Pick<ModelEntry, "id" | "harness" | "aliases">>(sharing: readonly E[], name: string): E[] {
  if (sharing.length < 2 || !name.includes("/")) return [...sharing];
  const named = namedCandidates(sharing, name).found;
  return named.length ? named : [...sharing];
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
  const one = (ids: string[], how: string): string | undefined => {
    const distinct = [...new Set(ids)];
    if (distinct.length > 1) throw new RuleError("ambiguous_model", `${model} names more than one model in the pool; use its exact id`, 400);
    return distinct[0];
  };
  // (a): the id written exactly, else the one id equal in any letter case;
  // two ids differing only in case, neither written exactly, are refused.
  if (pool.some((m) => m.id === model)) return model;
  const exact = one(pool.filter((m) => m.id.toLowerCase() === lower).map((m) => m.id), "is");
  if (exact) return exact;
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
