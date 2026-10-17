// atelier identity. Its forms, flags and help are declared in src/usage/commands/identity.ts.
import { NO_IDENTITY } from "../../src/commit-identity.ts";
import { OWNER, P, args, call, die, project } from "../atelier.mjs";

// The project's commit identity from its policy, read-only. With none it
// fails, so a script that sets a Git identity from it never falls back to a
// default.
export default async function identityCommand() {
  const name = project();
  const identity = (await call("GET", P(name), undefined, OWNER))?.project?.policy?.commitIdentity;
  if (!identity?.name || !identity?.email) die(NO_IDENTITY(name));
  const agentEmails = identity.agentEmails ?? [];
  if (args.json) return console.log(JSON.stringify({ name: identity.name, email: identity.email, agentEmails }));
  console.log(`${identity.name} <${identity.email}>`);
  if (agentEmails.length) console.log(`Agents may also commit as ${agentEmails.join(", ")}.`);
}
