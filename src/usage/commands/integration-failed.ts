import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "integration-failed",
  forms: [
    {
      group: "Agents", line: 4, slot: 40,
      form: "integration-failed ID --part KEY --reason TEXT [--kind conflict|checks]",
      about: "The integrator reports a failed merge, which sends the part back to its builder for rework with the reason. `--kind` says the failure was the part's own, a merge conflict or failing checks, which charges its builder an attempt; without it the builder is charged nothing.",
    },
  ],
  flags: { part: false, reason: false, kind: false },
  help: {
    flags: {
      "--part KEY": "the part whose merge failed; required",
      "--reason TEXT": "why the merge failed; sent to the part's builder with the rework",
      "--kind conflict|checks": "the part's own failure, a merge conflict or failing checks, which charges its builder an attempt",
    },
    example: 'atelier integration-failed t3 --part t4 --reason "Conflict in src/api.ts" --project demo',
  },
};

export default spec;
