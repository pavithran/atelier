// atelier gc. Its forms, flags and help are declared in src/usage/commands/gc.ts.
import { existsSync } from "node:fs";
import { collectCache } from "../gc.mjs";
import { COMMAND_USAGE } from "../help.mjs";
import { CACHE, I, OWNER, P, actor, args, call, cfg, die, project } from "../atelier.mjs";

// The project's checkout and registered branch, which say whether a
// workspace's commits are in main; null where the project is not registered.
export function mainOf(name) {
  const p = cfg.projects?.[name];
  return p?.path && p?.branch ? { dir: p.path, branch: p.branch } : null;
}

// gc previews unless --apply; clean (t561) removes unless --dry-run.
export async function collect(command, apply) {
  if (args._.length !== 1 || (args.apply && args["dry-run"])) die(COMMAND_USAGE[command]);
  const name = project(), as = await actor(OWNER);
  const { items } = await call("GET", P(name), undefined, as);
  if (!existsSync(CACHE)) { console.log("No local cache to collect."); return; }
  await collectCache({ cache: CACHE, name, items, apply, main: mainOf(name),
    preview: command === "clean" ? "Run without --dry-run to remove them." : "Run with --apply to remove them.",
    getItem: async (id) => (await call("GET", I(name, id), undefined, as)).item });
}

export default async function gcCommand() {
  await collect("gc", args.apply === true);
}
