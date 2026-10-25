import type { LedgerEvent, ProjectRecord } from "../ledger.ts";
import type { RunReport } from "./reliability.ts";
import { summarize, type ReviewerRecords, type SuggestionRecords } from "./suggest.ts";

// Read all pages; a truncated history could forget a stalled-build exclusion.
export async function suggestionRecords(
  index: { projects(): Promise<ProjectRecord[]>; runs(limit?: number): Promise<RunReport[]> },
  ledger: (project: ProjectRecord) => { events(id?: string, limit?: number, before?: number): Promise<LedgerEvent[]> },
): Promise<SuggestionRecords> {
  const [projects, runs] = await Promise.all([index.projects(), index.runs(Number.MAX_SAFE_INTEGER)]);
  const sources = await Promise.all(projects.map(async (project) => {
    const events: LedgerEvent[] = [];
    let before: number | undefined;
    for (;;) {
      const page = await ledger(project).events(undefined, 1000, before);
      events.push(...page);
      if (page.length < 1000) break;
      before = page[page.length - 1].seq;
    }
    return { project: project.key ?? project.name, events };
  }));
  return { sources, runs };
}

// What a review request without a named reviewer sends the ledger: the
// summary of the model records, not the events they came from.
export async function reviewerRecords(
  index: Parameters<typeof suggestionRecords>[0],
  ledger: Parameters<typeof suggestionRecords>[1],
  owner: string,
  now = new Date(),
): Promise<ReviewerRecords> {
  return { summary: summarize(await suggestionRecords(index, ledger), owner, now) };
}
