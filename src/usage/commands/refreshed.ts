import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "refreshed",
  forms: [
    {
      group: "Agents", line: 4, slot: 50,
      form: "refreshed ID --main-head SHA [--merge-commit SHA]",
      about: "The integrator reports a refresh: main's head, the one the refresh job names, merged into the plan's branch. The server checks the merge commit against the branch before recording it, and it becomes the commit later parts fork from and later integrations build on. Without `--merge-commit` the branch already held main's head, which the server checks.",
    },
  ],
  flags: { "main-head": false, "merge-commit": false },
  help: {
    flags: {
      "--main-head SHA": "the full hash of the main head the refresh merged; required",
      "--merge-commit SHA": "the full hash of the merge commit on the plan's branch; left out when the branch already held main's head",
    },
    example: "atelier refreshed t3 --main-head 0123456789abcdef0123456789abcdef01234567 --merge-commit 89abcdef0123456789abcdef0123456789abcdef --project demo",
  },
};

export default spec;
