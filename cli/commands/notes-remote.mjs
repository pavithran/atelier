// atelier notes-remote. Its forms, flags and help are declared in src/usage/commands/notes-remote.ts.
import { args, cfg, die, git, project, saveConfig } from "../atelier.mjs";

// One line per live item, for a wrap to copy into STATE.md's Owner section.
// The project owner: choose a remote that receives refs/notes/atelier on every
// merge, or --off. Kept per Mac, beside the checkout path, never on the server.
export default async function notesRemoteCommand() {
  const name = project();
  const p = cfg.projects?.[name] ?? die(`${name} is not registered on this Mac`);
  if (args.off) {
    delete p.notesRemote;
    saveConfig(cfg);
    return console.log(`${name}: provenance notes stay local and in Artifacts.`);
  }
  const remote = args._[1];
  if (!remote) return console.log(p.notesRemote ? `${name}: notes go to ${p.notesRemote} on each merge.` : `${name}: notes stay local and in Artifacts. Set one with: atelier notes-remote REMOTE`);
  if (!git(["remote"], { cwd: p.path }).split("\n").includes(remote)) die(`${p.path} has no remote called ${remote}`);
  p.notesRemote = remote;
  saveConfig(cfg);
  console.log(`${name}: each merge now pushes refs/notes/atelier to ${remote}. The merged branch is never pushed.`);
}
