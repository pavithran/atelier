// atelier slots. Its forms, flags and help are declared in src/usage/commands/slots.ts.
import { readFileSync } from "node:fs";
import { args, die } from "../atelier.mjs";
import { applySlotTrial } from "../../src/runners/slot-trial.ts";
import { formatSlots, setSlotCapacity, slotStatus } from "../load.mjs";

export default async function slotsCommand() {
  const [, sub, value] = args._;
  try {
    if (sub === "set" && args._.length === 3 && args.json === undefined) {
      return console.log(`Test slot capacity: ${await setSlotCapacity(value)}`);
    }
    if (sub === "status" && args._.length === 2) {
      const status = await slotStatus();
      return console.log(args.json ? JSON.stringify(status, null, 2) : formatSlots(status));
    }
    if (sub === "trial" && args._.length === 3) {
      const trial = JSON.parse(readFileSync(value, "utf8"));
      // Without --apply the decision is reported and the capacity left alone.
      const { report } = await applySlotTrial(trial, args.apply ? setSlotCapacity : undefined);
      return console.log(report);
    }
    die("usage: atelier slots set N | atelier slots status [--json] | atelier slots trial FILE [--apply]");
  } catch (error) { die(error.message); }
}
