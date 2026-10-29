// atelier situation. Its forms, flags and help are declared in src/usage/commands/situation.ts.
import { OWNER, P, args, call, project } from "../atelier.mjs";
import { situationText } from "../situation.mjs";

// One read (G4): the server assembles it from recorded facts; --json prints
// it as it came, the text is cli/situation.mjs's. A read needs no acting
// model, so it goes as the developer whatever --as or ATELIER_ACTOR says.
export default async function situationCommand() {
  const name = project();
  const s = await call("GET", `${P(name)}/situation`, undefined, OWNER);
  console.log(args.json ? JSON.stringify(s, null, 2) : situationText(s));
}
