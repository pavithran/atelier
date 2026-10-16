// atelier start. Its forms, flags and help are declared in src/usage/commands/start.ts.
import { I, actor, call, cfg, formatTask, itemArg, project, workspacePath } from "../atelier.mjs";
import { stageProseStandard } from "../prose-stage.mjs";
import claimCommand from "./claim.mjs";

export default async function startCommand() {
  await claimCommand();
  const d = await call("GET", I(project(), itemArg()), undefined, await actor());
  // The standard is copied into the workspace the claim made, so the agent
  // reads it from there (t676).
  const path = d.policy?.proseStandard;
  const copy = path ? stageProseStandard(workspacePath(project(), itemArg()), cfg.projects?.[project()]?.path ?? null, path) : null;
  console.log(formatTask(d.item, d.policy, copy));
}
