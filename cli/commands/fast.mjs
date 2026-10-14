// atelier fast. Its forms, flags and help are declared in src/usage/commands/fast.ts.
import { COMMAND_USAGE } from "../help.mjs";
import { I, OWNER, P, actingHeaders, actor, args, call, cfg, die, fastTakeWorkspace, git, itemArg, landingGit, project, wsConfig } from "../atelier.mjs";
import { behindRefusal } from "../pull.mjs";
import { DEFAULT_REGEN, fastCommands, fastLand, parsePairs, postPending, readPending, readySources, shellQuote } from "../fast.mjs";
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
  if (sub === "record" && rest.length <= 1) return void await fastRecord(name, rest[0]);
  if (sub !== "land") die(COMMAND_USAGE.fast);
  let pairs;
  try { pairs = parsePairs(rest); } catch (err) { die(`${err.message}: atelier fast land tN=SHA [tM=SHA ...]`); }
  if (args.reviewer !== undefined && (typeof args.reviewer !== "string" || !args.reviewer.includes("/"))) die("--reviewer names harness/model");
  const mode = await call("GET", `${P(name)}/mode`, undefined, OWNER);
  if (mode.mode !== "fast") die(`${mode.line}: switch with atelier mode fast --reason TEXT before landing fast`);
  const cwd = process.cwd();
  // Main as fast land leaves it is published to the baseline afterwards. When
  // another checkout has moved the baseline on (t644), that push would be
  // refused after the merges, checks and receipts, so fast land refuses
  // first and names atelier pull.
  const base = await call("POST", `${P(name)}/baseline-token`, { scope: "read" }, OWNER);
  landingGit(["fetch", "--quiet", "--no-tags", base.remote, "main"], { cwd, token: base.token });
  const baselineHead = landingGit(["rev-parse", "FETCH_HEAD"], { cwd });
  const gitDir = landingGit(["rev-parse", "--absolute-git-dir"], { cwd });
  const behind = behindRefusal(landingGit, cwd, { gitDir, name, fresh: cfg.projects?.[name]?.fresh === true, branch: "main", baselineHead, nothing: "Nothing was merged.", command: `atelier fast land ${rest.join(" ")} --project ${name}` });
  if (behind) die(behind);
  // The typecheck and tests from the checkout's own scripts, or a refusal
  // naming the flag, before anything merges (t667).
  const commands = fastCommands(cwd, { typecheck: args.typecheck, test: args.test });
  if (commands.refusal) die(`fast land: ${commands.refusal}`);
  const titles = {};
  for (const { id } of pairs) {
    const item = await call("GET", I(name, id), undefined, OWNER);
    const it = item.item ?? item;
    if (["merged", "abandoned"].includes(it.state)) die(`${id} is ${it.state}`);
    titles[id] = it.title;
  }
  // The default test runs in a temporary clean clone of the batch's head
  // (t588); a --test the owner gives runs in the checkout, where it says.
  const result = await fastLand({
    cwd, pairs, titles, reason: mode.reason,
    // A commit a runner built in fast mode on this machine is fetched from
    // the clone its report names, when this checkout lacks it (t589).
    sources: readySources(mode.ready ?? [], pairs),
    typecheck: commands.typecheck,
    test: commands.test,
    cleanClone: commands.cleanClone,
    regen: args.regen ?? DEFAULT_REGEN(cwd),
    // Kept in the receipts file, so atelier fast record posts the rest as
    // this run would have (Astra's audit of 2026-10-13, finding 9).
    note: { project: name, ...(args.reviewer ? { reviewer: args.reviewer } : {}) },
    // The project's private files (t645), refused in what the batch lands.
    project: name,
    log: (line) => console.log(line),
    record: recorder(name, args.reviewer),
  });
  printLanded(result.landed);
  if (!result.ok) {
    // Rollback could not put main back (third review of t592): say so first,
    // with main's head and the fix, never "main is back".
    if (result.restored === false) die(`fast land stopped at ${result.failure.step}, and ${result.restoreProblem}\nNothing was recorded.\n${result.failure.detail}`);
    if (result.failure.merged) die(unrecordedMessage(name, result));
    die(`fast land stopped at ${result.failure.step}; main is back at ${result.start.slice(0, 12)}, nothing was recorded.\n${result.failure.detail}`);
  }
  console.log(`Main is at ${result.head.slice(0, 12)}. Nothing was pushed or deployed. Next: publish main (git push) and deploy (npm run deploy) as you do after a landing.`);
}

