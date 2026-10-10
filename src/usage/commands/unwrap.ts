import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "unwrap",
  forms: [
    {
      group: "Sessions", line: 1, slot: 10,
      form: "unwrap [--project P]",
      about: "Reads where the project stands, the state of this checkout, where its branch stands against each of the checkout's remotes as last fetched or pushed, the newest session note, the state file (the first of `docs/STATE.md`, `STATE.md` and `PROJECT.md` that exists) and any dated handoffs. It fetches and writes nothing. The project owner's session starts here.",
    },
  ],
  flags: {},
  help: {
    example: "atelier unwrap --project demo",
  },
};

export default spec;
