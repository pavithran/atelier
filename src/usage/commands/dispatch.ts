import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "dispatch",
  forms: [
    {
      group: "Models", line: 2, slot: 10,
      form: "dispatch ID [--to home|cloud|any] [--agent A] [--model M] [--note T] [--job merge-main [--head H]] [--overlap-ok]",
      about: "Queues an open task for a kind of runner, and optionally an agent and model, instead of waiting for an agent to choose it; a held or accepted task is released and queued in the same step, keeping its workspace, commits, reviews and acceptance history. An accepted task must be submitted and accepted again; a merge holding its landing lease must finish or be cancelled first. While the task's scope overlaps, within one of the project's core files (`init --core`), the scope of a live item, the queue holds it and offers it to no runner until that item merges or is abandoned; `atelier status` and `atelier queue` say which item it waits on, and `--overlap-ok` lets this dispatch through at once. `--job merge-main` sends a task whose landing conflicted with main back to its builder: the runner fetches and merges the baseline's current main head at claim time into its workspace (`--head` records dispatch context, not the merge target) and leaves the conflicts for the builder to resolve and commit; then `atelier land ID` again. Project owner only.",
    },
  ],
  flags: { to: false, agent: false, model: false, note: false, job: false, head: false, "overlap-ok": true },
  help: {
    flags: {
      "--to home|cloud|any": "the kind of runner; any unless given",
      "--agent A": "the agent the runner must run; unless given, the server suggests a builder from the model pool and the models' records and prints which and why",
      "--model M": "the model the runner must use",
      "--note TEXT": "a note the agent reads with the task",
      "--job merge-main": "sends the task to its builder to merge main into its workspace and resolve the conflicts of a landing that stopped on them",
      "--head H": "with --job merge-main, the full hash recorded as dispatch context; defaults to main's head as the baseline holds it at dispatch. It does not pin the merge target: the runner fetches and merges the baseline's current main head at claim time",
      "--overlap-ok": "offers the dispatch to a runner although its scope overlaps a live item's within a core file; kept with this dispatch only",
    },
    example: 'atelier dispatch t3 --to home --agent codex --note "Keep it small" --project demo',
  },
};

export default spec;
