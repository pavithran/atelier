import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "refresh-failed",
  capabilities: ["plans.integration.v1"],
  forms: [
    {
      group: "Agents", line: 4, slot: 60,
      form: "refresh-failed ID --main-head SHA --reason TEXT [--kind conflict|checks]",
      about: "The integrator reports a refresh that conflicted or failed the plan's checks, after rolling the branch back. It is recorded on the plan with the reason and charges no part's builder; the tick does not try it again for that main head.",
    },
    {
      group: "Agents", line: 4, slot: 61,
      form: "refresh-failed ID --lease ID --main-head SHA --expected-head SHA --outcome mechanical|returned|superseded [--report FILE] [--reason TEXT]",
      about: "A task refresh's leaseholder reports a refresh that left no new head (t462): its conflicts are all mechanical (a resolver is chosen, or the refresh waits for one and says why), or not (`returned`: back to the builder with the conflict report of merge base, both heads, the paths and the hunks, read from FILE), or the task moved under it (`superseded`: queued again). A repeated report answers the recorded outcome.",
    },
  ],
  flags: { "main-head": false, reason: false, kind: false, lease: false, "expected-head": false, outcome: false, report: false },
  help: {
    flags: {
      "--main-head SHA": "the full hash of the main head the refresh tried to merge; required",
      "--reason TEXT": "why the refresh failed; shown on plan show",
      "--kind conflict|checks": "a merge conflict or failing checks",
      "--lease ID": "a task refresh's lease, which refresh-lease gave",
      "--expected-head SHA": "the task's head the lease found",
      "--outcome mechanical|returned|superseded": "what ended a task's refresh",
      "--report FILE": "the conflict report, as JSON, for a returned or mechanical conflict",
    },
    example: 'atelier refresh-failed t3 --main-head 0123456789abcdef0123456789abcdef01234567 --reason "Conflict in docs/a.md" --kind conflict --project demo',
  },
};

export default spec;
