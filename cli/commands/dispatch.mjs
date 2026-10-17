// atelier dispatch. Its forms, flags and help are declared in src/usage/commands/dispatch.ts.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { I, OWNER, actor, args, call, die, itemArg, project } from "../atelier.mjs";

// The project owner queues an open task for a kind of runner. A task a
// builder has submitted (perhaps rejected) is released and queued in the same
// step, keeping its workspace and commits for the next builder. A task a
// builder holds live (claimed) is refused unless --release is given, which
// ends that claim first (t391).
// --job merge-main sends a task whose landing conflicted with main back to
// its builder (t243): the runner claims it, merges main at the named head
// into its workspace and leaves the conflicts for the builder to resolve
// and commit, where a plain rework would reset the workspace to a head
// that cannot reach main.
export default async function dispatchCommand() {
  const name = project(), id = itemArg();
  if (args.job !== undefined && args.job !== "merge-main") die(`--job names the job the runner runs; only merge-main is dispatched by hand: atelier dispatch ${id} --job merge-main`);
  if (args.head !== undefined && args.job === undefined) die(`--head names the main head a merge-main job merges; give it with --job merge-main: atelier dispatch ${id} --job merge-main --head FULL_HASH`);
  const note = noteFromFile(id) ?? args.note;
  const body = { to: args.to, agent: args.agent, model: args.model, note, ...(args.job !== undefined ? { job: args.job, ...(args.head !== undefined ? { head: args.head } : {}) } : {}), ...(args["overlap-ok"] === true ? { overlapOk: true } : {}), ...(args.release === true ? { release: true } : {}) };
  // With no --agent the server chooses the builder from the pool and the
  // models' records (t370), and says which and why.
  // --overlap-ok with no destination, note or job releases a waiting
  // dispatch's hold and keeps its builder, job and place in the queue; the
  // server dispatches it as usual when none is waiting.
  if (args["overlap-ok"] === true && args.to === undefined && note === undefined && args.job === undefined) {
    const { item: before } = await call("GET", I(name, id), undefined, OWNER);
    if (before.state === "open" && !before.owner && before.dispatch) {
      body.retain = true;
      body.retainAt = before.dispatch.at;
    }
  }
  const suggest = !body.retain && args.agent === undefined && args.job === undefined;
  if (suggest) body.suggest = true;
  const item = await call("POST", `${I(name, id)}/dispatch`, body, OWNER);
  const d = item.dispatch;
  if (item.releasedClaim) console.log(`${id}: released the claim of ${item.releasedClaim.from}, by ${d.by ?? OWNER}; their next push or finish is told the task was taken back by the developer's dispatch.`);
  if (item.suggestion) console.log(`Builder: ${item.suggestion.actor}. ${item.suggestion.reasons.join(" ")}`);
  // A server older than the suggestion ignores the ask and leaves the dispatch open.
  else if (suggest && !item.retainedDispatch && !d.agent) console.log("Warning: the server chose no builder; deploy the server, then dispatch again, or name one with --agent.");
  // A server older than the override ignores it and answers without it.
  if (args["overlap-ok"] === true && !d.overlapOk) console.log("Warning: the server did not record --overlap-ok; deploy the server, then dispatch again.");
  else if (args["overlap-ok"] === true) {
    // The hold is named only when one held the dispatch (t491).
    if (item.releasedCoreHold) console.log(`${id}: released core-file hold waiting on ${item.releasedCoreHold.id}; both scopes reach core pattern ${item.releasedCoreHold.core}.`);
    else console.log(`${id}: overlap override recorded.`);
    // A hold-only release keeps the waiting dispatch (t447).
    if (body.retain && !item.suggestion) {
      const who = d.agent ? `${d.agent}${d.model ? `/${d.model}` : " (any model)"}` : d.model ? `any agent / ${d.model}` : "any agent and model";
      console.log(`${id} keeps its dispatch; builder: ${who}; job: ${d.job ?? "build"}.`);
    }
  }
  if (d.job === "merge-main") {
    console.log(`${id} goes back to its builder to merge main at ${d.head.slice(0, 8)} into its workspace and resolve the conflicts: a runner that offers the merge-main job claims it, merges main there and leaves the conflicts for the harness to resolve and commit${d.agent ? ` (built by ${d.agent}${d.model ? ` with ${d.model}` : ""})` : ""}. Then run atelier land ${id} again.`);
    return;
  }
  console.log(`${id} is waiting for ${d.to === "any" ? "any runner" : `a ${d.to} runner`}${d.agent ? `, ${d.agent}` : ""}${d.model ? ` with ${d.model}` : ""}.`);
}

// --note-file PATH: the note is the file's text, read as UTF-8 relative to the
// current directory with its newlines kept (t480). It is refused before any
// request when --note is also given, when the file cannot be read, or when it
// is not valid UTF-8; an empty file is an empty note.
function noteFromFile(id) {
  const path = args["note-file"];
  if (path === undefined) return undefined;
  if (args.note !== undefined) die(`give the note with --note or --note-file, not both: atelier dispatch ${id} --note-file PATH`);
  if (typeof path !== "string" || path === "") die("--note-file names the file that holds the note: atelier dispatch ID --note-file PATH");
  let bytes;
  try { bytes = readFileSync(resolve(process.cwd(), path)); }
  catch (error) { die(`cannot read the note file ${path}: ${error.code ?? error.message}`); }
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { die(`the note file ${path} is not valid UTF-8`); }
}
