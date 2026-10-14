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

import { RuleError } from "../rules.ts";
import type { ModelEntry } from "./pool.ts";

// The entry an exact harness/id is, or undefined.
export function exactEntry<E extends Pick<ModelEntry, "id" | "harness">>(pool: readonly E[], actor: string): E | undefined {
  const lower = actor.toLowerCase();
  return pool.find((m) => `${m.harness}/${m.id}`.toLowerCase() === lower);
}

// Where a person types a harness/model: the entry whose id it is, else the
// one entry in its harness that lists it as an alias; undefined when none
// does, and refused when two do.
export function entryNamed<E extends Pick<ModelEntry, "id" | "harness" | "aliases">>(pool: readonly E[], name: string): E | undefined {
  const exact = exactEntry(pool, name);
  if (exact) return exact;
  const lower = name.toLowerCase();
  const by = pool.filter((m) => m.aliases.some((alias) => `${m.harness}/${alias}`.toLowerCase() === lower));
  if (by.length > 1) throw new RuleError("ambiguous_model", `${name} is an alias of ${by.map((m) => `${m.harness}/${m.id}`).join(" and ")}; name one by its id`, 400);
  return by[0];
}

// The exact harness/id a typed name stands for, or the name as typed when
// no pool entry is it (a model outside the pool, which some places allow).
export function typedActor(pool: readonly Pick<ModelEntry, "id" | "harness" | "aliases">[], name: string): string {
  const entry = entryNamed(pool, name);
  return entry ? `${entry.harness}/${entry.id}` : name;
}

// A bare model a person types (dispatch --model without --agent): the id
// itself when an entry has it, else the id of the one entry listing it as
// an alias; refused when aliases of two different ids.
export function typedModel(pool: readonly Pick<ModelEntry, "id" | "harness" | "aliases">[], model: string): string {
  const lower = model.toLowerCase();
  if (pool.some((m) => m.id.toLowerCase() === lower)) return model;
  const ids = [...new Set(pool.filter((m) => m.aliases.some((a) => a.toLowerCase() === lower)).map((m) => m.id))];
  if (ids.length > 1) throw new RuleError("ambiguous_model", `${model} is an alias of ${ids.join(" and ")}; name one by its id`, 400);
  return ids[0] ?? model;
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
