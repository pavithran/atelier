import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "decide",
  forms: [
    {
      group: "Developer", line: 4, slot: 10,
      form: "decide \"text\" --quote \"developer's words\" [--project P] [--as H/M]",
      about: "The developer records a standing decision for the project, dated, with their own words it rests on: another company reviews everywhere, the review bar, a spend limit, no overrides. Only the developer's token records one; `--as` names the harness/model recording it for the developer, kept beside them. Every review brief of the project and `atelier guide --role orchestrate` carry the decisions that stand, marked as decisions a reviewer must not overrule.",
    },
  ],
  flags: {
    quote: "--quote needs the developer's words: atelier decide \"text\" --quote \"what the developer said\"",
  },
  help: {
    flags: {
      "--quote TEXT": "the developer's own words the decision rests on; required, at most 2000 characters",
      "--project NAME": "the project the decision is for; this checkout's or workspace's project unless given",
      "--as H/M": "the harness/model recording the decision for the developer, kept beside them as its acting model",
    },
    example: 'atelier decide "Every change is reviewed by a model of another company" --quote "another company reviews everywhere" --project demo',
  },
};

export default spec;
