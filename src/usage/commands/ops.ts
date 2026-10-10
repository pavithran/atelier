import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "ops",
  forms: [
    {
      group: "Ops", line: 1, slot: 10,
      form: "ops COMMAND [ARGS...]",
      aside: "portfolio operations, run by the private atelier-ops toolkit when installed",
      about: "Hands everything after `ops` to the private `atelier-ops` toolkit, named by `ATELIER_OPS` or found on `PATH`. Without one it says so and exits 2. The one command Atelier handles itself is `ops token-expiry NAME --on YYYY-MM-DD`, which records a named token's expiry day, never its value, so `atelier status` warns from 14 days before it.",
    },
  ],
  flags: {},
};

export default spec;
