// atelier adopt. Its forms, flags and help are declared in src/usage/commands/adopt.ts.
import { assertEligible } from "../../src/rules.ts";
import { SCOPE, adoption, writeMove } from "../adopt.mjs";
import { guideText } from "../help.mjs";
import { I, OWNER, P, actor, call, cfg, claimWorkspace, die, git, project } from "../atelier.mjs";

// Move one project from ControlPlane to Atelier. This is itself an Atelier
// task: adopt creates it, claims it, and writes the forwarding entry point
// and the Atelier guide into its workspace, where the agent that finishes
// the task works. The checkout is read and reported on, never changed.
export default async function adoptCommand() {
  const name = project();
  const p = cfg.projects?.[name];
  if (!p?.path) die(`${name} is not registered on this Mac; run atelier init in its checkout first`);
  if (git(["status", "--porcelain"], { cwd: p.path })) die(`${p.path} has uncommitted changes; commit or set them aside before moving ${name}`);
  // Every check that can refuse the move runs on the checkout first — the
  // files readable and computable, no symlink in the way — so a refusal
  // leaves nothing behind: no task, no claim, no workspace.
  try { adoption({ project: name, checkout: p.path, workspace: p.path, guide: guideText() }); }
  catch (error) { die(error.message); }
  const as = await actor(OWNER);
  // The project's policy says who may claim here. It is asked before the
  // task exists, as the claim would ask it, so an agent it does not admit
  // leaves no unclaimed task behind.
  const { project: record } = await call("GET", P(name), undefined, as);
  try { assertEligible(as, record?.policy ?? {}, OWNER); }
  catch (error) { die(`${error.message}. The move was not started; run it as an eligible agent: atelier adopt --project ${name} --as HARNESS/MODEL`); }
  const item = await call("POST", `${P(name)}/items`, { title: `Move ${name} from ControlPlane to Atelier`, scope: SCOPE }, as);
  const { dir } = await claimWorkspace(name, item.id, as);
  let plan;
  try { plan = adoption({ project: name, checkout: p.path, workspace: dir, guide: guideText() }); }
  catch (error) { die(error.message); }
  try { writeMove(dir, plan.files); }
  catch (error) { die(error.message); }
  git(["add", "--", ...plan.files.map((f) => f.path)], { cwd: dir });
  // Adopting a project that already moved leaves the workspace as it is;
  // committing nothing keeps that a success rather than a git failure.
  const moved = git(["diff", "--cached", "--quiet"], { cwd: dir, allowFail: true }).status !== 0;
  if (moved) git(["commit", "--quiet", "-m", plan.message], { cwd: dir });
  console.log(`${item.id} is yours, ${as}. ${moved
    ? "The move is committed here and not pushed:"
    : "The move is already in place; nothing to commit:"}\n  cd ${JSON.stringify(dir)}`);
  console.log(plan.leftovers.length
    ? `\nLeftovers in ${p.path} for the agent finishing ${item.id}:`
    : `\nNothing in ${p.path} is left over from ControlPlane.`);
  for (const line of plan.leftovers) console.log(`  ${line}`);
  // A task has no note field of its own, so the same list is recorded on it
  // as reported claims, which the task's page shows to the reviewer and the
  // owner. Reports are never counted as evidence.
  for (const line of plan.leftovers) await call("POST", `${I(name, item.id)}/evidence`, { kind: "report", claim: line, head: item.head }, as);
  if (plan.leftovers.length) console.log(`The same lines are recorded on ${item.id} as reported notes.`);
}
