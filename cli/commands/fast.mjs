// atelier fast. Its forms, flags and help are declared in src/usage/commands/fast.ts.
import { COMMAND_USAGE } from "../help.mjs";
import { OWNER, P, args, call, die, project } from "../atelier.mjs";
import { landedLines, switchMode } from "./mode.mjs";
import { fastReadyLines } from "../../src/rules.ts";

export default async function fastCommand() {
  const [, sub, ...rest] = args._;
  const name = project();
  if (sub === "status" && !rest.length) {
    const r = await call("GET", `${P(name)}/mode`, undefined, OWNER);
    if (args.json) return console.log(JSON.stringify(r, null, 2));
    console.log(r.line);
    for (const line of landedLines(r.landed)) console.log(line);
    // Builds reported ready before the fork-less build was removed, one
    // tN=SHA line each, until their tasks land.
    for (const line of fastReadyLines(r.ready ?? [])) console.log(line);
    return;
  }
  if (sub === "close" && !rest.length) return void await switchMode(name, "full");
  die(COMMAND_USAGE.fast);
}
