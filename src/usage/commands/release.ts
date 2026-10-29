import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "release",
  forms: [
    {
      group: "Agents", line: 3, slot: 20,
      form: "release ID [--note TEXT] [--blocked TEXT]",
      about: "Gives the task up: it returns to open and the write token is revoked.",
    },
  ],
  flags: { note: false, blocked: false },
  help: {
    flags: {
      "--note TEXT": "why; kept with the release (from a runner, facts only)",
      "--blocked TEXT": "a validation_blocked build's report, the builder's words: blocks the task for the developer with it as the reason",
    },
    example: 'atelier release t3 --note "Blocked on the schema" --as claude-code/opus-5.5',
  },
};

export default spec;
