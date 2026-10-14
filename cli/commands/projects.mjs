// atelier projects. Its forms, flags and help are declared in src/usage/commands/projects.ts.
import { join } from "node:path";
import { COMMAND_USAGE } from "../help.mjs";
import { CACHE, OWNER, P, actor, args, call, cfg, die, project, saveConfig, server } from "../atelier.mjs";
import { moveConflict, moveProjectEntry } from "../private.mjs";

// The project owner renames a project on the server, or removes it.
export default async function projectsCommand() {
  const [, sub, name, to] = args._;
  if (sub === "rename") {
    if (!name || !to || args._.length !== 4) die(COMMAND_USAGE.projects);
    // The local move is checked first: a rename the local config would then
    // refuse is not made on the server either (Astra's eighth review of
    // t645), so nothing is left half done.
    const conflict = moveConflict(cfg.projects, name, to);
    if (conflict) die(`${name} was not renamed: ${conflict}`);
    const r = await call("POST", `${P(name)}/rename`, { to }, await actor(OWNER));
    // The server answers the new name for both when the request named it
    // to finish a rename: no entry moves, and the one under it stays.
    if (r.from === r.to) return console.log(`${r.to} is the project's name on ${server()}, and the rename that gave it that name is complete. The local config is unchanged.`);
    // The server says which name the project was registered under; the
    // local entry moves from that name. An entry already under the new
    // name is kept, and the old one dropped, saying what it held.
    let local = `No local config entry was called ${r.from}.`;
    // The old name is kept with the entry as a former name, and a merge
    // into an entry already under the new name keeps every private setting
    // (moveProjectEntry, t645): a task workspace made before the rename
    // still names the old one, and the private-file guard finds the entry
    // by it.
    const held = cfg.projects?.[r.from];
    if (held) {
      const into = !!cfg.projects[r.to];
      const moved = moveProjectEntry(cfg.projects, r.from, r.to);
      if (moved.error) die(`${r.from} is now ${r.to} on ${server()}, but ${moved.error}`);
      saveConfig(cfg);
      const settings = Object.entries(moved.dropped ?? {}).map(([k, v]) => `${k} ${typeof v === "string" ? v : JSON.stringify(v)}`);
      local = into
        ? `The local config already had an entry ${r.to}, which is kept; the entry ${r.from} was dropped${settings.length ? ` (it held: ${settings.join(", ")})` : ""}, its private files joined to ${r.to}'s.`
        : `The local config entry ${r.from} is now ${r.to}.`;
    }
    console.log(`${r.from} is now ${r.to} on ${server()}. Its Ledger, baseline ${r.project.repo} and every fork stay where they are. ${local}`);
    console.log(`${r.from} still works: the API serves it under that name, old page links redirect, tokens limited to it keep their access, and workspaces under ${join(CACHE, "work", r.from)} need no change.`);
    return;
  }
  if (sub !== "remove" || !name) die(COMMAND_USAGE.projects);
  await call("DELETE", P(name), { force: args.force === true }, await actor(OWNER));
  // The whole local entry goes; say what it held, since some of it (notesRemote) is set by hand.
  let dropped = "";
  if (cfg.projects?.[name]) {
    const held = Object.entries(cfg.projects[name]).map(([k, v]) => `${k} ${typeof v === "string" ? v : JSON.stringify(v)}`);
    dropped = held.length ? ` Local settings dropped: ${held.join(", ")}.` : "";
    delete cfg.projects[name];
    saveConfig(cfg);
  }
  console.log(`${name} removed from the project index and local config.${dropped} The Artifacts repository and project Ledger data are retained. Deleting a repository requires a separate, deliberate action by the developer.`);
}
