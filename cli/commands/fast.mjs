// atelier fast. Its forms, flags and help are declared in src/usage/commands/fast.ts.
import { COMMAND_USAGE } from "../help.mjs";
import { I, OWNER, P, actor, args, call, die, fastTakeWorkspace, git, itemArg, project, wsConfig } from "../atelier.mjs";
import { shellQuote } from "../fast.mjs";
import { landedLines, switchMode } from "./mode.mjs";
import { agentOfMessage, fastReadyLines } from "../../src/rules.ts";

export default async function fastCommand() {
  const [, sub, ...rest] = args._;
  const name = project();
  if (sub === "status" && !rest.length) {
    const r = await call("GET", `${P(name)}/mode`, undefined, OWNER);
    if (args.json) return console.log(JSON.stringify(r, null, 2));
    console.log(r.line);
    for (const line of landedLines(r.landed)) console.log(line);
    // The builds runners made in fast mode (t589), one tN=SHA line each.
    for (const line of fastReadyLines(r.ready ?? [])) console.log(line);
    return;
  }
  if (sub === "close" && !rest.length) return void await switchMode(name, "full");
  // A runner's fast build (t589): the take without a fork, then the report.
  if (sub === "take") return void await fastTake(name);
  if (sub === "ready") return void await fastReadyReport(name);
  die(COMMAND_USAGE.fast);
}

// atelier fast take ID: the holder is recorded, no fork is made, and the
// build gets a clean clone of main on this machine. With --json the last
// line is the answer the runner reads: the clone, its base, and whether an
// unreported commit was kept.
async function fastTake(name) {
  const id = itemArg(2);
  const as = await actor();
  const runner = typeof args.runner === "string" ? args.runner : null;
  const r = await fastTakeWorkspace(name, id, as, runner, typeof args.dispatch === "string" ? args.dispatch : null);
  if (args.json) return console.log(JSON.stringify({ item: r.item, dir: r.dir, base: r.base, head: r.head, resumed: r.resumed }));
  console.log(`${id} is yours, ${as}, in fast mode: no fork, no write token. Work here, in a clean clone of main at ${r.base.slice(0, 12)}:\n  cd ${shellQuote(r.dir)}`);
  if (r.resumed) console.log(`The clone holds ${r.head.slice(0, 12)}, a commit never reported; report it with atelier fast ready ${id}.`);
  console.log(`Then: commit with your Agent line, then atelier fast ready ${id}. Nothing is pushed; the developer merges it and records the merge with atelier record-merge.`);
}

// atelier fast ready ID, in the clone fast take made: reports its head, or
// --commit, as ready to merge, with the main the clone was made at and
// the builder the commit's Agent line names.
async function fastReadyReport(name) {
  const id = itemArg(2);
  const as = await actor();
  const cwd = process.cwd();
  if (wsConfig("fast", cwd) !== "true" || wsConfig("item", cwd) !== id) die(`run atelier fast ready ${id} in the clone atelier fast take ${id} made`);
  const base = wsConfig("base", cwd);
  const commit = git(["rev-parse", "--verify", `${typeof args.commit === "string" ? args.commit : "HEAD"}^{commit}`], { cwd });
  const builder = agentOfMessage(git(["log", "-1", "--format=%B", commit], { cwd }));
  if (!builder) die(`${commit.slice(0, 12)} has no Agent: line naming its builder; amend it to end with Agent: ${as}`);
  const top = git(["rev-parse", "--show-toplevel"], { cwd });
  const r = await call("POST", `${I(name, id)}/fast-ready`, { commit, base, builder, workspace: top }, as);
  console.log(`${id} is ready to merge at ${r.ready.commit}, built by ${r.ready.builder} on main at ${r.ready.base.slice(0, 12)}. The developer merges it and records the merge: atelier record-merge ${id} --merge SHA --review H/M=approve@${r.ready.commit}`);
}
