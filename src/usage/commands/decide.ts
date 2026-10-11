import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "decide",
  forms: [
    {
      group: "Owner", line: 3, slot: 10,
      form: "decide \"text\" --quote \"owner's words\" [--project P]",
      about: "The project owner records a standing decision for the project, dated, with the owner's own words it rests on: another company reviews everywhere, the review bar, a spend limit, no overrides. Only the owner's token records one. Every review brief of the project and `atelier guide --role orchestrate` carry the decisions that stand, marked as decisions a reviewer must not overrule.",
    },
  ],
  flags: {
    quote: "--quote needs the owner's words: atelier decide \"text\" --quote \"what the owner said\"",
  },
  help: {
    flags: {
      "--quote TEXT": "the owner's own words the decision rests on; required, at most 2000 characters",
      "--project NAME": "the project the decision is for; this checkout's or workspace's project unless given",
    },
    example: 'atelier decide "Every change is reviewed by a model of another company" --quote "another company reviews everywhere" --project demo',
  },
};

export default spec;
