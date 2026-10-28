import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "events",
  forms: [
    {
      group: "Developer", line: 4, slot: 40,
      form: "events [--from DATE] [--to DATE] [--kind K]... [--json] [--project P]",
      about: "Writes the project's ledger events to standard output as a JSON array, oldest first, each as {seq, at, item, actor, kind, stage, data}: the task it belongs to (null for the project's own), who acted, and the stage the task was at after the change. `--json` is accepted and changes nothing, as the output is always JSON. It reads the ledger a page at a time, so any size works. Keys, tokens and other secret values are replaced before they leave the server.",
    },
  ],
  flags: {
    from: "--from needs a date: --from 2026-10-01",
    to: "--to needs a date: --to 2026-10-25",
    json: true,
    kind: "--kind needs an event kind: --kind item.merged",
  },
  help: {
    flags: {
      "--from DATE": "only events at or after this date or time",
      "--to DATE": "only events before the end of this date, or before this time",
      "--kind K": "only events of this kind; repeat it for several",
      "--json": "accepted for scripts; the output is JSON either way",
      "--project NAME": "the project; this checkout's or workspace's project unless given",
    },
    example: "atelier events --project demo --from 2026-10-20 --kind item.merged > events.json",
  },
};

export default spec;
