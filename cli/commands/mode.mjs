// atelier mode. Its forms, flags and help are declared in src/usage/commands/mode.ts.
import { COMMAND_USAGE } from "../help.mjs";
import { fastLandedLines } from "../../src/rules.ts";
import { OWNER, P, RequestError, actingHeaders, args, call, die, directionArg, project, request } from "../atelier.mjs";

// What landed in fast mode, one line per task, with its post-merge review.
export const landedLines = fastLandedLines;

// The switch to fast mode needs the developer's confirmation (Astra's audit
// of 2026-10-13, finding 3): their direction, --quote with the acting model
// (t629), or their permission from the project's Settings page. The
// server's refusal names the page and the factor it takes; this adds the
// command to run again either way.
export function fastRefusal(message, name, reason) {
  if (!/^fast_mode_unconfirmed:/.test(message)) return message;
  return `${message}\nOnce allowed, run: atelier mode fast --reason ${JSON.stringify(reason)} --project ${name}\nOr, on the developer's direction: atelier mode fast --reason ${JSON.stringify(reason)} --quote "the developer's words" --as H/M --project ${name}`;
}

export async function switchMode(name, to, reason, direction = {}) {
  let r;
  try { r = await request("POST", `${P(name)}/mode`, { mode: to, ...(reason !== undefined ? { reason } : {}), ...direction }, OWNER, actingHeaders()); }
  catch (error) { if (error instanceof RequestError) die(fastRefusal(error.message, name, reason), error.code); throw error; }
  console.log(r.line);
  if (to === "full") for (const line of landedLines(r.landed)) console.log(line);
  else console.log(`Recorded as decision ${r.decision}. Land finished tasks with atelier fast land tN=SHA ...; switch back with atelier mode full.`);
  return r;
}

export default async function modeCommand() {
  const [, sub] = args._;
  const name = project();
  if (sub === undefined && args._.length === 1) {
    const r = await call("GET", `${P(name)}/mode`, undefined, OWNER);
    return console.log(r.line);
  }
  if (sub === "fast" && args._.length === 2) {
    if (typeof args.reason !== "string" || !args.reason.trim()) die('fast mode needs a reason: atelier mode fast --reason "why"');
    return void await switchMode(name, "fast", args.reason, directionArg("mode fast --reason TEXT"));
  }
  if (sub === "full" && args._.length === 2) return void await switchMode(name, "full");
  die(COMMAND_USAGE.mode);
}
