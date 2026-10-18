// atelier branch. Its forms, flags and help are declared in src/usage/commands/branch.ts.
import { hostname } from "node:os";
import { developerBranch } from "../../src/rules.ts";
import { COMMAND_USAGE } from "../help.mjs";
import { pinnedPush } from "../checkout-push.mjs";
import { branchLine, formatDeveloperBranches } from "../status.mjs";
import { OWNER, P, actor, args, call, cfg, die, landingGit, project, request, short, wsConfig } from "../atelier.mjs";

// The developer carries work in progress between their Macs (t641) on
// branches under wip/, kept in the project's branches repository beside the
// baseline (developerBranch in src/rules.ts says why it is a repository of
// its own). Each command mints its own short-lived token for that
// repository alone, which only the developer is given, sends it to the one
// Git command that needs it and keeps it nowhere; every Git command runs
// with every hook off (landingGit), so no hook of the checkout sees it.
// The name is checked here before a token is minted, and
// the push names one ref on both sides, so nothing but that branch moves.
// The push goes through pinnedPush: the branch is resolved to its commit
// once, and that commit is what is pushed.
export default async function branchCommand() {
  const git = landingGit;
  const [, sub, given] = args._;
  if (sub === "ls" && args._.length === 2) {
    // ls takes no flag of its own (Argon's review of t641).
    if (args.force !== undefined) die("atelier branch ls does not take --force");
    return list();
  }
  if (!["push", "fetch"].includes(sub) || args._.length > 3 || (sub === "fetch" && given === undefined)) die(COMMAND_USAGE.branch);
  if (wsConfig("project")) die("atelier branch carries the developer's own work between Macs, from the project's checkout; this folder is a task workspace, whose work moves through atelier push");
  const name = project(), as = await actor(OWNER);
  const dir = cfg.projects?.[name]?.path ?? die(`${name} has no checkout on this Mac; make one with atelier clone ${name}`);
  const current = git(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: dir, allowFail: true });
  const here = current.status === 0 ? current.stdout.trim() : null;
  const asked = given ?? here ?? die(`the checkout at ${dir} has no branch checked out; name the branch: atelier branch push wip/NAME`);
  let branch;
  try { branch = developerBranch(String(asked), cfg.projects[name].branch ?? "main"); } catch (error) { die(`${error.message}. Nothing was ${sub === "push" ? "pushed" : "fetched"}`); }
  const ref = `refs/heads/${branch}`, spec = `${args.force === true ? "+" : ""}${ref}:${ref}`;

  if (sub === "push") {
    const local = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: dir, allowFail: true });
    if (local.status !== 0) die(`the checkout at ${dir} has no branch ${branch}${branch !== asked ? `; name yours ${branch} first (git branch -m ${asked} ${branch})` : ""}. Nothing was pushed`);
    const token = await call("POST", `${P(name)}/branches/token`, { scope: "write" }, as);
    const commit = pinnedPush({ cwd: dir, tip: ref, what: `Not pushed to ${name}'s branches repository: ${branch}`, fail: die },
      (sha) => {
        git(["push", "--quiet", "--no-follow-tags", "--recurse-submodules=no", token.remote, `${args.force === true ? "+" : ""}${sha}:${ref}`], { cwd: dir, token: token.token });
        return sha;
      });
    const host = hostname().replace(/\.local$/i, "");
    // A push another Mac made and recorded since is the tip the server
    // keeps; this one is then not recorded over it (t641), and that is said.
    const recorded = await request("POST", `${P(name)}/branches`, { name: branch, commit, host }, as).catch((error) => {
      if (String(error.message).startsWith("branch_moved: ")) die(`${name}: pushed ${branch} @ ${short(commit)}, but ${error.message.slice("branch_moved: ".length)}`);
      die(error.message, error.code ?? 1);
    });
    console.log(`${name}: pushed ${branchLine(recorded)} to the project's branches repository. The baseline's main is untouched; on another Mac, atelier branch fetch ${branch.slice("wip/".length)} brings it there.`);
    return;
  }

  if (here === branch) die(`${branch} is checked out at ${dir}; switch to another branch first (git switch ${cfg.projects[name].branch ?? "main"}), then fetch it. Nothing was fetched`);
  const before = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: dir, allowFail: true });
  const token = await call("POST", `${P(name)}/branches/token`, { scope: "read" }, as);
  git(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", token.remote, spec], { cwd: dir, token: token.token });
  const after = git(["rev-parse", ref], { cwd: dir });
  const read = await request("GET", `${P(name)}/branches`, undefined, as).catch(() => null);
  const recorded = Array.isArray(read?.branches) ? read.branches.find((b) => b.name === branch) : null;
  const from = recorded?.commit === after ? `, pushed from ${recorded.host}` : "";
  const was = before.status === 0 ? before.stdout.trim() : null;
  console.log(`${name}: ${was === after ? `${branch} was already at ${short(after)}` : `fetched ${branch} @ ${short(after)}${was ? ` (was ${short(was)})` : ""}`}${from} into ${dir}.`);
}

async function list() {
  const name = project(), as = await actor(OWNER);
  const read = await call("GET", `${P(name)}/branches`, undefined, as);
  console.log(formatDeveloperBranches(read.branches, ""));
}
