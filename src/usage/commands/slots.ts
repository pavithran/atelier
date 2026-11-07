import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "slots",
  forms: [
    {
      group: "Local", line: 2, slot: 10,
      form: "slots set N",
      about: "Atomically sets this machine's test-slot capacity to a positive safe integer. Running work drains normally; waiting work keeps its priority and FIFO order. Update every runner before changing capacity.",
    },
    {
      group: "Local", line: 2, slot: 20,
      form: "slots status [--json]",
      about: "Shows configured capacity, active usage, draining excess and waiting work. Runs locally without server credentials.",
    },
    {
      group: "Local", line: 2, slot: 30,
      form: "slots trial FILE [--apply]",
      about: "Reads the Studio timing trial from a JSON file ({\"alone\": three minutes, \"pairs\": three {a, b} minutes}), prints the decision, and with --apply sets capacity to two only if every concurrent time is under 1.3 times the alone median. Otherwise capacity is unchanged.",
    },
  ],
  flags: { json: true, apply: true },
  help: {
    flags: { "--json": "prints status as JSON", "--apply": "sets the capacity the trial qualifies for" },
    example: "atelier slots set 3",
  },
};

export default spec;
