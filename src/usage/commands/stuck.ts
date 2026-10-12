import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "stuck",
  // The stuck report route (t441), which an older server answers 404.
  capabilities: ["projects.stuck.v1"],
  forms: [
    { group: "Owner", line: 2, slot: 5, form: "stuck [--project P] [--json] [--no-push-hours N] [--unanswered-hours N] [--lease-wait-minutes N] [--conflict-wait-minutes N] [--core-hold-minutes N] [--runner-poll-minutes N] [--review-answer-hours N]", about: "One read-only owner report of stuck tasks, lease waits, conflict pauses, confirmed orphan leases, runner give-ups, idle polls, claimed reviews and stale core holds; prints evidence and recovery commands without running them, and separately lists failed observed check commands in the preceding rolling day." },
  ],
  flags: { json: true, "no-push-hours": false, "unanswered-hours": false, "lease-wait-minutes": false, "conflict-wait-minutes": false, "core-hold-minutes": false, "runner-poll-minutes": false, "review-answer-hours": false },
  help: {
    flags: {
      "--project P": "owner-only read-only report for this project (defaults to the checkout's project); failed reads are unavailable, never empty evidence",
      "--json": "prints observation time, limits, evidence ages and links, recovery commands, unavailable sources and failed observed check commands in the preceding rolling day",
      "--no-push-hours N": "positive limit for claims; default 6 hours",
      "--unanswered-hours N": "positive limit for unanswered changes requests; default 24 hours",
      "--lease-wait-minutes N": "positive limit for lease-stage Workflows; default 30 minutes",
      "--conflict-wait-minutes N": "positive limit for Workflows paused at conflict; default 30 minutes; resolve and commit conflicts, then rerun land ID --workflow",
      "--core-hold-minutes N": "positive limit for core blockers since their current claim/handoff or later push; default 30 minutes; land the blocker (merge if already accepted) or dispatch the held task with --overlap-ok if harmless",
      "--runner-poll-minutes N": "positive idle-poll limit; default 5 minutes, plus one minute of offer timestamp coarsening; active jobs are excluded",
      "--review-answer-hours N": "positive limit for current claimed reviews; default 2 hours; a claim ages from when it began, not its last renewal; a re-claim after expiry starts a new claim",
    },
    example: "atelier stuck --project demo",
  },
};

export default spec;