// Posts one landed-fast receipt; the server answers a receipt it already
// holds for the same merge commit with the one it recorded.
const recorder = (name, reviewer) => (id, receipt) => call("POST", `${I(name, id)}/landed-fast`, { ...receipt, ...(reviewer ? { reviewer } : {}) }, OWNER, actingHeaders());

function printLanded(landed) {
  for (const l of landed) {
    const review = l.answer?.review;
    const asked = review?.request !== undefined ? `post-merge review request ${review.request} asked of ${review.reviewer}` : review?.error ? `post-merge review not asked: ${review.detail}` : `no post-merge review asked; ask one with atelier review-request ${l.id} --reviewer H/M`;
    console.log(`${l.id} landed in fast mode: ${l.commit.slice(0, 12)} merged as ${l.mergeCommit.slice(0, 12)}, built by ${l.builder}; ${asked}`);
  }
}

// A receipt failed after the merges (finding 9): which were recorded, which
// were not, and the command that records the rest without merging again.
function unrecordedMessage(name, result) {
  const list = (ids) => ids.length ? ids.join(", ") : "none";
  return [
    `${result.failure.step} failed: ${result.failure.detail}`,
    `Main holds the batch${result.head ? ` at ${result.head.slice(0, 12)}` : ""}. Recorded: ${list(result.recorded ?? [])}. Not recorded: ${list(result.unrecorded ?? [])}.`,
    `Record the rest, without merging again: atelier fast record ${shellQuote(result.pending)} --project ${name}`,
  ].join("\n");
}

// atelier fast record [FILE]: posts the receipts a fast land wrote under
// .git and could not all post, never merging (finding 9). It refuses when
// main no longer holds a receipt's merge commit.
async function fastRecord(name, file) {
  if (args.reviewer !== undefined && (typeof args.reviewer !== "string" || !args.reviewer.includes("/"))) die("--reviewer names harness/model");
  let kept;
  try { kept = readPending(process.cwd(), file); } catch (err) { die(`fast record: ${err.message}`); }
  if (kept.project && kept.project !== name) die(`fast record: ${kept.file} holds receipts for project ${kept.project}, not ${name}; run it with --project ${kept.project}`);
  // The reviewer fast land was given, unless --reviewer names another.
  const result = await postPending(kept, recorder(name, args.reviewer ?? kept.reviewer));
  printLanded(result.landed);
  if (!result.ok) die(unrecordedMessage(name, { ...result, head: null }));
  console.log(`Every receipt of the batch is recorded${result.already.length ? ` (${result.already.join(", ")} already were)` : ""}; ${result.file} is removed. Nothing was merged, pushed or deployed.`);
}

// atelier fast take ID: the holder is recorded, no fork is made, and the
// build gets a clean clone of main on this machine. With --json the last
// line is the answer the runner reads: the clone, its base, and whether an
// unreported commit was kept.
async function fastTake(name) {
  const id = itemArg(2);
  const as = await actor();
  const runner = typeof args.runner === "string" ? args.runner : null;
  const r = await fastTakeWorkspace(name, id, as, runner);
  if (args.json) return console.log(JSON.stringify({ item: r.item, dir: r.dir, base: r.base, head: r.head, resumed: r.resumed }));
  console.log(`${id} is yours, ${as}, in fast mode: no fork, no write token. Work here, in a clean clone of main at ${r.base.slice(0, 12)}:\n  cd ${shellQuote(r.dir)}`);
  if (r.resumed) console.log(`The clone holds ${r.head.slice(0, 12)}, a commit never reported; report it with atelier fast ready ${id}.`);
  console.log(`Then: commit with your Agent line, then atelier fast ready ${id}. Nothing is pushed; the developer lands it with atelier fast land.`);
}

// atelier fast ready ID, in the clone fast take made: reports its head, or
// --commit, as ready for fast land, with the main the clone was made at and
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
  console.log(`${id} is ready for fast land at ${r.ready.commit}, built by ${r.ready.builder} on main at ${r.ready.base.slice(0, 12)}. The developer lands it: atelier fast land ${id}=${r.ready.commit}`);
}
