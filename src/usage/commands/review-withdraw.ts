import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "review-withdraw",
  capabilities: ["reviews.withdraw.v1"],
  forms: [
    {
      group: "Developer", line: 1, slot: 42,
      form: "review-withdraw ID --reason TEXT [--request N]",
      about: "The developer withdraws an open review request no runner has claimed, with the reason, kept on the task. The gate then asks no one until the developer asks again, of any reviewer, at the same head (atelier land ID --reviewer H/M). A claimed request is being served and is refused: its verdict, or its claim lapsing, ends it. atelier land --reviewer naming another reviewer withdraws an unclaimed request in the same way, and says so.",
    },
  ],
  flags: { reason: false, request: false },
  help: {
    flags: {
      "--reason TEXT": "why the request is withdrawn; required, kept with the event",
      "--request N": "the request to withdraw, by number; defaults to the newest request at the task's head",
    },
    example: 'atelier review-withdraw t3 --reason "No runner serves codex/gpt-6-astra" --project demo',
  },
};

export default spec;
