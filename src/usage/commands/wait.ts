import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "wait",
  forms: [
    { group: "Items", line: 2, slot: 25, form: "wait ID [--for merged|submitted|reviewed|any-change|answered|STAGE] [--timeout SECONDS] [--interval SECONDS] [--json]", about: "Blocks until the task reaches that state, or fails, and prints the outcome as one line; the default is `merged`. `merged` waits for the merge, `submitted` for the submission (a task already further on counts), `reviewed` for a review recorded at the task's current head and acceptance criteria (an approval is reached, a rejection fails), `any-change` for the task's state, head, holder or review count to differ from the first read, `answered` for every review request of the task to be answered, and a stage (filed, agreed, queued, building, built, checked, reviewed, landable, landed, shipped) for the task's recorded stage to reach it. A condition already met returns at once. It reads every 5 seconds, holds no lock, and rides through a server restart, reading again once it is back. Exit status: 0 met, 1 it cannot be met (a rejection, a block), 3 gave up at `--timeout` (no limit by default), 4 a task was abandoned (the line names it), 5 the server could not be read. Use it instead of a `sleep` loop or a hand-written `pgrep` or `lsof` loop, which matches its own command line and misses a death." },
    { group: "Items", line: 2, slot: 26, form: "wait --all tA,tB | --any tA,tB [--for merged|submitted|accepted|answered|STAGE] [--timeout SECONDS]", about: "Waits on several tasks at once: `--all` until every one reaches the state or stage, `--any` until one does; `--for answered` until their review requests are answered. A task abandoned before the condition is met ends the wait with exit status 4, naming it." },
    { group: "Items", line: 2, slot: 27, form: "wait --runner home:NAME --silent MINUTES [--timeout SECONDS]", about: "Waits until the runner's last poll is at least MINUTES old (or it never polled), as `atelier situation` reads it." },
  ],
  flags: { for: false, timeout: false, interval: false, all: false, any: false, runner: false, silent: false, json: true },
  help: {
    flags: {
      "--for STATE": "merged (the default), submitted, accepted, reviewed, any-change, answered, or a stage such as checked or landable",
      "--all tA,tB": "every one of these tasks",
      "--any tA,tB": "one of these tasks",
      "--runner home:NAME": "the runner whose silence is waited for, with --silent",
      "--silent MINUTES": "how long the runner's last poll must be past",
      "--timeout SECONDS": "gives up after this long, exit status 3; with no limit by default",
      "--interval SECONDS": "how often it reads; 5 by default",
      "--json": "the outcome as one JSON object: {code: \"met\", detail} on stdout, or {code, detail, next} on stderr with the same exit status (timed_out, abandoned, unmet, unreadable)",
    },
    example: "atelier wait --all t3,t4 --for merged --timeout 3600 --project demo",
  },
};

export default spec;
