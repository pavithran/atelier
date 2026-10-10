// atelier guide. Its forms, flags and help are declared in src/usage/commands/guide.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROLES, guideText, rolePrompt } from "../help.mjs";
import { decisionsSection } from "../../src/decisions.ts";
import { OWNER, P, args, call, die, project, registeredHere, roleOverride, wsConfig } from "../atelier.mjs";

export default async function guideCommand() {
  if (args.full) {
    if (args.role !== "orchestrate") die("--full prints the orchestrate handbook: atelier guide --role orchestrate --full");
    process.stdout.write(readFileSync(new URL("../../docs/orchestrating.md", import.meta.url), "utf8"));
    return;
  }
  if (args.role === undefined) { process.stdout.write(guideText()); return; }
  const role = args.role;
  if (!ROLES.includes(role)) die(`--role needs one of ${ROLES.join(", ")}: atelier guide --role build|review|plan|orchestrate`);
  const text = roleOverride(role) ?? rolePrompt(role);
  // The orchestrator's guide for a project ends with the owner's standing
  // decisions (src/decisions.ts), read from the server: the project is the
  // one --project names, else this workspace's or registered checkout's.
  // Outside any project, or for another role, the text stands alone and no
  // server is contacted.
  const name = role === "orchestrate" ? args.project ?? wsConfig("project") ?? registeredHere().name : null;
  if (!name) { process.stdout.write(text); return; }
  const { decisions } = await call("GET", `${P(name)}/decisions`, undefined, OWNER);
  process.stdout.write(`${text}\n${decisionsSection(decisions.filter((d) => d.status === "standing"))}\n`);
}
