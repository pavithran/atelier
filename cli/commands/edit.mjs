// atelier edit. Its forms, flags and help are declared in src/usage/commands/edit.ts.
import { join } from "node:path";
import { COMMAND_USAGE } from "../help.mjs";
import { I, OWNER, args, call, criteriaNotice, die, fieldsArg, flat, formatFields, itemArg, project } from "../atelier.mjs";

// The project owner changes a task's framing; the server keeps every field
// not named and refuses a closed task.
export default async function editCommand() {
  const name = project(), id = itemArg();
  const fields = fieldsArg("edit");
  const blockedBy = blockedByArg(id);
  if (!Object.keys(fields).length && blockedBy === undefined) die(COMMAND_USAGE.edit);
  // The tasks it waits on (G3) have a route of their own; the Ledger refuses a cycle.
  if (blockedBy !== undefined) {
    const after = await call("POST", `${I(name, id)}/blocked-by`, { blockedBy }, OWNER);
    console.log(after.blockedBy?.length ? `${id} waits on ${after.blockedBy.join(", ")}: it is not offered, claimed or accepted until each is merged.` : `${id} waits on no task.`);
    if (!Object.keys(fields).length) return;
  }
  const item = await call("POST", `${I(name, id)}/edit`, fields, OWNER);
  const lines = [
    ...(fields.title !== undefined ? [`Title: ${flat(item.title)}`] : []),
    ...(fields.brief !== undefined ? [item.brief ? `Brief: ${item.brief.length} characters, shown on the task's page.` : "Brief: cleared."] : []),
    ...(fields.scope !== undefined ? [`Scope: ${item.scope.map(flat).join(", ") || "not specified (it overlaps every live task)"}`] : []),
    ...formatFields(item),
  ];
  console.log(`${id} edited.${lines.length ? `\n${lines.join("\n")}` : " No framing is set now."}`);
  if (item.criteriaChange) console.log(criteriaNotice(id, item.criteriaChange));
}

// --blocked-by tA,tB: the ids, in order and once each; "" clears the list.
export function blockedByArg(id) {
  const raw = args["blocked-by"];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") die(`--blocked-by needs task ids: atelier edit ${id} --blocked-by t3,t4, or --blocked-by "" to clear`);
  const ids = raw.split(",").map((t) => t.trim()).filter(Boolean);
  const bad = ids.find((t) => !/^t[1-9][0-9]*$/.test(t));
  if (bad) die(`--blocked-by takes task ids such as t3, not "${bad}": atelier edit ${id} --blocked-by t3,t4`);
  return [...new Set(ids)];
}
