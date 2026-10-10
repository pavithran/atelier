import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "guide",
  forms: [
    {
      group: "Docs", line: 1, slot: 10,
      form: "guide [--role build|review|plan|orchestrate] [--full] [--project P]",
      aside: "paste into a project's AGENTS.md",
      about: "Prints the instructions an agent needs, to paste into a project's AGENTS.md or CLAUDE.md. `--role` prints the instructions for one role alone, from a project's `.atelier/prompts/ROLE.md` when it has one. `--role orchestrate` for a project ends with the owner's standing decisions (`atelier decide`), read from the server. `atelier adopt` inserts the plain guide.",
    },
  ],
  flags: {
    role: "--role needs a value: atelier guide --role build|review|plan|orchestrate",
    full: true,
  },
  help: {
    flags: {
      "--role build|review|plan|orchestrate": "prints the instructions for one role alone; a project's `.atelier/prompts/ROLE.md` overrides that role's text",
      "--full": "with --role orchestrate, prints the handbook itself, docs/orchestrating.md, instead of the role's instructions",
    },
    example: "atelier guide --role build",
  },
};

export default spec;
