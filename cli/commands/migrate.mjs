// atelier migrate. Its forms, flags and help are declared in src/usage/commands/migrate.ts.
import { OWNER, args, call, die, itemArg, project, server } from "../atelier.mjs";
import { sourceToken } from "./projects.mjs";

// Carries an open task from its fork on Artifacts (or any Git remote the
// developer names) to its branch t/N on this server (Atelier 2.0, task 11;
// design section 5, step 4). The server fetches the fork and makes t/N at
// the head the Ledger records; the task keeps its holder, claim and head,
// and the holder's next claim mints its Git credential.
export default async function migrateCommand() {
  const name = project(), id = itemArg();
  if (typeof args.from !== "string" || !args.from) die(`name the fork that holds ${id}'s work: atelier migrate ${id} --from REMOTE --project ${name}`);
  const token = sourceToken(`atelier migrate ${id}`);
  const r = await call("POST", `/projects/${encodeURIComponent(name)}/items/${id}/migrate`, { remote: args.from, ...(typeof args.ref === "string" ? { ref: args.ref } : {}), ...(token ? { token } : {}) }, OWNER);
  const at = new URL(server()).host;
  if (!r.migrated) return console.log(`${id} is already on ${r.branch} @ ${String(r.head).slice(0, 8)} on ${at}; nothing moved.\nnext: ${r.next}`);
  console.log([
    `${id} moved to ${r.branch} @ ${r.head.slice(0, 8)} in ${name}'s repository on ${at} (${r.remote}).`,
    ...(r.tip && r.tip !== r.head ? [`The fork's branch is at ${r.tip.slice(0, 8)}, past the recorded head; those commits were not carried, and the holder pushes them from its workspace.`] : []),
    `Its holder, claim and head stand. The holder's workspace points at the fork; a new claim clones ${r.branch}.`,
    `next: ${r.next}`,
  ].join("\n"));
}
