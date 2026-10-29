// atelier projects. Its forms, flags and help are declared in src/usage/commands/projects.ts.
import { join } from "node:path";
import { COMMAND_USAGE } from "../help.mjs";
import { CACHE, OWNER, P, actor, args, call, cfg, die, project, saveConfig, server } from "../atelier.mjs";
import { moveConflict, moveProjectEntryOnDisk, releaseFormerName } from "../private-guard.mjs";

// The old host's token for move-host and migrate, read from the variable
// --token-env names, so it never stands in the command line or a shell's
// history. None without the flag.
export function sourceToken(command) {
  if (args["token-env"] === undefined) return null;
  const variable = args["token-env"];
  if (typeof variable !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) die(`--token-env names an environment variable: ${command} --token-env ARTIFACTS_TOKEN`);
  const value = process.env[variable]?.trim();
  if (!value) die(`${variable} is not set, so there is no token to read the old host with; set it, then run ${command} again`);
  return value;
}

// atelier projects move-host (Atelier 2.0, task 11; design section 5): the
// server mirrors the project's branch, notes and tags from its old host into
// its repository here, and during the bake pushes the branch back after each
// landing so the way back stays open.
async function moveHostCommand(name) {
  const command = `atelier projects move-host ${name}`;
  const modes = ["push-back", "end-bake"].filter((f) => args[f] === true);
  if (modes.length > 1 || (modes.length && (args.from !== undefined || args["way-back"] === true))) die(`move-host does one thing at a time: --from REMOTE [--way-back], --push-back or --end-bake`);
  const at = new URL(server()).host;
  if (args["end-bake"] === true) {
    const r = await call("POST", `${P(name)}/move-host`, { endBake: true }, await actor(OWNER));
    return console.log(r.ended ? `${name} on ${at}: the way back is forgotten; landings no longer push ${r.branch} to the old baseline.` : `${name} on ${at} kept no way back; nothing changed.`);
  }
  if (args["push-back"] === true) {
    const r = await call("POST", `${P(name)}/move-host`, { pushBack: true }, await actor(OWNER));
    return console.log(`${name} on ${at}: ${r.branch} @ ${r.wayBack.head.slice(0, 8)} pushed back to ${r.wayBack.remote}${r.wayBack.notes ? `; notes ${r.wayBack.notes}` : ""}.`);
  }
  if (typeof args.from !== "string" || !args.from) die(`name the old host's repository: ${command} --from REMOTE [--token-env VAR] [--way-back]`);
  const token = sourceToken(command);
  if (args["clear-secret"] !== undefined && (typeof args["clear-secret"] !== "string" || typeof args.quote !== "string")) die(`clearing a key-shaped line in moved history needs the reason and the developer's words: ${command} --from REMOTE --clear-secret "why it is safe" --quote "the developer's words"`);
  const r = await call("POST", `${P(name)}/move-host`, { remote: args.from, ...(token ? { token } : {}), ...(args["way-back"] === true ? { wayBack: true } : {}), ...(typeof args["clear-secret"] === "string" ? { clearSecret: args["clear-secret"], quote: args.quote } : {}) }, await actor(OWNER));
  const said = {
    created: `now holds ${r.branch} @ ${r.head.slice(0, 8)}, equal to ${r.remote}'s`,
    forwarded: `moved ${r.branch} on from ${String(r.before).slice(0, 8)} to ${r.head.slice(0, 8)}, equal to ${r.remote}'s`,
    unchanged: `already held ${r.branch} @ ${r.head.slice(0, 8)}, equal to ${r.remote}'s`,
    ahead: `holds ${r.branch} @ ${String(r.before).slice(0, 8)}, which already holds ${r.remote}'s ${r.remoteHead.slice(0, 8)}; nothing moved`,
  }[r.moved];
  console.log([
    `${name}'s repository on ${at} ${said}.`,
    `Notes: ${r.notes}; tags: ${r.tags}.${r.proseStandard ? ` The prose standard's text was read from ${r.proseStandard}.` : ""}`,
    r.wayBack ? `During the bake each landing pushes ${r.branch} back to ${r.wayBack.remote}; end it with ${command} --end-bake.` : "No way back is kept: landings push nothing to the old host.",
    `Builders clone ${r.remote}. Tasks still on Artifacts forks move with atelier migrate tN --from REMOTE --project ${name}.`,
  ].join("\n"));
}

// The project owner renames a project on the server, or removes it.
export default async function projectsCommand() {
  const [, sub, name, to] = args._;
  if (sub === "move-host") {
    if (!name || args._.length !== 3) die(COMMAND_USAGE.projects);
    return await moveHostCommand(name);
  }
  for (const flag of ["from", "token-env", "way-back", "push-back", "end-bake", "clear-secret", "quote"]) if (args[flag] !== undefined) die(`atelier projects ${sub ?? ""} does not take --${flag}; only move-host does`);
  if (sub === "rename") {
    if (!name || !to || args._.length !== 4) die(COMMAND_USAGE.projects);
    // The local move is checked first: a rename the local config would then
    // refuse is not made on the server either (Astra's eighth review of
    // t645), so nothing is left half done.
    const conflict = moveConflict(cfg.projects, name, to);
    if (conflict) die(`${name} was not renamed: ${conflict}`);
    const release = args["release-name"] === true;
    const r = await call("POST", `${P(name)}/rename`, { to, ...(release ? { releaseName: true } : {}) }, await actor(OWNER));
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
      // Made in config.json under its lock, and followed in memory.
      const moved = moveProjectEntryOnDisk(cfg.projects, r.from, r.to);
      if (moved.error) die(`${r.from} is now ${r.to} on ${server()}, but ${moved.error}`);
      const settings = Object.entries(moved.dropped ?? {}).map(([k, v]) => `${k} ${typeof v === "string" ? v : JSON.stringify(v)}`);
      local = into
        ? `The local config already had an entry ${r.to}, which is kept; the entry ${r.from} was dropped${settings.length ? ` (it held: ${settings.join(", ")})` : ""}, its private files joined to ${r.to}'s.`
        : `The local config entry ${r.from} is now ${r.to}.`;
    }
    console.log(`${r.from} is now ${r.to} on ${server()}. Its Ledger, baseline ${r.project.repo} and every branch stay where they are. ${local}`);
    if (release && r.released !== r.from) {
      // A server from before t774 ignores the field: the project was renamed and still answers to the old name.
      console.error(`${r.from} was renamed, but this server did not release the name (it predates --release-name), so ${r.from} still reaches the project. Update the server before creating a project under ${r.from}.`);
      process.exitCode = 1;
      return;
    }
    if (release) {
      // The local entry must not answer to the released name either (t774).
      releaseFormerName(cfg.projects, r.to, r.from);
      console.log(`${r.from} is released: it no longer reaches ${r.to}, and a project created under it is stored apart, with its own ledger and baseline repository. Tokens limited to ${r.from} are limited to ${r.to} now (${r.rescoped} changed). Page links and runner configs that name ${r.from} reach whatever project holds that name, so update them.`);
      return;
    }
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
  console.log(`${name} removed from the project index and local config.${dropped} The project's repository and its Ledger data are retained. Deleting a repository requires a separate, deliberate action by the developer.`);
}
