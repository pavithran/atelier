import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "submit",
  forms: [
    {
      group: "Agents", line: 2, slot: 70,
      form: "submit [--summary T]",
      about: "Marks the task ready for the owner and prints what still blocks it, if anything. `--summary` stores a summary of the change with the submission.",
    },
  ],
  flags: {
    summary: '--summary needs text: atelier submit ID --summary "TEXT"',
  },
  help: {
    flags: {
      "--summary TEXT": "a summary of the change, stored with the submission",
    },
    example: 'atelier submit --summary "The parser takes the new form"',
  },
};

export default spec;
