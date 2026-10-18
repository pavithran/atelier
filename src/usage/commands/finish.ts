import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "finish",
  forms: [
    {
      group: "Agents", line: 2, slot: 20,
      form: "finish [--summary T]",
      about: "Run in the claimed workspace: pushes, runs the required checks and submits, only if they pass and the workspace has not changed meanwhile. `done` is `finish` with a required summary.",
    },
  ],
  flags: {
    summary: '--summary needs text: atelier finish ID --summary "TEXT"',
  },
  help: {
    flags: {
      "--summary TEXT": "a summary of the change, stored with the submission",
    },
    example: 'atelier finish --summary "The parser takes the new form"',
  },
  localCheck: true,
};

export default spec;
