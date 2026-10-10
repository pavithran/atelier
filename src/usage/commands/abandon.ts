import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "abandon",
  forms: [
    {
      group: "Owner", line: 1, slot: 50,
      form: "abandon ID [--note TEXT] [--delivered-by tN]",
      about: "Closes the task without merging it. The holder's write token is revoked; the history and evidence stay. `--note` says why. `--delivered-by` records that the merged task tN delivered it, for work another task already brought in.",
    },
  ],
  flags: { note: false, "delivered-by": false },
  help: {
    flags: {
      "--note TEXT": "why; kept with the event",
      "--delivered-by tN": "a merged task that delivered this one's work; kept with the event",
    },
    example: 'atelier abandon t3 --note "Superseded by t5" --project demo',
  },
};

export default spec;
