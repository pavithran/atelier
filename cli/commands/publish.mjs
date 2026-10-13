// atelier publish. Its forms, flags and help are declared in src/usage/commands/publish.ts.
import { OWNER, P, args, call, cfg, die, git, project, short } from "../atelier.mjs";
import { COMMAND_USAGE } from "../help.mjs";
import { publishMirror } from "../mirror.mjs";

// The project owner: push commits made directly in the checkout so new forks
// start from them. With a REMOTE, it publishes the registered branch to the
// public mirror the publication policy declares, after the privacy check
// (cli/mirror.mjs); the baseline is not touched.
export default async function publishCommand() {
  if (args._.length > 2) die(COMMAND_USAGE.publish);
  if (args._[1] === undefined) return publishBaseline();
  const name = project();
  const p = cfg.projects?.[name] ?? die(`${name} is not registered on this Mac; run atelier init in it`);
  const { project: record } = await call("GET", P(name), undefined, OWNER);
  const r = publishMirror({ git, dir: p.path, branch: p.branch, remote: args._[1], say: console.log, identity: record?.policy?.commitIdentity });
  if (!r.ok) process.exit(1);
}

// The baseline alone: bare `publish`, and the step `wrap` ends with.
export async function publishBaseline() {
  const name = project();
  const p = cfg.projects?.[name] ?? die(`${name} is not registered on this Mac; run atelier init in it`);
  if (p.fresh === true) die(`${name}'s baseline holds part of its history; atelier sync carries new commits to it`);
  const t = await call("POST", `${P(name)}/baseline-token`, { scope: "write" }, OWNER);
  git(["push", "--quiet", "--recurse-submodules=no", t.remote, `${p.branch}:${p.branch}`], { cwd: p.path, token: t.token });
  console.log(`Baseline ${name} now at ${short(git(["rev-parse", p.branch], { cwd: p.path }))}.`);
}
