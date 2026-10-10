import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "new",
  forms: [
    {
      group: "Items", line: 1, slot: 10,
      form: 'new "short title" [--brief TEXT] [--accept TEXT]... [--scope GLOB]... [--non-goal TEXT]... [--stop-when TEXT]... [--next-gate TEXT]',
      about: "The project owner creates a task with a short title (at most 80 characters, what every list shows), and optionally its brief (the whole task, shown on its page and given to the agents that build and review it), its acceptance criteria (a change that fails one is rejected in review), the globs it intends to touch, what it is not to do, what tells its holder to stop and ask, and the gate it goes to next. A task filed without criteria is created with a warning, since a review would have none to judge its change against; a project that requires criteria (`init --require-criteria`) refuses it. One long text with no --brief is kept as the brief, and the title is derived from its first clause. The brief, `atelier start` and the task's page show them.",
    },
  ],
  flags: {
    scope: '--scope needs text: atelier new --scope "TEXT", once per entry',
    brief: '--brief needs text: atelier new "short title" --brief "TEXT"',
    accept: '--accept needs text: atelier new --accept "TEXT", once per criterion',
    "non-goal": '--non-goal needs text: atelier new --non-goal "TEXT", once per entry',
    "stop-when": '--stop-when needs text: atelier new --stop-when "TEXT", once per entry',
    "next-gate": '--next-gate needs text: atelier new --next-gate "TEXT"',
  },
  help: {
    flags: {
      "--brief TEXT": "the whole task, shown on its page and given to the agents that build and review it",
      "--accept TEXT": "an acceptance criterion, at most 300 characters; once per criterion, at most 12",
      "--scope GLOB": "a path pattern the task intends to touch; once per pattern",
      "--non-goal TEXT": "something the task is not to do; once per entry",
      "--stop-when TEXT": "what tells the holder to stop and ask; once per entry",
      "--next-gate TEXT": "the gate the task goes to next",
    },
    example: 'atelier new "Fix the parser" --brief "Nested lists fail to parse; make them parse" --accept "A nested list parses" --scope "src/parser/**" --project demo',
  },
};

export default spec;
