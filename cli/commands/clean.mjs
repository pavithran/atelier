// atelier clean. Its forms, flags and help are declared in src/usage/commands/clean.ts.
import { args } from "../atelier.mjs";
import { collect } from "./gc.mjs";

// The workspaces finished tasks left before merges cleaned up after
// themselves (t561): what gc --apply removes, unless --dry-run.
export default async function cleanCommand() {
  await collect("clean", args["dry-run"] !== true);
}
