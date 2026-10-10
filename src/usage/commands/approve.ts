import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "approve",
  forms: [
    {
      group: "Owner", line: 2, slot: 30,
      form: "approve ACTION --head SHA [--note T] [--expires 24h]",
      about: "The project owner approves one protected action, such as `deploy`, `install`, `paid-run` or `photos-writeback`, at one exact revision of the main line: the full SHA of a commit the baseline holds. `atelier ship` uses the approval once, at that revision only, and a later revision needs its own. It stands for 24 hours unless `--expires` gives from `1m` to `30d`; `--note` records why. Any other kind must be one the project's ship files name.",
    },
  ],
  flags: { head: false, note: false, expires: false },
  help: {
    flags: {
      "--head SHA": "the full revision of the main line the approval is for; required",
      "--note TEXT": "why; kept with the approval",
      "--expires DURATION": "how long it stands, from 1m to 30d; 24h unless given",
    },
    example: "atelier approve deploy --head 0123456789abcdef0123456789abcdef01234567 --project demo",
  },
};

export default spec;
