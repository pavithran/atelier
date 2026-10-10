// atelier publish. Its forms, flags and help are declared in src/usage/commands/publish.ts.
import { OWNER, P, call, cfg, die, git, project, short } from "../atelier.mjs";

// The project owner: push commits made directly in the checkout so new forks start from them.
export default async function publishCommand() {
  const name = project();
  const p = cfg.projects?.[name] ?? die(`${name} is not registered on this Mac; run atelier init in it`);
  if (p.fresh === true) die(`${name}'s baseline holds part of its history; atelier sync carries new commits to it`);
  const t = await call("POST", `${P(name)}/baseline-token`, { scope: "write" }, OWNER);
  git(["push", "--quiet", "--recurse-submodules=no", t.remote, `${p.branch}:${p.branch}`], { cwd: p.path, token: t.token });
  console.log(`Baseline ${name} now at ${short(git(["rev-parse", p.branch], { cwd: p.path }))}.`);
}
