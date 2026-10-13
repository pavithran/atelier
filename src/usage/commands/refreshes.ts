import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "refreshes",
  capabilities: ["refresh.tasks.v1"],
  forms: [
    {
      group: "Owner", line: 5, slot: 10,
      form: "refreshes [--enqueue] [--json]",
      about: "Lists the tasks queued to take main as it moves (t462): every unfinished task outside a plan with a branch of its own (open after a release, submitted or accepted), with the main head it should take, what its refresh is doing, and, for a busy or blocked task, why its refresh waits: a builder holds it, it is blocked, a runner is about to rebuild it, a review of its head is under way, or it is landing. A task with no commits of its own is not listed, since a claim starts it from main as main is then. A recorded merge queues the refreshes; `--enqueue` reads main's head now and queues it, for main moved outside Atelier. The integrator's runner (atelier runner --integrate) merges each in a workspace of its own; a mechanical conflict goes to a resolver (atelier init --resolver), any other back to the builder with the merge base, both heads, the paths and the hunks.",
    },
  ],
  flags: { enqueue: true, json: true },
  help: {
    flags: {
      "--enqueue": "reads main's head now and queues it for every task that should take it",
      "--json": "prints the queue as the server answers it",
    },
    example: "atelier refreshes --project demo",
  },
};

export default spec;
