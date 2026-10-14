// atelier private. Its forms, flags and help are declared in src/usage/commands/private.ts.
import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { privatePath } from "../../src/rules.ts";
import { COMMAND_USAGE } from "../help.mjs";
import { args, cfg, die, project, saveConfig } from "../atelier.mjs";
import { excludesPrivate, linkPrivate, privateHome, privateState, trackedPrivate } from "../private.mjs";

// The developer names the project's private files on this Mac (t645). The
// names live beside the checkout's path in this Mac's config.json, never on
// the server; the files live in the project's iCloud folder.
export default async function privateCommand() {
  const [, sub, ...rest] = args._;
  if (sub === "add" && (rest.length || typeof args.home === "string")) return add(rest);
  if (sub === "ls" && !rest.length) return ls();
  die(COMMAND_USAGE.private);
}

function entryOf(name) {
  const entry = cfg.projects?.[name];
  if (!entry?.path) die(`${name} has no checkout registered on this Mac; make one with atelier clone ${name}, then name its private files`);
  return entry;
}

function add(words) {
  const name = project(), entry = entryOf(name);
  // Everything is checked before the config changes.
  const paths = [];
  for (const word of words) {
    const r = privatePath(word);
    if ("error" in r) die(`${r.error}; nothing was changed`);
    if (!paths.includes(r.path)) paths.push(r.path);
  }
  let home = entry.privateHome;
  if (typeof args.home === "string") {
    home = resolve(args.home);
    if (!existsSync(home) || !statSync(home).isDirectory()) die(`${home} is not a folder on this Mac; nothing was changed`);
  }
  if (existsSync(entry.path)) {
    let tracked;
    try { tracked = trackedPrivate(entry.path, paths); } catch (error) { die(`${error.message}; nothing was changed`); }
    if (tracked.length) die(`Git tracks ${tracked.join(", ")} in ${entry.path}, so ${tracked.length === 1 ? "it is" : "they are"} not private: the baseline may already hold ${tracked.length === 1 ? "it" : "them"}. Stop tracking ${tracked.length === 1 ? "it" : "them"} first (git rm --cached PATH, then commit), then name ${tracked.length === 1 ? "it" : "them"} again. Nothing was changed.`);
  }
  const named = [...(entry.private ?? [])];
  const added = paths.filter((path) => !named.includes(path));
  entry.private = [...named, ...added];
  if (home) entry.privateHome = home;
  saveConfig(cfg);
  console.log(added.length ? `${name}: ${added.join(", ")} ${added.length === 1 ? "is" : "are"} now private on this Mac.` : `${name}: no new private file; ${entry.private.length ? `it names ${entry.private.join(", ")}` : "it names none yet"}.`);
  if (typeof args.home === "string") console.log(`${name}'s private files are kept in ${home}.`);
  if (!existsSync(entry.path)) return console.log(`${entry.path}, ${name}'s checkout, is not on this Mac; atelier clone links them when it makes one.`);
  let r;
  try { r = linkPrivate(entry.path, entry, { name }); } catch (error) { die(error.message); }
  for (const line of r.said) console.log(line);
  if (r.refused.length) process.exitCode = 1;
}

function ls() {
  const name = project(), entry = entryOf(name);
  const paths = entry.private ?? [];
  const found = privateHome(name, entry);
  const where = found.error ? `no folder: ${found.error}` : `${found.home}${found.named ? "" : ` (found by ${name}'s name)`}${existsSync(found.home) ? "" : ", not on this Mac"}`;
  console.log(`${name}: private files are kept in ${where}.`);
  if (!paths.length) return console.log(`${name} names no private files on this Mac. Name one with atelier private add PATH --project ${name}.`);
  const there = existsSync(entry.path);
  const sameFolder = there && !found.error && existsSync(found.home) && realpathSync(found.home) === realpathSync(entry.path);
  const STATES = {
    linked: "linked", missing: `not in ${found.home ?? "the folder"}`, file: "a file Atelier did not link is in the checkout",
    "other-link": "a link to somewhere else", absent: "not linked yet: run atelier private add again",
  };
  for (const path of paths) {
    let state;
    if (!there) state = "the checkout is not on this Mac";
    else if (sameFolder) state = "kept in place: the checkout is that folder";
    else if (found.error) state = "not linked";
    else state = STATES[privateState(entry.path, found.home, path)];
    const ignored = there ? (excludesPrivate(entry.path, path) ? "ignored by Git" : "NOT ignored by Git: run atelier private add again") : "";
    console.log(`  ${path}: ${state}${ignored ? `; ${ignored}` : ""}`);
  }
}
