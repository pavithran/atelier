import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "unwrap",
  forms: [
    {
      group: "Sessions", line: 1, slot: 10,
      form: "unwrap [--project P] [--all-runners]",
      about: "Reads where the project stands, its standing models plan (or the builders and reviewers recorded on its five most recently updated tasks), each vendor's percent left and next reset (or why no figure exists), warnings with suggested builders and reviewers from another company than every contributor, the state of this checkout, where its branch stands against each of the checkout's remotes as last fetched or pushed, the newest session note, the state file (the first of `docs/STATE.md`, `STATE.md` and `PROJECT.md` that exists) and any dated handoffs. It fetches and writes nothing. The developer's session starts here.",
    },
  ],
  flags: { "all-runners": true },
  help: {
    flags: { "--all-runners": "lists every recorded runner with readiness; otherwise only live runners are listed, with a count of those not live" },
    example: "atelier unwrap --project demo",
  },
};

export default spec;
