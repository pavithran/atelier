export function areaField(args: { area?: unknown; "clear-area"?: unknown }, command: string): { area?: string | null } {
  if (args["clear-area"] !== undefined && args["clear-area"] !== false) {
    if (command !== "edit" || args["clear-area"] !== true || args.area !== undefined) throw new Error("use edit ID --clear-area alone to clear an assignment");
    return { area: null };
  }
  if (args.area === undefined) return {};
  if (typeof args.area !== "string" || !/^a[1-9]\d*$/.test(args.area)) throw new Error("--area needs an area ID, such as a1; use edit ID --clear-area to clear it");
  return { area: args.area };
}
