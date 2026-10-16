import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "block",
  forms: [
    {
      group: "Agents", line: 3, slot: 30,
      form: 'block [ID] "what it is waiting on"',
      about: "The holder or the developer blocks the task with what it is waiting on. It keeps its holder and workspace, leaves the runner queue and stuck detection, cannot be pushed, submitted, reviewed, handed off or released, and sits in the developer's inbox with the reason until it is unblocked.",
    },
  ],
  flags: {},
  help: {
    example: 'atelier block t3 "Waiting on the schema decision" --project demo',
  },
};

export default spec;
