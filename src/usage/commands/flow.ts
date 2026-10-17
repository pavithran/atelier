import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "flow",
  forms: [
    { group: "Developer", line: 2, slot: 6, form: "flow [--project P] [--since T] [--json]", about: "Reads where the time goes: the minutes each task spent waiting for a runner, building, checking, waiting for a review, waiting to be accepted, waiting to land and merging, summed and per task, with attempts per merge and the share of tasks that hit a conflict, a rejection or a failed check. Computed from the events the ledger already records; a phase the record does not bound is unknown, never guessed. The phases and their events are defined in docs/flow.md." },
  ],
  flags: { json: true, since: false },
  help: {
    flags: {
      "--project P": "developer-only read-only report for this project (defaults to the checkout's project)",
      "--since T": "reports the tasks created at or after T, an ISO date or time (2026-10-10, 2026-10-10T08:00Z) or a span back from now (3d, 12h); default 7d",
      "--json": "prints every task's phases in milliseconds with their unknown and open marks, the totals and the rates",
    },
    example: "atelier flow --project demo --since 3d",
  },
};

export default spec;
