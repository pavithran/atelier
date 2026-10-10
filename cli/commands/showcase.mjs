// atelier showcase. Its forms, flags and help are declared in src/usage/commands/showcase.ts.
import { COMMAND_USAGE } from "../help.mjs";
import { OWNER, args, call, die, server } from "../atelier.mjs";

// The public showcase: which projects the owner shows, and whether each is
// named or anonymised. Nothing is public until this says so.
export default async function showcaseCommand() {
  const [sub, name] = args._.slice(1);
  if (sub === "set") {
    if (!name || args._.length !== 3) die(COMMAND_USAGE.showcase);
    if (args.named === true && args.anonymous === true) die("give either --named or --anonymous, not both");
    const mode = args.named === true ? "named" : "anonymous";
    const r = await call("PUT", `/showcase/${encodeURIComponent(name)}`, { mode }, OWNER);
    return console.log(mode === "named"
      ? `${r.name} is shown on the public showcase at ${server()}/showcase, by name.`
      : `${r.name} is shown on the public showcase at ${server()}/showcase, anonymised: no project name, task title, path, commit message or address is drawn.`);
  }
  if (sub === "remove") {
    if (!name || args._.length !== 3) die(COMMAND_USAGE.showcase);
    const { removed, name: current } = await call("DELETE", `/showcase/${encodeURIComponent(name)}`, undefined, OWNER);
    return console.log(removed ? `${current ?? name} is no longer shown on the public showcase.` : `${name} was not shown on the public showcase.`);
  }
  if (sub) die(`${COMMAND_USAGE.showcase}\nunknown showcase command "${sub}"; use set, remove, or nothing to list`);
  const { showcase } = await call("GET", "/showcase", undefined, OWNER);
  if (!showcase.length) return console.log("Nothing is shown publicly. Add a project: atelier showcase set NAME");
  for (const s of showcase) console.log(`${s.mode.padEnd(10)} ${s.name}`);
}
