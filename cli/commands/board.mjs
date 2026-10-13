// atelier board. Its forms, flags and help are declared in src/usage/commands/board.ts.
import { P, args, call, die, project } from "../atelier.mjs";
import { COMMAND_USAGE } from "../help.mjs";
import { boardText } from "../../src/board.ts";

export default async function boardCommand() {
  if (args._.length !== 1) die(COMMAND_USAGE.board);
  const snapshot = await call("GET", `${P(project())}/board`);
  console.log(args.json ? JSON.stringify(snapshot, null, 2) : boardText(snapshot));
}

