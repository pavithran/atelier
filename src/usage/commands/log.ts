import type { CommandSpec } from "../command.ts";
const spec: CommandSpec = {
  name: "log",
  forms: [{ group: "Items", line: 2, slot: 26, form: "log ID [--follow]", about: "Print the task's runner lines, including failed install and check tails. Keeps the newest 64 KiB per task. Excludes the agent transcript. With --follow, poll until interrupted." }],
  flags: { follow: true },
  help: { flags: { "--follow": "poll for new runner lines until interrupted" }, example: "atelier log t3 --project demo --follow" },
};
export default spec;
