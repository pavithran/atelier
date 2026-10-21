import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "sync",
  forms: [
    {
      group: "Setup", line: 1, slot: 40,
      form: "sync",
      about: "For a baseline built with `--history-since`, carries commits made in the checkout outside Atelier to the baseline. It reads no policy from the checkout; a baseline that holds the whole history takes new commits from `init`. Refused before anything is sent while main does not hold the baseline's main (`pull` brings it in).",
    },
  ],
  flags: {},
  help: {
    example: "atelier sync --project demo",
  },
};

export default spec;
