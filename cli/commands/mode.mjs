// atelier mode. Its forms, flags and help are declared in src/usage/commands/mode.ts.
import { COMMAND_USAGE } from "../help.mjs";
import { OWNER, P, actingHeaders, args, call, die, project } from "../atelier.mjs";

// What landed in fast mode, one line per task, with its post-merge review.
export function landedLines(landed) {
  if (!landed?.length) return ["Nothing landed in fast mode."];
  return landed.map((l) => `${l.item} landed in fast mode at ${l.receipt.mergeCommit.slice(0, 12)} (built by ${l.receipt.builder}): post-merge review ${l.review.state}${l.review.by ? ` by ${l.review.by}` : ""}${l.fix ? `; fix task ${l.fix}` : ""}`);
}

export async function switchMode(name, to, reason) {
  const r = await call("POST", `${P(name)}/mode`, { mode: to, ...(reason !== undefined ? { reason } : {}) }, OWNER, actingHeaders());
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
    return void await switchMode(name, "fast", args.reason);
  }
  if (sub === "full" && args._.length === 2) return void await switchMode(name, "full");
  die(COMMAND_USAGE.mode);
}
