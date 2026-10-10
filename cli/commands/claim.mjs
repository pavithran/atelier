// atelier claim. Its forms, flags and help are declared in src/usage/commands/claim.ts.
import { actor, args, claimWorkspace, itemArg, project } from "../atelier.mjs";

// Agents: take an item and get a private workspace for it.
export default async function claimCommand() {
  const name = project();
  const id = itemArg();
  const as = await actor();
  const { workspace, dir, identity } = await claimWorkspace(name, id, as, args.runner ?? null);
  console.log(`${id} is yours, ${as}. Work here:\n  cd ${JSON.stringify(dir)}`);
  if (identity.email) console.log(`Commits here are authored as ${identity.name ?? "(global name)"} <${identity.email}>, as in the project checkout.`);
  console.log(`Write token expires ${workspace.expiresAt}; run \`atelier claim ${id}\` again to refresh it.`);
  console.log(args._[0] === "start" ? 'Then: commit, then atelier done "summary"' : `Then: commit → atelier push → atelier check → atelier submit`);
}
