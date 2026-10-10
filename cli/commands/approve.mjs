// atelier approve. Its forms, flags and help are declared in src/usage/commands/approve.ts.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { COMMAND_USAGE } from "../help.mjs";
import { ACTION_KINDS, DEFAULT_EXPIRY, KIND, REVISION, expirySeconds } from "../../src/actions.ts";
import { knownKinds } from "../ship.mjs";
import { OWNER, P, args, at, call, cfg, die, project, short } from "../atelier.mjs";

// The project owner approves one protected action at one revision of the
// main line (src/actions.ts). atelier ship uses it once, at that revision only.
export default async function approveCommand() {
  const kind = args._[1];
  if (args._.length !== 2 || !kind) die(COMMAND_USAGE.approve);
  const name = project();
  if (!KIND.test(kind)) die(`"${kind}" is not an action name: use lower-case letters, digits and dashes, such as deploy`);
  const head = typeof args.head === "string" ? args.head.trim().toLowerCase() : "";
  if (!REVISION.test(head)) die(`--head needs the full revision of the main line, 40 or 64 hex digits: atelier approve ${kind} --head SHA. In the registered checkout, atelier ship --dry-run prints it`);
  const checkout = cfg.projects?.[name]?.path;
  const known = knownKinds(checkout && existsSync(checkout) ? checkout : null);
  if (!known.has(kind)) die(`${name} has no action called ${kind}. Atelier knows ${ACTION_KINDS.join(", ")}; ${name}'s ship files name ${[...known].filter((k) => !ACTION_KINDS.includes(k)).join(", ") || "no others"}`);
  const expires = args.expires ?? DEFAULT_EXPIRY;
  try { expirySeconds(expires); } catch (error) { die(`--expires: ${error.message}`); }
  const a = await call("POST", `${P(name)}/actions`, { kind, commit: head, note: args.note ?? "", expires }, OWNER);
  console.log(`${a.id}: ${a.kind} approved at ${short(a.commit)} until ${at(a.expiresAt)}. The next atelier ship at that revision uses it, once. To withdraw it: atelier approvals withdraw ${a.id}`);
}
