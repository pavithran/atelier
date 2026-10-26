import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "server-errors",
  forms: [
    {
      group: "Developer", line: 2, slot: 7,
      form: "server-errors [--minutes N]",
      about: "The developer tails the Worker (wrangler tail --format json, from a checkout of this repository) for N minutes, 2 by default, and prints one line for each event that logged an error or threw: its time, method, path and error text. Never a header, a query string or a body. The tail shows only what arrives while it runs; read the stored logs in the dashboard first.",
    },
  ],
  flags: { minutes: false },
  help: {
    flags: {
      "--minutes N": "how long to tail, from 1 to 60 minutes; 2 by default",
    },
    example: "atelier server-errors --minutes 5",
  },
};

export default spec;
