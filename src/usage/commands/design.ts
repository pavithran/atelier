import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "design",
  forms: [
    {
      group: "Developer", line: 4, slot: 17,
      form: "design NAME --planned N --quote \"developer's words\" [--project P] [--as H/M]",
      about: "The developer records how many tasks the design NAME plans, from 1 to 50, with the words that approved the plan. A plan the developer approves is filed whole the same day: until as many tasks name NAME (atelier edit --design NAME), in any state, as were planned, `atelier status` and `atelier stuck` show `Design NAME: K of N tasks filed`. A later count replaces the earlier one; lowering it with the developer's words clears the line.",
    },
  ],
  flags: {
    planned: "--planned needs the number of tasks the design plans: atelier design NAME --planned N --quote \"what the developer said\"",
    quote: "--quote needs the developer's words: atelier design NAME --planned N --quote \"what the developer said\"",
  },
  help: {
    flags: {
      "--planned N": "how many tasks the design plans, a whole number from 1 to 50",
      "--quote TEXT": "the developer's own words that approved the plan; required, at most 2000 characters",
      "--project NAME": "the project the design belongs to; this checkout's or workspace's project unless given",
      "--as H/M": "the harness/model recording the count for the developer, kept beside it as its acting model",
    },
    example: 'atelier design model-slate --planned 5 --quote "yes, file all five today" --project atelier',
  },
};

export default spec;
