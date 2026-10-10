import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "refresh-failed",
  forms: [
    {
      group: "Agents", line: 4, slot: 60,
      form: "refresh-failed ID --main-head SHA --reason TEXT [--kind conflict|checks]",
      about: "The integrator reports a refresh that conflicted or failed the plan's checks, after rolling the branch back. It is recorded on the plan with the reason and charges no part's builder; the tick does not try it again for that main head.",
    },
  ],
  flags: { "main-head": false, reason: false, kind: false },
  help: {
    flags: {
      "--main-head SHA": "the full hash of the main head the refresh tried to merge; required",
      "--reason TEXT": "why the refresh failed; shown on plan show",
      "--kind conflict|checks": "a merge conflict or failing checks",
    },
    example: 'atelier refresh-failed t3 --main-head 0123456789abcdef0123456789abcdef01234567 --reason "Conflict in docs/a.md" --kind conflict --project demo',
  },
};

export default spec;
