// The area/board CLI surface. Kept separate from the legacy task-list forms:
// board always includes every state, while ls defaults to live tasks only.
export const AREA_USAGE = `usage: atelier area list
       atelier area create NAME --purpose TEXT
       atelier area rename ID NAME [--purpose TEXT]
       atelier area remove ID

Only the project owner changes areas. Names are unique and purposes are single lines.
Rename preserves the ID. Remove moves every assigned task to Unsorted.
Assign with new --area ID or edit ID --area ID; edit ID --clear-area clears it.
Every command takes --project NAME. board shows all areas and tasks.`;
export const BOARD_USAGE = `usage: atelier board [--json] [--project NAME]

Groups every task by area, including empty areas and Unsorted. Shows each task's
kind, title, ledger-derived stage and holder. Counts use the displayed membership.
--json prints the ledger snapshot used by both the web page and this command.
Manage areas with atelier area --help.`;

export function areaField(args: { area?: unknown; "clear-area"?: unknown }, command: string): { area?: string | null } {
  if (args["clear-area"] !== undefined && args["clear-area"] !== false) {
    if (command !== "edit" || args["clear-area"] !== true || args.area !== undefined) throw new Error("use edit ID --clear-area alone to clear an assignment");
    return { area: null };
  }
  if (args.area === undefined) return {};
  if (typeof args.area !== "string" || !/^a[1-9]\d*$/.test(args.area)) throw new Error("--area needs an area ID, such as a1; use edit ID --clear-area to clear it");
  return { area: args.area };
}
