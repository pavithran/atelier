// atelier edit. Its forms, flags and help are declared in src/usage/commands/edit.ts.
import { join } from "node:path";
import { COMMAND_USAGE } from "../help.mjs";
import { I, OWNER, call, criteriaNotice, die, fieldsArg, flat, formatFields, itemArg, project } from "../atelier.mjs";

// The project owner changes a task's framing; the server keeps every field
// not named and refuses a closed task.
export default async function editCommand() {
  const name = project(), id = itemArg();
  const fields = fieldsArg("edit");
  if (!Object.keys(fields).length) die(COMMAND_USAGE.edit);
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
