import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "area",
  // The area routes (t456).
  capabilities: ["areas.manage.v1"],
  forms: [
    { group: "Items", line: 4, slot: 10, form: "area list", about: "Lists stable area IDs, unique names and one-line purposes." },
    { group: "Items", line: 5, slot: 10, form: "area create NAME --purpose TEXT", about: "The project owner creates a function area with a unique name and a one-line purpose." },
    { group: "Items", line: 6, slot: 10, form: "area rename ID NAME [--purpose TEXT]", about: "The project owner renames an area, preserving its stable ID and task assignments. Omitted purpose preserves the existing purpose." },
    { group: "Items", line: 7, slot: 10, form: "area remove ID", about: "The project owner removes an area, moving every assigned task to Unsorted. Removed IDs are never reused." },
  ],
  flags: { purpose: false },
  subcommands: { list: { takes: [] }, create: { takes: ["purpose"] }, rename: { takes: ["purpose"] }, remove: { takes: [] } },
  help: {
    flags: { "--purpose TEXT": "the area's nonempty one-line purpose; required on create, optional on rename" },
    example: 'atelier area create "Review" --purpose "Review and land work" --project demo',
  },
};

export default spec;
