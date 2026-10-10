// atelier served. Its forms, flags and help are declared in src/usage/commands/served.ts.
import { join } from "node:path";
import { OWNER, P, args, at, call, die, project } from "../atelier.mjs";

// The project owner records which model served events recorded under
// another: each matching event gets an annotation, and the event itself
// never changes. Without --apply it lists the matches and records nothing.
export default async function servedCommand() {
  const name = project(), model = args._[1];
  if (args._.length !== 2 || ["recorded", "from", "to"].some((k) => typeof args[k] !== "string")) {
    die("usage: atelier served MODEL --recorded HARNESS/MODEL --from TIME --to TIME [--item ID]... [--note TEXT] [--apply] [--project P]");
  }
  const r = await call("POST", `${P(name)}/served`, {
    served: model, recorded: args.recorded, from: args.from, to: args.to,
    ...(args.multi.item ? { items: args.multi.item } : {}), ...(args.note !== undefined ? { note: args.note } : {}), apply: args.apply === true,
  }, OWNER);
  const n = r.matched.length;
  console.log(`${n} ${n === 1 ? "event" : "events"} on ${r.project} recorded as ${r.recorded} from ${r.from} to ${r.to}, in ${r.items ? r.items.join(" ") : "every task"}:`);
  for (const m of r.matched) console.log(`  ${m.itemId ?? "(no task)"}  #${m.seq}  ${m.kind}  ${m.at}${m.served ? `  annotated as served by ${m.served}` : ""}`);
  const as = `${r.recorded.slice(0, r.recorded.indexOf("/"))}/${r.served}`;
  if (r.applied) console.log(`Annotated ${r.annotated} as served by ${r.served}; ${n - r.annotated} already were. The records count them under ${as}.`);
  else if (r.pending) console.log(`Nothing was recorded. To annotate ${r.pending} as served by ${r.served}, run this again with --apply.`);
  else console.log(`Nothing to record: ${n ? `each is already annotated as served by ${r.served}` : "no event matches"}.`);
}
