import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "dispatch",
  forms: [
    {
      group: "Models", line: 2, slot: 10,
      form: "dispatch ID [--to home|cloud|any] [--agent A] [--model M] [--note T | --note-file PATH] [--job merge-main [--head H]] [--overlap-ok] [--release] [--reviewer H/M] [--land]",
      about: "Queues an open task for a kind of runner, and optionally an agent and model, instead of waiting for an agent to choose it; a submitted or accepted task is released and queued in the same step, keeping its workspace, commits, reviews and acceptance history. An accepted task must be submitted and accepted again; a merge holding its landing lease must finish or be cancelled first. While the task's scope overlaps, within one of the project's core files (`init --core`), the scope of an item that was claimed and has not merged or been abandoned (it still holds once submitted, accepted, rejected or blocked), the queue holds it and offers it to no runner until each such blocker merges or is abandoned; `atelier status` and `atelier queue` name every item it waits on, and `--overlap-ok` lets this dispatch through at once. `--job merge-main` sends a task whose landing conflicted with main back to its builder: the runner fetches and merges the baseline's current main head at claim time into its workspace (`--head` records dispatch context, not the merge target) and leaves the conflicts for the builder to resolve and commit; then `atelier land ID` again. A task a builder holds live (claimed) is refused, naming the holder and when they claimed it, unless `--release` is given; `--release` ends that claim, says whose, and tells the holder at its next push or finish that the task was taken back. Without both `--agent` and `--model` the server names no builder: it prints every candidate with its reliability line, and each a gate filter refuses with why, and refuses. Developer only.",
    },
  ],
  flags: { reviewer: false, land: true, to: false, agent: false, model: false, note: false, "note-file": false, job: false, head: false, "overlap-ok": true, release: true },
  help: {
    flags: {
      "--reviewer H/M": "records the developer’s reviewer; submit asks that review using the current gate and independence checks",
      "--land": "records intent to queue landing on submit; requires --reviewer or the project’s review-on-checked mapping for the named builder",
      "--to home|cloud|any": "the kind of runner; any unless given",
      "--agent A": 'the agent the runner must run, with --model; without both, the dispatch is refused with the candidates and their reliability lines, except when --overlap-ok updates an existing dispatch',
      "--model M": 'the model the runner must use, with --agent',
      "--note TEXT": "a note the agent reads with the task, up to 2000 characters (UTF-16 code units); a longer note is refused, never cut",
      "--note-file PATH": "the note is the text of the UTF-8 file at PATH, read relative to the current directory with its line breaks kept; not with --note; an unreadable or non-UTF-8 file is refused before anything is sent, and an empty file is an empty note",
      "--job merge-main": "sends the task to its builder to merge main into its workspace and resolve the conflicts of a landing that stopped on them",
      "--head H": "with --job merge-main, the full hash recorded as dispatch context; defaults to main's head as the baseline holds it at dispatch. It does not pin the merge target: the runner fetches and merges the baseline's current main head at claim time",
      "--release": "takes a task a builder holds live (claimed): releases that claim, then queues the task as usual; without it the dispatch is refused and nothing changes",
      "--overlap-ok": "records a core-file hold override and names the hold released, if any; preserves omitted fields of an existing dispatch without suggesting a builder. Does not bypass refuseOverlap; kept with this dispatch only",
    },
    example: 'ATELIER_ACTING=claude-code/opus-5.5 atelier dispatch t3 --to home --agent codex --model gpt-6 --note "Keep it small" --project demo',
  },
};

export default spec;
