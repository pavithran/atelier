// atelier done. Its forms, flags and help are declared in src/usage/commands/done.ts.
import { join } from "node:path";
import { COMMAND_USAGE } from "../help.mjs";
import { args, cliState, die, doneReport, progressToStderr } from "../atelier.mjs";
import finishCommand from "./finish.mjs";

export default async function doneCommand() {
  if (args._.length !== 2 || !args._[1].trim() || args.summary !== undefined || args.rest) die(COMMAND_USAGE.done);
  args.summary = args._[1];
  args._ = ["done"];
  const restore = args.json === true ? progressToStderr() : () => {};
  cliState.doneStep = "prepare";
  let result;
  try {
    result = await finishCommand();
    cliState.doneStep = undefined;
  } catch (error) { die(error.message); }
  restore();
  const report = doneReport(result);
  if (args.json === true) console.log(JSON.stringify(report.json, null, 2));
  else console.log([...report.summary, report.line].join("\n"));
  process.exitCode = report.exitCode;
}
