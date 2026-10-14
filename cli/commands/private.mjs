// atelier private. Its forms, flags and help are declared in src/usage/commands/private.ts.
import { existsSync, lstatSync, readlinkSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { privatePath } from "../../src/rules.ts";
import { COMMAND_USAGE } from "../help.mjs";
import { args, cfg, die, project, saveConfig } from "../atelier.mjs";
import { PRIVATE_LIST } from "../../src/rules.ts";
import { excludesPrivate, linkPrivate, privateGuardFor, savePrivateFields, privateList, privateState, readPrivateList, testHold, trackedPrivate, withListLock, writePrivateList } from "../private.mjs";

// The developer names the project's private files (t645). The names go to
// the list beside the files in the project's iCloud folder, which follows the
// developer to every Mac, and to this Mac's config.json; never to the
// server.
export default async function privateCommand() {
  const [, sub, ...rest] = args._;
  if (sub === "add" && (rest.length || typeof args.home === "string")) return add(rest);
  if (sub === "ls" && !rest.length && args.home === undefined) return ls();
  if (sub === "remove" && rest.length && args.home === undefined) return remove(rest);
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
  // A list that is there but cannot be read is never replaced by the names
  // known here (Astra's fifth review of t645): nothing is changed.
  {
    const list = privateList(name, { ...entry, privateHome: home });
    if (list.home && list.unreadable && !list.homeMissing) die(`${list.unreadable}; nothing was changed. Make it readable, then run atelier private add again`);
  }
  const named = [...(entry.private ?? [])];
  const added = paths.filter((path) => !named.includes(path));
  entry.private = [...named, ...added];
  if (home) entry.privateHome = home;
  // Only this project's private settings are written, against the file as
  // it is now (Astra's sixth review of t645).
  savePrivateFields(name, entry, { home: typeof args.home === "string" ? home : null });
  console.log(added.length ? `${name}: ${added.join(", ")} ${added.length === 1 ? "is" : "are"} now private on this Mac.` : `${name}: no new private file; ${entry.private.length ? `it names ${entry.private.join(", ")}` : "it names none yet"}.`);
  if (typeof args.home === "string") console.log(`${name}'s private files are kept in ${home}.`);
  // The list in the folder, so every Mac's clone links them.
  const list = privateList(name, entry);
  if (list.home && existsSync(list.home)) {
    // Every name known goes to the list: the list's own, this Mac's config,
    // the copy of the list this Mac keeps, and the new ones. A list that has
    // gone missing is never rewritten smaller (Astra's fourth review of
    // t645); only private remove drops a name. The list is read and written
    // under its lock, so two commands on this Mac never lose each other's
    // names (Astra's tenth review of t645).
    let before;
    try {
      before = withListLock(list.home, () => {
        const read = readPrivateList(list.home);
        if (read.unreadable) throw new Error(`${read.unreadable}; the list was not rewritten`);
        testHold("list");
        writePrivateList(list.home, [...read.paths, ...entry.private, ...(entry.privateFromList ?? [])]);
        return read;
      });
    } catch (error) { die(`${error.message}; ${name}'s private files are named on this Mac only`); }
    for (const r of before.refused) console.log(`${PRIVATE_LIST} line ${r.line} was dropped: ${r.error}.`);
    console.log(`${join(list.home, PRIVATE_LIST)} lists them, so atelier clone links them on every Mac.`);
  } else console.log(`${name}'s private files are named on this Mac only: ${list.homeError ?? `${list.home} is not on this Mac`}.`);
  if (!existsSync(entry.path)) return console.log(`${entry.path}, ${name}'s checkout, is not on this Mac; atelier clone links them when it makes one.`);
  privateGuardFor(name, { discover: true });
  let r;
  try { r = linkPrivate(entry.path, entry, { name }); } catch (error) { die(error.message); }
  for (const line of r.said) console.log(line);
  if (r.refused.length) process.exitCode = 1;
}

// Drops names from the project's private files: from this Mac's config,
// the copy of the list it keeps and the list in iCloud; the link Atelier
// made for each is removed, the file in iCloud is left as it is. The only
// way a name stops being private.
function remove(words) {
  const name = project(), entry = entryOf(name);
  const paths = [];
  for (const word of words) {
    const r = privatePath(word);
    if ("error" in r) die(`${r.error}; nothing was changed`);
    if (!paths.includes(r.path)) paths.push(r.path);
  }
  const list = privateList(name, entry);
  if (list.unreadable || (list.home && !existsSync(list.home))) die(`${list.unreadable ?? `${list.home} is not on this Mac`}, so its list cannot be rewritten without these names; nothing was changed`);
  const keep = (names) => (names ?? []).filter((p) => !paths.includes(p));
  // The list is read and rewritten under its lock (Astra's tenth review of t645).
  let gone = [];
  const rewrite = () => {
    const read = list.home && existsSync(list.home) ? readPrivateList(list.home) : { paths: [] };
    if (read.unreadable) throw new Error(read.unreadable);
    const known = [...new Set([...(entry.private ?? []), ...(entry.privateFromList ?? []), ...read.paths])];
    gone = paths.filter((p) => known.includes(p));
    if (!gone.length) throw new Error(`${paths.join(", ")} ${paths.length === 1 ? "is" : "are"} not among ${name}'s private files`);
    if (list.home && existsSync(list.home)) writePrivateList(list.home, keep(known));
  };
  try { if (list.home) withListLock(list.home, rewrite); else rewrite(); } catch (error) { die(`${error.message}; nothing was changed`); }
  if (entry.private) entry.private = keep(entry.private);
  if (entry.privateFromList) entry.privateFromList = keep(entry.privateFromList);
  savePrivateFields(name, entry, { drop: gone });
  for (const path of gone) {
    const link = join(entry.path, path);
    try { if (lstatSync(link).isSymbolicLink() && list.home && readlinkSync(link) === join(list.home, path)) unlinkSync(link); } catch { /* not linked here */ }
  }
  console.log(`${name}: ${gone.join(", ")} ${gone.length === 1 ? "is" : "are"} no longer private; the file${gone.length === 1 ? "" : "s"} in iCloud ${gone.length === 1 ? "is" : "are"} left as ${gone.length === 1 ? "it is" : "they are"}.`);
}

function ls() {
  const name = project(), entry = entryOf(name);
  privateGuardFor(name, { discover: true });
  const list = privateList(name, entry);
  const where = list.homeError ? `no folder: ${list.homeError}` : `${list.home}${list.named ? "" : ` (found by ${name}'s name)`}${existsSync(list.home) ? "" : ", not on this Mac"}`;
  console.log(`${name}: private files are kept in ${where}.`);
  for (const r of list.refused) console.log(`  ${PRIVATE_LIST}${r.line ? ` line ${r.line}` : ""}: ${r.error}; skipped.`);
  const paths = list.paths;
  if (!paths.length) return console.log(`${name} names no private files. Name one with atelier private add PATH --project ${name}.`);
  const there = existsSync(entry.path);
  const sameFolder = there && list.home && existsSync(list.home) && realpathSync(list.home) === realpathSync(entry.path);
  const STATES = {
    linked: "linked", missing: `not in ${list.home ?? "the folder"}`, file: "a file Atelier did not link is in the checkout",
    "other-link": "a link to somewhere else", absent: "not linked yet: run atelier private add again", unreadable: "cannot be read here",
  };
  let tracked = new Set();
  try { if (there) tracked = new Set(trackedPrivate(entry.path, paths)); } catch { /* reported per path below as not linked */ }
  for (const path of paths) {
    let state;
    if (!there) state = "the checkout is not on this Mac";
    else if (tracked.has(path)) state = "Git tracks it in the checkout, so it is not private there";
    else if (sameFolder) state = "kept in place: the checkout is that folder";
    else if (!list.home) state = "not linked";
    else state = STATES[privateState(entry.path, list.home, path)];
    const ignored = there ? (excludesPrivate(entry.path, path) ? "ignored by Git" : "NOT ignored by Git: a rule in the checkout (a !-line in a .gitignore) outweighs Atelier's; Atelier still refuses to stage or push it") : "";
    console.log(`  ${path} (listed ${({ iCloud: "in iCloud", "this Mac": "on this Mac", "iCloud and this Mac": "in iCloud and on this Mac" })[list.sources[path]] ?? `in ${list.sources[path]}`}): ${state}${ignored ? `; ${ignored}` : ""}`);
  }
}
