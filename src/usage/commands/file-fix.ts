import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "file-fix",
  forms: [
    {
      group: "Models", line: 2, slot: 40,
      form: "file-fix ID --from-note N [--project P] [--as H/M]",
      about: "Files a task from note N on the task's goal, as `atelier show ID` numbers the notes: a review's follow-up, or a blocking finding of a post-merge review. The server files no task by itself; the new task's brief and criterion are the note. A note already filed answers the task filed from it, so filing it twice makes one task.",
    },
  ],
  flags: { "from-note": "--from-note names the note by its number: atelier file-fix ID --from-note N" },
  help: {
    flags: { "--from-note N": "the note's number, as atelier show ID lists the notes" },
    example: "ATELIER_ACTING=claude-code/opus-5.5 atelier file-fix t3 --from-note 2 --project demo",
  },
};

export default spec;
