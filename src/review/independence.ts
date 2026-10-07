// Who an automatic review must be independent of, and how. The gate in
// src/rules.ts treats every holder and push actor of an item, and its current
// owner, as a contributor: pushActors() records the actor of each claim, both
// sides of each handoff, and each push. Automatic review asks of every part
// what the gate asks of a protected change in every project: a model whose
// family is recognised from its name and differs from every contributor's,
// which also satisfies the gate's rule for a coordinated change (any other
// agent). The rules themselves live in src/rules.ts, beside the gate, so the
// two can never ask different things; this module adds the wording the
// reviewer picker shows.

import { actorFamily, contributorsOf, familyRefusal, sameActor } from "../rules.ts";

export { actorFamily, contributorsOf, familyRefusal };

export const describeContributors = (contributors: readonly string[]): string =>
  contributors.map((c) => `${c} (${actorFamily(c)})`).join(", ");

// Why `reviewer` cannot give an item the independent review its contributors
// need: it is one of them, or its family is not recognised as another than
// every contributor's. Null when it can. The plan tick asks this of a part's
// routed reviewer and of each live request, since a reviewer routed at
// approval or asked earlier may have claimed or pushed to the part since.
export function independenceRefusal(reviewer: string, contributors: readonly string[]): string | null {
  if (contributors.some((c) => sameActor(c, reviewer))) return `${reviewer} contributed to it, and nobody reviews their own work`;
  const family = familyRefusal(reviewer, contributors);
  return family ? `${reviewer} is not of another family than every contributor: ${family}` : null;
}
