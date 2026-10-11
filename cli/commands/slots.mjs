import { args, die } from "../atelier.mjs";
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
    die("usage: atelier slots set N | atelier slots status [--json]");
  } catch (error) { die(error.message); }
}
