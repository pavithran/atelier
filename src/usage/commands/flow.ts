import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "flow",
  forms: [
    { group: "Developer", line: 2, slot: 6, form: "flow [--project P] [--since T] [--json]", about: "Prints a short scorecard: tasks merged, median filing-to-merge minutes, median review rounds per task, rejection rate and known time shares including criteria review. Reads existing events without storing state. Definitions and unknown phases are in docs/flow.md." },
    { group: "Developer", line: 2, slot: 6, form: "flow --bars [--project P] [--tokens FILE] [--json]", about: "Prints the redesign's bars for the last 7 days, per project and overall: each with its value, target, pass or fail and the events it came from." },
  ],
  flags: { json: true, since: false, bars: true, tokens: false },
  help: {
    flags: {
      "--project P": "developer-only read-only report for this project (defaults to the checkout's project)",
      "--since T": "reports the tasks created at or after T, an ISO date or time (2026-10-10, 2026-10-10T08:00Z) or a span back from now (3d, 12h); default 7d",
      "--bars": "reports the redesign's bars (weighted tokens per sound merge, filed to deployed, red merges, escapes, live rows with no named wait, unlinked repairs, session records per merge) instead of the scorecard; every project unless --project names one",
      "--tokens FILE": "with --bars, a JSON object of item id (or project/id) to weighted Claude tokens; the ledger records none, so without it that bar is unmeasured",
      "--json": "prints every task's phases in milliseconds with their unknown and open marks, the totals, rates, medians and phase shares",
    },
    example: "atelier flow --project demo --since 3d",
  },
};

export default spec;
