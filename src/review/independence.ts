// Who an automatic review must be independent of. The gate in src/rules.ts
// treats every holder and push actor of an item, and its current owner, as a
// contributor: pushActors() records the actor of each claim, both sides of
// each handoff, and each push. A review counts only when it is independent of
// all of them. Automatic review asks the most the gate ever asks: a model
// whose family is recognised from its name and differs from every
// contributor's, which also satisfies the gate's weaker rules (a different
// model, or a different agent).

import { familyOf, type PoolFamily } from "../models/pool.ts";
import { modelOf, type Item } from "../rules.ts";

export function contributorsOf(item: Pick<Item, "owner" | "pushActors">): string[] {
  return [...new Set([...(item.pushActors ?? []), ...(item.owner ? [item.owner] : [])])];
}

// The family the gate reads from an actor: its model's name, never the
// harness and never a family an owner typed into the pool.
export const actorFamily = (actor: string): PoolFamily => familyOf(modelOf(actor));

export const describeContributors = (contributors: readonly string[]): string =>
  contributors.map((c) => `${c} (${actorFamily(c)})`).join(", ");

// Null when `actor` is of a recognised family that no contributor shares;
// otherwise the rule it fails. A contributor of unrecognised family fails
// every reviewer, because the gate cannot count any family as different
// from one it does not recognise.
export function familyRefusal(actor: string, contributors: readonly string[]): string | null {
  const unknown = contributors.find((c) => actorFamily(c) === "other");
  if (unknown) return `contributor ${unknown}'s family is not recognised from its name`;
  const family = actorFamily(actor);
  if (family === "other") return "family not recognised from its name";
  const same = contributors.find((c) => actorFamily(c) === family);
  return same ? `same family as contributor ${same} (${family})` : null;
}
