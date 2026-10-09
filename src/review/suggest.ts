// The ledger calls reviewer suggestion here so model ranking does not depend
// on review execution or independence rules.
import { RuleError } from "../rules.ts";
import { buildPrecision, precisionWindow } from "../models/precision.ts";
import { frontier, ranked, sensitive, type SuggestionInput } from "../models/suggest.ts";
import type { Choice } from "../plans/route.ts";
import { pickReviewer } from "./reviewer.ts";

const actorOf = (m: SuggestionInput["pool"][number]) => `${m.harness}/${m.id}`;

export interface ReviewerSuggestionInput extends SuggestionInput {
  previous?: string | null;          // the reviewer of the last rejected round, asked first
  tier?: readonly string[];          // the project's review tier, asked next for a protected change
}

export function suggestReviewer(input: ReviewerSuggestionInput, avoid: readonly { actor: string; reason: string }[] = [], now = new Date()): Choice {
  const strict = input.frontierRequired === true || sensitive(input.item);
  const ordered = ranked(input).filter(({ entry }) => !strict || frontier(entry));
  const precision = buildPrecision(input.sources, precisionWindow(now), input.owner);
  const pick = pickReviewer({ item: input.item, pool: ordered.map((r) => r.entry), policy: input.policy,
    allowPaid: false, owner: input.owner, avoid, precision, previous: input.previous ?? null, tier: input.tier,
    // Preserve outcome order between equal precision terms.
    recordOrder: ordered.map(({ entry }) => actorOf(entry)),
  });
  if (!pick.reviewer) throw new RuleError("no_reviewer", `${strict ? "Security, concurrency or gate work requires a frontier reviewer. " : ""}${pick.unpicked}`, 409);
  const row = ordered.find(({ entry }) => actorOf(entry) === pick.reviewer!.actor)!;
  return { actor: pick.reviewer.actor, reasons: [strict ? "Frontier reviewer required for security, concurrency or gate work." : "Reviewer ranked by finding precision, then recorded outcomes.", row.reason, ...pick.reviewer.reasons] };
}
