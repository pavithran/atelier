import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "sync",
  forms: [
    {
      group: "Setup", line: 1, slot: 40,
      form: "sync",
      about: "Refreshes the stored policy from the project's ControlPlane files. For a baseline built with `--history-since`, it also carries commits made in the checkout outside Atelier to the baseline. Refused before anything is sent, the policy included, while main does not hold the baseline's main (`pull` brings it in).",
    },
  ],
  flags: {},
  help: {
    example: "atelier sync --project demo",
  },
};

export default spec;
