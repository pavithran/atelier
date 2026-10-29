// atelier sync. Its forms, flags and help are declared in src/usage/commands/sync.ts.
import { cfg, die, project } from "../atelier.mjs";

// The server keeps the project's repository itself, and that repository is
// the baseline: there is no separate baseline to carry commits to, and only
// a landing moves its branch (Atelier 2.0, tasks 6 and 11). sync refuses,
// naming atelier pull for one direction and a landing for the other.
export default async function syncCommand() {
  const name = project();
  const p = cfg.projects?.[name] ?? die(`${name} is not registered on this Mac`);
  die(serverSyncRefusal(name, p.branch ?? "main"));
}

// sync's answer, which wrap also gives for a checkout set up with part of
// its history: what to run instead, each way.
export function serverSyncRefusal(name, branch) {
  return `${name}'s server keeps the project's repository itself, and that repository is the baseline: there is no separate baseline to carry commits to, and only a landing moves ${branch} there. Nothing was sent.\nnext: atelier pull --project ${name} brings this checkout to the server's ${branch}; commits made here outside Atelier reach it as a task: atelier new "TITLE" --project ${name}, claim it, push them to its branch, then atelier land tN --project ${name}`;
}
