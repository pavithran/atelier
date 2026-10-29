import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "pull",
  forms: [
    {
      group: "Setup", line: 1, slot: 37,
      form: "pull",
      about: "On the developer token, set `ATELIER_ACTING=H/M` to name the acting model for the read grant. Brings this Mac's checkout up to the project's baseline, which another Mac may have moved on: fetches the baseline's main and its receipts with a read token it mints and keeps nowhere, with every Git hook off, merges the receipts on `refs/notes/atelier` into the checkout's own (a receipt not yet pushed is kept), then fast-forwards main, or merges it with the local commits, and says what it brought. A merge that conflicts changes nothing and names the paths. A grafts file or a shallow history is refused, and replacement refs are not read. On 2.0, `sync` always refuses; `wrap` reports the baseline without refusing when main is behind it.",
    },
  ],
  flags: {},
  help: {
    example: "ATELIER_ACTING=claude-code/opus-5.5 atelier pull --project demo",
  },
};

export default spec;
