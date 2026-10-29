import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "integration-failed",
  capabilities: ["plans.integration.v1"],
  forms: [
    {
      group: "Agents", line: 5, slot: 40,
      form: "integration-failed ID --part KEY --reason TEXT [--kind conflict|checks]",
      about: "Run with the integrator's own `ATELIER_TOKEN` (the example reads it from `INTEGRATOR_TOKEN`), bound to `atelier/integrator`; the developer token cannot act as the integrator. The integrator reports a failed merge, which sends the part back to its builder for rework with the reason. `--kind` says the failure was the part's own, a merge conflict or failing checks, which charges its builder an attempt; without it the builder is charged nothing.",
    },
  ],
  flags: { part: false, reason: false, kind: false },
  help: {
    flags: {
      "--part KEY": "the part whose merge failed; required",
      "--reason TEXT": "why the merge failed; sent to the part's builder with the rework",
      "--kind conflict|checks": "the part's own failure, a merge conflict or failing checks, which charges its builder an attempt",
    },
    example: 'ATELIER_TOKEN="$INTEGRATOR_TOKEN" atelier integration-failed t3 --part t4 --reason "Conflict in src/api.ts" --project demo',
  },
};

export default spec;
