// atelier new. Its forms, flags and help are declared in src/usage/commands/new.ts.
import { itemText, RuleError, scopesOverlap } from "../../src/rules.ts";
import { COMMAND_USAGE } from "../help.mjs";
import { OWNER, P, actor, args, call, die, fieldsArg, flat, formatFields, listArg, pointToGuide, project } from "../atelier.mjs";

// Two titles match when they share at least 60% of the words they hold between them.
export function titlesMatch(a, b) {
  const words = (title) => new Set(title.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const x = words(a), y = words(b);
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared > 0 && shared / (x.size + y.size - shared) >= 0.6;
}

// The live items whose scope overlaps the new task's and whose title matches it.
export function liveDuplicates(title, scope, items) {
  return items.filter((i) => i.state !== "merged" && i.state !== "abandoned" && scopesOverlap(scope, i.scope ?? []) && titlesMatch(title, i.title));
}

// The title is the words given; with --brief the long text goes apart.
// One long string alone is sent as the title, as an older CLI sends it:
// the server keeps it as the brief and derives the short title, and the
// answer says so.
export default async function newCommand() {
  const title = args._.slice(1).join(" ");
  const fields = fieldsArg("new");
  if (!title && !fields.brief) die(COMMAND_USAGE.new);
  const scope = listArg("scope", "new");
  // Use the same normalized or derived title as the server, and report its
  // validation errors as CLI refusals, including when duplicates are allowed.
  let filedTitle;
  try {
    filedTitle = itemText(title, fields.brief).title;
  } catch (error) {
    if (error instanceof RuleError) die(`${error.code}: ${error.detail}`);
    throw error;
  }
  const name = project(), as = await actor(OWNER);
  if (args["duplicate-ok"] !== true) {
    const { items } = await call("GET", P(name), undefined, as);
    const twins = liveDuplicates(filedTitle, scope, items);
    if (twins.length) die(`a live task already covers this work, so nothing was filed:\n${twins.map((i) => `  ${i.id}  ${flat(i.title)}  (${i.state}, ${i.owner ?? "unowned"})`).join("\n")}\nPass --duplicate-ok to file it anyway.`);
  }
  const item = await call("POST", `${P(name)}/items`, { title, scope, ...fields }, as);
  console.log([
    `${item.id}  ${item.title}${item.scope.length ? `  [${item.scope.join(" ")}]` : ""}`,
    ...(item.derived ? [`The text is longer than a title, so it is kept as the brief and the title is its first clause; change it with atelier edit ${item.id} --title "TEXT".`] : []),
    ...formatFields(item),
  ].join("\n"));
  if (!fields.accept?.length) console.error(`Warning: ${item.id} has no acceptance criteria, so a review of it will have none to judge the change against. Give them with atelier edit ${item.id} --accept "TEXT", once per criterion.`);
  pointToGuide([project()]);
}
