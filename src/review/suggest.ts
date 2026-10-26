// The ledger calls reviewer suggestion here so model ranking does not depend
// on review execution or independence rules.
import { RuleError } from "../rules.ts";
import { latestNote, noteLine } from "../models/pool.ts";
import { frontier, precisionOfSummary, ranked, sensitive, summarize, type RecordSummary, type SuggestionInput } from "../models/suggest.ts";
import type { Choice } from "../plans/route.ts";
import { pickReviewer } from "./reviewer.ts";
import type { Assignment } from "../models/assignments.ts";

const actorOf = (m: SuggestionInput["pool"][number]) => `${m.harness}/${m.id}`;

// The records come as the summary the Worker built (src/models/suggest.ts) or,
// for a caller that holds them, as the sources and runs themselves.
export interface ReviewerSuggestionInput extends Omit<SuggestionInput, "sources" | "runs"> {
  summary?: RecordSummary;
  sources?: SuggestionInput["sources"];
  runs?: SuggestionInput["runs"];
  previous?: string | null;          // the reviewer of the last rejected round, asked first
  sameFamilyOk?: boolean;            // a post-merge review of a task merged in fast mode (t300)
  // The review assignments bearing on this review, as the ledger decided
  // them (reviewAssigned, by reviewRolesFor): the suggestion orders by them
  // and decides no roles itself (gpt-6-astra's twenty-second review of
  // t622). `assignments` (the build roles') is not read here.
  assigned?: readonly Assignment[];
  tier?: readonly string[];          // the project's review tier, asked next for a protected change
  counted?: readonly string[];       // models whose approval of this head already counts; none is asked again (t143)
  destination?: (entry: SuggestionInput["pool"][number]) => "home" | "cloud";  // where the ledger sends the review
}

export function suggestReviewer(input: ReviewerSuggestionInput, avoid: readonly { actor: string; reason: string }[] = [], now = new Date()): Choice {
  const strict = input.frontierRequired === true || sensitive(input.item);
  const summary = input.summary ?? summarize({ sources: input.sources ?? [], runs: input.runs ?? [] }, input.owner, now);
  const ordered = ranked({ pool: input.pool, summary }).filter(({ entry }) => !strict || frontier(entry));
  const precision = precisionOfSummary(summary);
  const pick = pickReviewer({ item: input.item, pool: ordered.map((r) => r.entry), policy: input.policy,
    allowPaid: false, owner: input.owner, avoid, counted: input.counted, precision, previous: input.previous ?? null, tier: input.tier,
    offers: input.offers, destination: input.destination, sameFamilyOk: input.sameFamilyOk,
    assigned: input.assigned ?? [],
    // Preserve outcome order between equal precision terms.
    recordOrder: ordered.map(({ entry }) => actorOf(entry)),
  });
  if (!pick.reviewer) throw new RuleError("no_reviewer", `${strict ? "Security, concurrency or gate work requires a frontier reviewer. " : ""}${pick.unpicked}`, 409);
  const row = ordered.find(({ entry }) => actorOf(entry) === pick.reviewer!.actor)!;
  const note = latestNote(row.entry, input.project, input.item.id);
  return { actor: pick.reviewer.actor, reasons: [strict ? "Frontier reviewer required for security, concurrency or gate work." : "Reviewer ranked by finding precision, then recorded outcomes.", row.reason, ...(note ? [noteLine(note)] : []), ...pick.reviewer.reasons] };
}
