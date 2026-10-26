// atelier block. Its forms, flags and help are declared in src/usage/commands/block.ts.
import { join } from "node:path";
import { COMMAND_USAGE } from "../help.mjs";
import { blockUntil } from "../../src/rules.ts";
import { I, OWNER, actingHeaders, actor, args, call, die, directionArg, flat, project, tokenActor, wsConfig } from "../atelier.mjs";

// The holder or the owner blocks a task with what it is waiting on. The
// id comes first when given; in a workspace it is the workspace's item.
export default async function blockCommand() {
  const words = args._.slice(1);
  const named = /^t\d+$/.test(words[0] ?? "") ? words.shift() : null;
  const reason = words.join(" ");
  if (!reason.trim()) die(COMMAND_USAGE.block);
  // A bad --until ends the command here, before any request, so nothing is recorded.
  let until;
  if (args.until !== undefined) {
    try { until = blockUntil(args.until, new Date()); } catch (e) { die(e.message.replace(/^\d+\|[a-z_]+\|/, "")); }
  }
  const name = project(), id = named ?? wsConfig("item");
  if (!id) die(`which item? pass its id (t3) or run inside its workspace: ${COMMAND_USAGE.block}`);
  // --quote carries the developer's words (t178): with --as H/M they let the
  // developer token alone block, recorded under the developer's actor with
  // the model that relayed them. An agent's own token cannot carry them.
  const direction = directionArg(`block ${id} ${JSON.stringify(reason)}`), said = direction.quote !== undefined;
  const who = await actor(OWNER);
  if (said && tokenActor) die("an agent's own token cannot carry the developer's words: --quote goes with the developer token");
  const item = await call("POST", `${I(name, id)}/block`, { reason, ...(until ? { until } : {}), ...direction }, said ? OWNER : who, said ? actingHeaders() : {});
  // A server from before --until records the block without the date and says nothing of it.
  if (until && item.blocked?.until !== until) console.log(`The server did not record the expiry ${until}; ${id} is blocked with no expiry until the server is updated.`);
  console.log(`${id} is blocked: ${flat(item.blocked?.reason ?? reason)}. It keeps its holder and workspace; run atelier unblock ${id} when it can go on.${item.blocked?.until ? ` Status shows it as expired from the day after ${item.blocked.until} (UTC); it stays blocked until then and after.` : ""}${said ? ` Recorded on the developer's words, relayed by ${actingHeaders()["x-atelier-acting"]}.` : ""}`);
}
