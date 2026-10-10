// atelier help. Its forms, flags and help are declared in src/usage/commands/help.ts.
import { helpText } from "../help.mjs";

export default function helpCommand() {
  console.log(helpText());
}
