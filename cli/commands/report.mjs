// atelier report. Its forms, flags and help are declared in src/usage/commands/report.ts.
import { join } from "node:path";
import { COMMAND_USAGE } from "../help.mjs";
import { I, RequestError, actor, args, call, die, project, request, short, wsConfig } from "../atelier.mjs";

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
  // The write is made once. A refusal ends the command nonzero with no
  // acknowledgement, and a stale head is never retried against the newer
  // one: the caller reviews the current revision and reports again. A
  // transport failure leaves it unknown whether the server recorded the
  // report, so the message does not say it was absent.
  const again = `review the current revision of ${id}, then report again`;
  let written;
  try { written = await request("POST", `${I(name, id)}/evidence`, { kind: "report", claim, head: d.item.head }, as); }
  catch (error) {
    if (!(error instanceof RequestError)) throw error;
    if (/^stale_head\b/.test(error.message)) die(`${error.message}\nnothing was recorded; ${again}`, error.code);
    if (error.code === 4) die(`${error.message}\nthe report may or may not have been recorded; check ${id} before reporting again`, 4);
    die(error.message, error.code);
  }
  if (written?.error) die(`${written.error}: ${written.detail ?? "the report was refused"}${written.error === "stale_head" ? `\nnothing was recorded; ${again}` : ""}`);
  console.log(`Recorded on ${id} as REPORTED at ${short(d.item.head)}. Reports are shown, never counted as checks.`);
}
