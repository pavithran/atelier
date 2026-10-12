import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "refreshed",
  capabilities: ["plans.integration.v1"],
  forms: [
    {
      group: "Agents", line: 4, slot: 50,
      form: "refreshed ID --main-head SHA [--merge-commit SHA]",
      about: "The integrator reports a refresh: main's head, the one the refresh job names, merged into the plan's branch. The server checks the merge commit against the branch before recording it, and it becomes the commit later parts fork from and later integrations build on. Without `--merge-commit` the branch already held main's head, which the server checks.",
    },
    {
      group: "Agents", line: 4, slot: 51,
      form: "refreshed ID --lease ID --main-head SHA --expected-head SHA [--head SHA] [--diff-before ID --diff-after ID] [--transformations LIST]",
      about: "A task refresh's leaseholder reports the merge it pushed (t462): the server checks it is the fork's head, with the head the lease found and main's head as its parents, and that its Agent line names who made it: the integrator for a clean merge, or the resolver for a resolved one, who joins the task's contributors. The task's head becomes the merge; an accepted task goes back to submitted, and the new head needs its own review. Without `--head` the task's head already held main. A repeated report answers the recorded outcome.",
    },
  ],
  flags: { "main-head": false, "merge-commit": false, lease: false, "expected-head": false, head: false, "diff-before": false, "diff-after": false, transformations: false },
  help: {
    flags: {
      "--main-head SHA": "the full hash of the main head the refresh merged; required",
      "--merge-commit SHA": "the full hash of the merge commit on the plan's branch; left out when the branch already held main's head",
      "--lease ID": "a task refresh's lease, which refresh-lease gave",
      "--expected-head SHA": "the task's head the lease found",
      "--head SHA": "the refreshed merge pushed to the task's fork; left out when the task already held main",
      "--diff-before ID": "the patch id of the task's own diff before the refresh",
      "--diff-after ID": "the patch id of the task's own diff against main after it",
      "--transformations LIST": "the mechanical transformations a resolver's merge applied, comma-separated",
    },
    example: "atelier refreshed t3 --main-head 0123456789abcdef0123456789abcdef01234567 --merge-commit 89abcdef0123456789abcdef0123456789abcdef --project demo",
  },
};

export default spec;
