// atelier ops. Its forms, flags and help are declared in src/usage/commands/ops.ts.
import { die } from "../atelier.mjs";

// Reached only when `ops` is not the first word; see runOps.
export default async function opsCommand() {
  die("put ops first: atelier ops COMMAND [ARGS...]; everything after it goes to the operations toolkit", 2);
}
