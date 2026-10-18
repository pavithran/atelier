import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "pull",
  forms: [
    {
      group: "Setup", line: 1, slot: 37,
      form: "pull",
      about: "Brings this Mac's checkout up to the project's baseline, which another Mac may have moved on: fetches the baseline's main and its receipts with a read token it mints and keeps nowhere, with every Git hook off, merges the receipts on `refs/notes/atelier` into the checkout's own (a receipt not yet pushed is kept), then fast-forwards main, or merges it with the local commits, and says what it brought. A merge that conflicts changes nothing and names the paths. For a baseline built with `--history-since`, the baseline's new commits are carried into the checkout through its baseline map first. A grafts file or a shallow history is refused, and replacement refs are not read. `sync`, `publish` and `merge` refuse while main does not hold the baseline's main, and name this command.",
    },
  ],
  flags: {},
  help: {
    example: "atelier pull --project demo",
  },
};

export default spec;
