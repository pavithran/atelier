// atelier new. Its forms, flags and help are declared in src/usage/commands/new.ts.
import { join } from "node:path";
import { COMMAND_USAGE } from "../help.mjs";
import { OWNER, P, actor, args, call, die, fieldsArg, formatFields, listArg, pointToGuide, project } from "../atelier.mjs";

// The title is the words given; with --brief the long text goes apart.
// One long string alone is sent as the title, as an older CLI sends it:
// the server keeps it as the brief and derives the short title, and the
// answer says so.
export default async function newCommand() {
  const title = args._.slice(1).join(" ");
  const fields = fieldsArg("new");
  if (!title && !fields.brief) die(COMMAND_USAGE.new);
  const scope = listArg("scope", "new");
  const item = await call("POST", `${P(project())}/items`, { title, scope, ...fields }, await actor(OWNER));
  console.log([
    `${item.id}  ${item.title}${item.scope.length ? `  [${item.scope.join(" ")}]` : ""}`,
    ...(item.derived ? [`The text is longer than a title, so it is kept as the brief and the title is its first clause; change it with atelier edit ${item.id} --title "TEXT".`] : []),
    ...formatFields(item),
  ].join("\n"));
  if (!fields.accept?.length) console.error(`Warning: ${item.id} has no acceptance criteria, so a review of it will have none to judge the change against. Give them with atelier edit ${item.id} --accept "TEXT", once per criterion.`);
  pointToGuide([project()]);
}
