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

import { actorFamily, contributorsOf, familyRefusal } from "../rules.ts";

export { actorFamily, contributorsOf, familyRefusal };

export const describeContributors = (contributors: readonly string[]): string =>
  contributors.map((c) => `${c} (${actorFamily(c)})`).join(", ");
