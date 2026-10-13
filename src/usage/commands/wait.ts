import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "wait",
  forms: [{ group: "Items", line: 2, slot: 25, form: "wait ID [--for merged|submitted|reviewed|any-change] [--timeout SECONDS] [--interval SECONDS]", about: "Blocks until the task reaches that state, or fails, and prints the outcome as one line; the default is `merged`. `merged` waits for the merge, `submitted` for the submission (a task already further on counts), `reviewed` for a review recorded at the task's current head and acceptance criteria (an approval is reached, a rejection fails), and `any-change` for the task's state, head, holder or review count to differ from the first read. A task that is abandoned or blocked fails every wait but `any-change`. It polls every 5 seconds and rides through a server that is briefly unreachable. Exit status: 0 reached, 1 failed, 3 gave up at `--timeout` (no limit by default), 4 the task could not be read. It replaces a hand-written `pgrep` or `lsof` loop, which matches its own command line and misses a death." }],
  flags: { for: false, timeout: false, interval: false },
  help: {
    flags: {
      "--for STATE": "merged (the default), submitted, reviewed or any-change",
      "--timeout SECONDS": "gives up after this long, exit status 3; with no limit by default",
      "--interval SECONDS": "how often it reads the task; 5 by default",
    },
    example: "atelier wait t3 --for reviewed --project demo",
  },
};

export default spec;
