// atelier dispatch. Its forms, flags and help are declared in src/usage/commands/dispatch.ts.
import { join } from "node:path";
import { I, OWNER, actor, args, call, die, itemArg, project } from "../atelier.mjs";

// The project owner queues an open task for a kind of runner. A held task
// (claimed, or submitted and perhaps rejected) is released and queued in
// the same step, keeping its workspace and commits for the next builder.
// --job merge-main sends a task whose landing conflicted with main back to
// its builder (t243): the runner claims it, merges main at the named head
// into its workspace and leaves the conflicts for the builder to resolve
// and commit, where a plain rework would reset the workspace to a head
// that cannot reach main.
export default async function dispatchCommand() {
  const name = project(), id = itemArg();
  if (args.job !== undefined && args.job !== "merge-main") die(`--job names the job the runner runs; only merge-main is dispatched by hand: atelier dispatch ${id} --job merge-main`);
  if (args.head !== undefined && args.job === undefined) die(`--head names the main head a merge-main job merges; give it with --job merge-main: atelier dispatch ${id} --job merge-main --head FULL_HASH`);
  const body = { to: args.to, agent: args.agent, model: args.model, note: args.note, ...(args.job !== undefined ? { job: args.job, ...(args.head !== undefined ? { head: args.head } : {}) } : {}), ...(args["overlap-ok"] === true ? { overlapOk: true } : {}) };
  // With no --agent the server chooses the builder from the pool and the
  // models' records (t370), and says which and why.
  const suggest = args.agent === undefined && args.job === undefined;
  if (suggest) body.suggest = true;
  const item = await call("POST", `${I(name, id)}/dispatch`, body, OWNER);
  const d = item.dispatch;
  if (item.suggestion) console.log(`Builder: ${item.suggestion.actor}. ${item.suggestion.reasons.join(" ")}`);
  // A server older than the suggestion ignores the ask and leaves the dispatch open.
  else if (suggest && !d.agent) console.log("Warning: the server chose no builder; deploy the server, then dispatch again, or name one with --agent.");
  // A server older than the override ignores it and answers without it.
  if (args["overlap-ok"] === true && !d.overlapOk) console.log("Warning: the server did not record --overlap-ok; deploy the server, then dispatch again.");
  else if (d.overlapOk) console.log(`${id} is offered to a runner although its scope may overlap a live item's in a core file.`);
  if (d.job === "merge-main") {
    console.log(`${id} goes back to its builder to merge main at ${d.head.slice(0, 8)} into its workspace and resolve the conflicts: a runner that offers the merge-main job claims it, merges main there and leaves the conflicts for the harness to resolve and commit${d.agent ? ` (built by ${d.agent}${d.model ? ` with ${d.model}` : ""})` : ""}. Then run atelier land ${id} again.`);
    return;
  }
  console.log(`${id} is waiting for ${d.to === "any" ? "any runner" : `a ${d.to} runner`}${d.agent ? `, ${d.agent}` : ""}${d.model ? ` with ${d.model}` : ""}.`);
}
