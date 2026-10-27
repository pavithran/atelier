// atelier mode. Its forms, flags and help are declared in src/usage/commands/mode.ts.
import { COMMAND_USAGE } from "../help.mjs";
import { fastLandedLines } from "../../src/rules.ts";
import { OWNER, P, RequestError, actingHeaders, args, call, die, directionArg, project, request } from "../atelier.mjs";

// What landed in fast mode, one line per task, with its post-merge review.
export const landedLines = fastLandedLines;

// The switch to fast mode needs the developer's direction: --quote with
// the acting model (t629). The server's refusal says so; this adds the
// command the agent runs on the developer's yes, with this reason.
export function fastRefusal(message, name, reason) {
  if (!/^fast_mode_unconfirmed:/.test(message)) return message;
  return `${message}\nOn the developer's yes, run: atelier mode fast --reason ${JSON.stringify(reason)} --quote "the developer's words" --as H/M --project ${name}`;
}

// What the switch to fast mode prints after the mode line. Since t300 fast
// mode lands through atelier land, or the lander for a queued task, once the
// required checks pass, and the independent review comes after the merge.
export function fastSwitchedLine(decision) {
  return `Recorded as decision ${decision}. Tasks land through atelier land, or the lander, once their required checks pass; each is reviewed after the merge. Switch back with atelier mode full.`;
}

export async function switchMode(name, to, reason, direction = {}) {
  let r;
  try { r = await request("POST", `${P(name)}/mode`, { mode: to, ...(reason !== undefined ? { reason } : {}), ...direction }, OWNER, actingHeaders()); }
  catch (error) { if (error instanceof RequestError) die(fastRefusal(error.message, name, reason), error.code); throw error; }
  console.log(r.line);
  if (to === "full") for (const line of landedLines(r.landed)) console.log(line);
  else console.log(fastSwitchedLine(r.decision));
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
  if (sub === "full" && args._.length === 2) return void await switchMode(name, "full", undefined, directionArg("mode full"));
  die(COMMAND_USAGE.mode);
}
