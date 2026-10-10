// atelier block. Its forms, flags and help are declared in src/usage/commands/block.ts.
import { join } from "node:path";
import { COMMAND_USAGE } from "../help.mjs";
import { I, OWNER, actor, args, call, die, flat, project, wsConfig } from "../atelier.mjs";

// The holder or the owner blocks a task with what it is waiting on. The
// id comes first when given; in a workspace it is the workspace's item.
export default async function blockCommand() {
  const words = args._.slice(1);
  const named = /^t\d+$/.test(words[0] ?? "") ? words.shift() : null;
  const reason = words.join(" ");
  if (!reason.trim()) die(COMMAND_USAGE.block);
  const name = project(), id = named ?? wsConfig("item");
  if (!id) die(`which item? pass its id (t3) or run inside its workspace: ${COMMAND_USAGE.block}`);
  const item = await call("POST", `${I(name, id)}/block`, { reason }, await actor(OWNER));
  console.log(`${id} is blocked: ${flat(item.blocked?.reason ?? reason)}. It keeps its owner and workspace; run atelier unblock ${id} when it can go on.`);
}
