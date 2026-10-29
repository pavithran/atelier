import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "forget-skip",
  forms: [
    {
      group: "Developer", line: 1, slot: 56,
      form: "forget-skip ID [--runner home:NAME] [--project NAME]",
      aside: "clear what a runner remembers of a task",
      about: "Clears what a runner (every runner without `--runner`) remembers of a task: a skip after failed runs, a refused claim, a failure count, a wait. The server keeps these (they go with each poll and come back after a restart), and the runner drops them when it next reads its record, then takes the task again if it is still offered. A task nothing is remembered of is not an error: the command says so and exits 0.",
    },
  ],
  flags: { runner: false },
  help: {
    flags: {
      "--runner home:NAME": "the runner that forgets the task's skip; every runner when absent",
    },
    example: "ATELIER_ACTING=claude-code/opus-5.5 atelier forget-skip t13 --runner home:studio --project demo",
  },
};

export default spec;
