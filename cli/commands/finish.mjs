// atelier finish. Its forms, flags and help are declared in src/usage/commands/finish.ts.
import { I, actor, args, call, checkInSandbox, cliState, die, doneChecks, git, itemArg, project, requireWorkspace, summaryArg } from "../atelier.mjs";
import checkCommand from "./check.mjs";
import pushCommand from "./push.mjs";
import submitCommand from "./submit.mjs";

export default async function finishCommand() {
  summaryArg("finish");
  const name = project(), id = itemArg(), as = await actor();
  requireWorkspace("finish", name, id, as);
  const d = await call("GET", I(name,id), undefined, as);
  if (d.item.owner !== as || !["claimed","submitted"].includes(d.item.state)) die("this task must be live and owned by you");
  if (git(["status","--porcelain"])) die("commit your changes before finishing");
  const head = git(["rev-parse","HEAD"]);
  doneChecks.length = 0;
  if (cliState.doneStep) cliState.doneStep = "push";
  await pushCommand();
  if (cliState.doneStep) cliState.doneStep = "check";
  if (d.policy.sandboxOnly || args.sandbox) await checkInSandbox(); else await checkCommand();
  const changed = git(["status","--porcelain"], { raw: true }).split("\n").filter(Boolean).map((line) => line.slice(3));
  // A failed check is the outcome even when it also changed the workspace; the changed files are named with it.
  if (doneChecks.some((c) => c.result === "failed")) return { id, head, checks: doneChecks, changed };
  if (git(["rev-parse","HEAD"]) !== head || changed.length) die("the workspace changed while finishing; inspect it and finish again");
  const current = await call("GET", I(name,id), undefined, as);
  if (current.item.head !== head) die("the remote revision changed while checks ran; finish again");
  if (cliState.doneStep) cliState.doneStep = "submit";
  const submitted = await submitCommand();
  return { id, head, checks: doneChecks, ...submitted };
}
