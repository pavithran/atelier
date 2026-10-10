// atelier report. Its forms, flags and help are declared in src/usage/commands/report.ts.
import { join } from "node:path";
import { COMMAND_USAGE } from "../help.mjs";
import { I, actor, args, call, die, project, short, wsConfig } from "../atelier.mjs";

// A Reported claim on an item: atelier report [ID] "what you verified and
// how". The item is the ID written first, else --item ID, else the
// workspace's. Inside a workspace, an ID that is not its item is refused:
// an agent in t1's workspace writing `report t7 "…"` is more likely to be
// in the wrong workspace than to mean t7, and the claim would otherwise be
// recorded on t1 with "t7" folded into its text. --item ID names the item
// outright, and --project NAME with an ID says the workspace is not the
// context; either records the claim where it says.
export default async function reportCommand() {
  const words = args._.slice(1);
  const named = /^t\d+$/.test(words[0] ?? "") ? words.shift() : null;
  const claim = words.join(" ");
  if (!claim) die(COMMAND_USAGE.report);
  if (args.item !== undefined && (typeof args.item !== "string" || !/^t\d+$/.test(args.item))) die(`--item needs an item id, such as t7: ${COMMAND_USAGE.report}`);
  const name = project(), here = wsConfig("item"), id = args.item ?? named ?? here;
  if (!id) die(`which item? pass its id (t3) or run inside its workspace: ${COMMAND_USAGE.report}`);
  if (here && id !== here && args.item === undefined && args.project === undefined) {
    die(`this is ${here}'s workspace, and the claim names ${id}; to record it on ${id} from here: atelier report "…" --item ${id}`);
  }
  const as = await actor();
  const d = await call("GET", I(name, id), undefined, as);
  await call("POST", `${I(name, id)}/evidence`, { kind: "report", claim, head: d.item.head }, as);
  console.log(`Recorded on ${id} as REPORTED at ${short(d.item.head)}. Reports are shown, never counted as checks.`);
}
