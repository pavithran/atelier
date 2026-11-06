import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "escapes",
  forms: [{
    group: "Developer", line: 4, slot: 41,
    form: "escapes [--since DATE] [--project NAME]",
    about: "Lists, per reviewer who approved the merged head, merged tasks later named by an item.fix_of repair link. Counts each task once per reviewer and lists its repair tasks. Withdrawn or superseded approvals do not count. --since filters when the repair link was recorded, retaining older merge and approval history. Reads the developer's paginated events export.",
  }],
  flags: { since: "--since needs a date: --since 2026-11-01" },
  help: {
    flags: { "--since DATE": "only repairs linked at or after this UTC date or time", "--project NAME": "the project; defaults to this checkout's project" },
    example: "atelier escapes --since 2026-11-01 --project demo",
  },
};
export default spec;
