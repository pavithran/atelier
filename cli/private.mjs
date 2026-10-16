// Private files (t645): files a project keeps on the developer's Macs and
// never pushes anywhere, such as PROJECT.md, the developer's plan. Code moves
// between Macs by Git, through a checkout outside iCloud on each Mac; the
// private files stay in the project's iCloud folder, which iCloud syncs, and
// each checkout holds a symbolic link to each of them. Git ignores them
// through the checkout's .git/info/exclude, never .gitignore, which is
// pushed. The folder keeps the list of them too, .atelier-private, so the
// list follows the developer between Macs; the project's entry in this
// Mac's config.json may name more (`private`) and the folder (`privateHome`;
// by default the iCloud ai-projects folder named for the project). The list
// is never linked into a checkout and never pushed.
//
// Atelier never pushes them: wrap refuses to stage one, and every command
// that pushes commits (sync, publish, merge, wrap --push and publish REMOTE)
// or lands them (fast land) refuses a commit that adds, changes or retypes
// one (privateCommits). Git commits a symbolic link as a link, never the
// file it points at, and the refusal covers the link too.
import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { PRIVATE_LIST, foldPath, parsePrivateList, privateExcludeLine, privateFolderMatches, privateListText, privatePath, privatePathsAmong } from "../src/rules.ts";

// The iCloud folder that holds a folder per project.
// ATELIER_PRIVATE_ROOT names another, so tests never read this Mac's own.
export const privateRoot = () => process.env.ATELIER_PRIVATE_ROOT || join(homedir(), "Library", "Mobile Documents", "com~apple~CloudDocs", "ai-projects");

const EXCLUDE_HEADER = "# Private files Atelier links into this checkout (atelier private ls); never committed";

function gitRead(cwd, args, { env } = {}) {
  const merged = { ...process.env, ...env };
  for (const key of ["GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS", "GIT_LITERAL_PATHSPECS"]) delete merged[key];
  return spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: merged });
}

// Git as the checks read history: no replacement refs or grafts rewrite what
// a commit holds (as the mirror's scan reads it), and every setting that
// could hide, rename or reshape a path in the output is set explicitly.
const SCRUBBED = Object.freeze({ GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: "/dev/null/atelier-no-grafts" });
const SCAN_CONFIG = [
  "log.showRoot=true", "log.showSignature=false", "log.follow=false", "log.mailmap=false",
  "diff.renames=false", "diff.noprefix=false", "diff.mnemonicPrefix=false", "diff.relative=false",
  "diff.ignoreSubmodules=none", "core.quotePath=false", "core.precomposeUnicode=true", "color.ui=false",
].flatMap((c) => ["-c", c]);

// The folder that keeps a project's private files: the one its entry names,
// else the one folder in the iCloud ai-projects folder named for it.
export function privateHome(name, entry, root = privateRoot()) {
  if (entry?.privateHome) return { home: entry.privateHome, named: true };
  const found = folderFor(name, root);
  // A project renamed since keeps its folder under an old name: each former
  // name is tried when its own name finds none (Astra's eleventh review of
  // t645).
  if (found.none && !found.rootMissing) {
    for (const former of Array.isArray(entry?.formerNames) ? entry.formerNames : []) {
      const old = folderFor(former, root);
      if (old.home || old.unreadable) return old;
    }
  }
  return found;
}

function folderFor(name, root) {
  let found;
  try {
    found = readdirSync(root, { withFileTypes: true })
      .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && privateFolderMatches(String(name ?? ""), d.name))
      .map((d) => d.name).sort();
  } catch (error) {
    // No iCloud ai-projects folder on this Mac at all is no folder for the
    // project; one that is there and cannot be read hides what may be in it.
    if (error?.code === "ENOENT") return { error: `there is no ${root} on this Mac`, none: true, rootMissing: true };
    return { error: `${root} cannot be read (${error?.code ?? error?.message}), so whether ${name} keeps private files there cannot be known; name its folder with atelier private add --home DIR --project ${name}`, unreadable: true };
  }
  if (found.length === 1) return { home: join(root, found[0]), named: false };
  if (!found.length) return { error: `no folder in ${root} is named for ${name}; name one with atelier private add --home DIR --project ${name}`, none: true };
  return { error: `more than one folder in ${root} is named for ${name} (${found.join(", ")}); name one with atelier private add --home DIR --project ${name}`, unreadable: true };
}

// The list in the folder that keeps the private files: its valid paths and
// each line refused, with why. A missing list is an empty one; a list that
// is there but cannot be read says why in `unreadable`.
export function readPrivateList(home) {
  const file = join(home, PRIVATE_LIST);
  try { if (!lstat(file)) return { paths: [], refused: [], exists: false }; }
  catch (error) { return { paths: [], refused: [], exists: true, unreadable: `${file} cannot be read (${error.code ?? error.message})` }; }
  let text;
  try { text = readFileSync(file, "utf8"); } catch (error) { return { paths: [], refused: [], exists: true, unreadable: `${file} cannot be read (${error.code ?? error.message})` }; }
  return { ...parsePrivateList(text), exists: true };
}

// Writes the list, sorted, each path once, whole or not at all: a reader on
// another Mac never sees half of it.
export function writePrivateList(home, paths) {
  const file = join(home, PRIVATE_LIST), part = `${file}.${process.pid}.part`;
  writeFileSync(part, privateListText(paths));
  try { renameSync(part, file); } catch (error) { rmSync(part, { force: true }); throw error; }
}

const plainPaths = (list) => {
  const out = [];
  for (const p of list ?? []) { const r = privatePath(p); if ("path" in r && !out.includes(r.path)) out.push(r.path); }
  return out;
};

// A project's private files on this Mac: those the folder's list names and
// those this Mac's config names, each once, with where each came from
// ("iCloud", "this Mac" or both), the lines of the list refused, and the
// folder (or why there is none). `fromList` is the list as read, or null
// when it could not be read: `unreadable` then says why. A folder the entry
// names that is not on this Mac counts as a list that cannot be read; a
// folder found by name that holds no list is an empty list.
export function privateList(name, entry, root) {
  const config = plainPaths(entry?.private);
  const found = privateHome(name, entry, root);
  const home = found.error ? null : found.home;
  let listed = { paths: [], refused: [], exists: false }, unreadable = null, there = null;
  if (home) { try { there = lstat(home) && statSync(home); } catch (error) { unreadable = `${home}, the folder that keeps ${name}'s private files and their list, cannot be read (${error.code ?? error.message})`; } }
  if (home && there) {
    listed = readPrivateList(home);
    unreadable = listed.unreadable ?? null;
  }
  const homeMissing = !!home && !there && !unreadable;
  if (homeMissing) unreadable = `${home}, the folder that keeps ${name}'s private files and their list, is not on this Mac`;
  else if (found.unreadable) unreadable = found.error;
  // The copy of the list this Mac keeps counts as well (Astra's fifth
  // review of t645): with the list unavailable, its names are still
  // excluded, linked where they can be and reported.
  const cached = plainPaths(entry?.privateFromList);
  const paths = [...new Set([...listed.paths, ...config, ...cached])];
  const sources = Object.fromEntries(paths.map((p) => [p, [listed.paths.includes(p) ? "iCloud" : cached.includes(p) ? "this Mac's copy of the iCloud list" : null, config.includes(p) ? "this Mac" : null].filter(Boolean).join(" and ")]));
  return { paths, sources, refused: listed.refused, listed: listed.exists, fromList: listed.exists && !unreadable ? listed.paths : null, unreadable, homeMissing, home, homeError: found.error ?? null, named: found.named };
}

// What every Atelier command that stages or pushes is checked against: the
// project's private files from the list, this Mac's config and the copy of
// the list this Mac last read (privateFromList), and the list itself, which
// sits in a checkout that is the folder. Missing or unreadable metadata never
// shrinks this silently. Each list read is kept in the entry (`save` writes
// the config); a list that cannot be read, with no copy kept, is a refusal
// naming where it should be, so the caller pushes nothing.
export function privateGuard(name, entry, { root, save, homes = [] } = {}) {
  // Private files are opt-in (third reviews of t645): a project with none
  // configured here is not guarded and its iCloud folder is never read.
  if (!privateConfigured(entry)) return { paths: [], refusal: null };
  const list = discoverPrivate(name, entry, { root, save });
  const kept = Array.isArray(entry?.privateFromList);
  const copy = plainPaths(entry?.privateFromList);
  // Every folder known for the project is read, not only the current one
  // (Astra's fifteenth review of t645): one an older config named, the one
  // this process held, the one found by name. Their lists only add names.
  const others = new Set([...homes, entry?.privateHome ? folderFor(name, root ?? privateRoot()).home : null].filter((h) => h && h !== list.home));
  const more = [];
  for (const home of others) {
    try { if (lstat(home)) more.push(...readPrivateList(home).paths); } catch { /* an older folder that cannot be read adds nothing */ }
  }
  // Names read from an older folder are kept in the copy too (Astra's
  // sixteenth review of t645), so they stay guarded once that folder is no
  // longer known; the copy only grows.
  // While the current folder's list cannot be read and no copy of it is
  // kept, names from other folders are guarded but not kept as a copy, so
  // the refusal stands until that list is read (Argon's eighteenth review
  // of t645).
  if (entry && more.some((p) => !copy.includes(p)) && (kept || !list.unreadable)) {
    entry.privateFromList = [...new Set([...copy, ...plainPaths(more)])];
    save?.();
  }
  const paths = [...new Set([...list.paths, ...copy, ...more])];
  const refusal = list.unreadable && !kept
    ? `${list.unreadable}, and this Mac keeps no copy of its list of private files, so what may not leave cannot be known. Make the folder available on this Mac (or name another with atelier private add --home DIR --project ${name}) and try again. Nothing was pushed.`
    : null;
  return { paths: [...paths, PRIVATE_LIST], refusal };
}

// Whether a project has private files on this Mac: a copy of its list
// naming one, names in this Mac's config, or a folder named for them.
export function privateConfigured(entry) {
  return plainPaths(entry?.privateFromList).length > 0 || plainPaths(entry?.private).length > 0 || !!entry?.privateHome;
}

// Reads the project's list, finding its iCloud folder by name when none is
// named, and keeps a copy of it in the entry when the list is there and was
// read. No read ever removes a name from the copy: what is read is joined to
// it, so a name an older list, a merged entry or another Mac put there stays
// guarded (Astra's eighth review of t645); only private remove removes one.
// clone, private add and private ls run this, so a list in iCloud opts the
// project in on this Mac. Returns what privateList returns.
export function discoverPrivate(name, entry, { root, save } = {}) {
  const list = privateList(name, entry, root);
  // A list that is there but cannot be read opts the project in too, by
  // naming its folder, so the guard refuses rather than guards nothing
  // (Argon's seventeenth review of t645).
  if (entry && list.listed && list.unreadable && list.home && !entry.privateHome) {
    entry.privateHome = list.home;
    save?.();
  }
  if (entry && list.fromList) {
    const kept = plainPaths(entry.privateFromList);
    const joined = [...new Set([...kept, ...list.fromList])];
    if (!Array.isArray(entry.privateFromList) || joined.length !== kept.length) {
      entry.privateFromList = joined;
      save?.();
    }
  }
  return list;
}

// The one loader every guard uses (t645): the project's entry in this
// Mac's config, read by the project's name, so no caller passes (or
// forgets) its private configuration. The CLI registers its own config
// (useConfig), so what it reads and what it saves stay one; elsewhere the
// config file is read, and a copy of the list kept is written back to it.
// The config on disk is read at every call even in the CLI, and its private
// settings joined to the entry in memory: a long-running process (the
// integrator) sees a name another process made private since it started,
// and an in-process name not yet written is still honoured (Astra's fourth
// review of t645).
let shared = null;
export function useConfig(cfg) { shared = cfg ? { cfg } : null; }

const configFile = () => join(process.env.ATELIER_CONFIG_DIR ?? join(homedir(), ".config", "atelier"), "config.json");

// The key a project's entry has in `projects`: its name, or the entry that
// lists the name among its former names (projects rename records them),
// since a workspace made before a rename still names the old one (Astra's
// sixth review of t645).
// An entry that lists the name among its former names is the project's
// entry now, and wins over a stale entry still under the old name (Astra's
// eleventh review of t645); the loader joins the stale entry's private
// settings to it.
export function projectKey(projects, name) {
  if (!projects || typeof name !== "string") return null;
  const renamed = Object.keys(projects).find((key) => key !== name && Array.isArray(projects[key]?.formerNames) && projects[key].formerNames.includes(name));
  if (renamed) return renamed;
  return Object.hasOwn(projects, name) ? name : null;
}

// The project's entry by name or former name, with the private settings
// of a stale entry still under the asked name joined to it.
function entryFor(projects, name) {
  const key = projectKey(projects, name);
  if (!key) return { key: null, entry: undefined };
  const entry = projects[key];
  if (key !== name && projects[name]) joinPrivate(entry, projects[name]);
  return { key, entry };
}

// Writes one project's private settings to config.json and nothing else:
// the file is read again, only that entry's private fields are changed, and
// it is written whole or not at all, so another project's settings, or a
// name another process just added, are never overwritten by an older copy
// in memory (Astra's sixth review of t645). `private` keeps every name the
// file holds unless `drop` names it; the copy of the list is this entry's;
// a folder already named is kept unless `home` names another (private add
// --home). An entry the file does not hold is not
// written. Returns whether it wrote.
export function savePrivateFields(project, entry, { drop = [], home = null } = {}) {
  if (!entry) return false;
  return updateConfig((cfg) => {
    const key = projectKey(cfg.projects, project);
    if (!key) return false;
    const target = cfg.projects[key];
    const names = [...new Set([...plainPaths(target.private), ...plainPaths(entry.private)])].filter((p) => !drop.includes(p));
    if (Array.isArray(target.private) || Array.isArray(entry.private)) target.private = names;
    if (Array.isArray(entry.privateFromList) || Array.isArray(target.privateFromList)) target.privateFromList = [...new Set([...plainPaths(target.privateFromList), ...plainPaths(entry.privateFromList)])].filter((p) => !drop.includes(p));
    if (home) target.privateHome = home;
    else if (entry.privateHome && !target.privateHome) target.privateHome = entry.privateHome;
    return true;
  }) === true;
}

// Every read-modify-write of config.json this task makes holds this lock
// (Astra's ninth review of t645): a file beside config.json made with
// O_EXCL, holding the owner's pid and when it was taken. Another holder is
// waited for, with a short backoff, for up to LOCK_WAIT_MS; a lock whose
// owner is gone, or older than LOCK_STALE_MS, is taken over. The atomic
// rename alone keeps a reader from seeing half a file; the lock keeps two
// writers from losing each other's change.
const LOCK_WAIT_MS = 5000, LOCK_STALE_MS = 30_000;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// A test's pause between a read and its write, to make two writers overlap
// for certain: with ATELIER_TEST_HOLD naming a path and
// ATELIER_TEST_HOLD_STAGE naming this stage, the process writes PATH.read
// once it has read and waits (up to ten seconds) for PATH.go before it
// writes. ATELIER_TEST_NO_LOCK runs without the lock, so a test can show
// the lock is what keeps both changes. Neither is set outside the tests.
export function testHold(stage) {
  const at = process.env.ATELIER_TEST_HOLD;
  if (!at || process.env.ATELIER_TEST_HOLD_STAGE !== stage) return;
  writeFileSync(`${at}.read`, String(process.pid));
  const until = Date.now() + 10_000;
  while (!existsSync(`${at}.go`) && Date.now() < until) sleep(10);
}

// Holds `lock`, a file made with O_EXCL holding the owner's pid and when it
// was taken, while `fn` runs. Another holder is waited for, with a short
// backoff, for up to LOCK_WAIT_MS; a lock whose owner is gone, or older than
// LOCK_STALE_MS, is taken over. `what` names what it guards in the refusal.
export function withLock(lock, what, fn) {
  if (process.env.ATELIER_TEST_NO_LOCK) return fn();
  mkdirSync(dirname(lock), { recursive: true });
  const token = `${process.pid} ${randomUUID()}`;
  const wait = Number(process.env.ATELIER_TEST_LOCK_WAIT_MS) || LOCK_WAIT_MS;
  const started = Date.now();
  for (let delay = 10; ; delay = Math.min(delay * 2, 200)) {
    let fd;
    try { fd = openSync(lock, "wx", 0o600); }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const seen = readLock(lock);
      if (seen !== null && lockIsStale(lock, seen)) {
        testHold("recover");
        recoverLock(lock, seen);
        continue;
      }
      if (Date.now() - started > wait) throw new Error(`${what} is locked by another Atelier command (pid ${Number(seen?.split(" ")[0]) || "unknown"}, ${lock}); try again once it has finished, or remove ${lock} if no Atelier command is running`);
      sleep(delay);
      continue;
    }
    try {
      writeSync(fd, `${token}\n`);
      closeSync(fd);
      return fn();
    } finally { releaseLock(lock, token); }
  }
}

// The lock's content, or null when there is no lock.
function readLock(lock) {
  try { return readFileSync(lock, "utf8").trim(); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

// A lock is stale only when its owner is gone (Astra's twelfth review of
// t645): a live owner keeps it however long it holds it. A lock still empty
// after LOCK_STALE_MS is one whose maker died between making and writing it.
function lockIsStale(lock, seen) {
  const pid = Number(seen.split(" ")[0]);
  if (!seen) {
    try { return Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS; } catch { return false; }
  }
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); return false; } catch (error) { return error?.code !== "EPERM"; }
}

// Takes a stale lock away, atomically: the lock is renamed to a name of this
// process's own, which only one renamer can do, and read again. If it is
// the lock judged stale it is removed; if it is not (another waiter
// recovered the stale one and a new owner made this one since), it is put
// back where it was, with a link that fails rather than replace a lock made
// meanwhile, so a live owner's lock is never removed.
function recoverLock(lock, seen) {
  const aside = `${lock}.${process.pid}.${randomUUID()}.stale`;
  try { renameSync(lock, aside); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
  let content = null;
  try { content = readFileSync(aside, "utf8").trim(); } catch { /* read below as not the one judged */ }
  if (content === seen) { rmSync(aside, { force: true }); return; }
  try { linkSync(aside, lock); } catch { /* a lock was made meanwhile at the path: three waiters raced on one dead lock, and the one put aside cannot be put back without removing that one */ }
  rmSync(aside, { force: true });
}

// Releases the lock only while it still holds this process's token, so a
// lock another owner holds now is never removed.
function releaseLock(lock, token) {
  try { if (readLock(lock) === token) unlinkSync(lock); } catch { /* gone already */ }
}


// Every read-modify-write of config.json holds this lock (Astra's ninth
// review of t645): the atomic rename keeps a reader from half a file, the
// lock keeps two writers from losing each other's change.
export function withConfigLock(fn) {
  const file = configFile();
  return withLock(`${file}.lock`, file, fn);
}

// The lock for one project's list in iCloud, kept in this Mac's config
// folder (never in iCloud), keyed by the list's path: two commands on this
// Mac never lose each other's names. Two Macs writing the list at once
// through iCloud are not covered; iCloud keeps one and makes a conflicted
// copy of the other.
export function withListLock(home, fn) {
  const file = join(home, PRIVATE_LIST);
  return withLock(join(dirname(configFile()), `private-list-${lockKey(file)}.lock`), file, fn);
}

// The key of a lock guarding a file: the file's path as the volume knows it
// (Astra's eighteenth review of t645), so two spellings of one folder (a
// symbolic link to it, another letter case on a volume that ignores case)
// share one lock. The folder is resolved through its links when it exists,
// else as written; on a volume that ignores case the path is folded.
export function lockKey(file) {
  let dir = resolve(dirname(file));
  try { dir = realpathSync(dir); } catch { /* not made yet: as written */ }
  let path = join(dir, basename(file));
  if (ignoresCase(dir)) path = foldPath(path);
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}
function ignoresCase(dir) {
  const other = dir.replace(/[A-Za-z]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
  if (other === dir) return false;
  try { const a = statSync(dir), b = statSync(other); return a.ino === b.ino && a.dev === b.dev; } catch { return false; }
}

const readConfigFile = (file) => {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
};
const writeConfigFile = (file, cfg) => {
  const part = `${file}.${process.pid}.part`;
  writeFileSync(part, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  try { renameSync(part, file); } catch (error) { rmSync(part, { force: true }); throw error; }
};

// Reads config.json under the lock, lets `change` edit it, and writes it
// whole or not at all unless `change` answers false. A missing file is no
// config: nothing is written and false is answered. Returns what `change`
// returns.
export function updateConfig(change) {
  return withConfigLock(() => {
    const file = configFile();
    const cfg = readConfigFile(file);
    if (!cfg) return false;
    testHold("update");
    cfg.projects ??= {};
    const result = change(cfg);
    if (result === false) return false;
    writeConfigFile(file, cfg);
    return result;
  });
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const PRIVATE_FIELDS = ["private", "privateFromList", "formerNames"];

// The config a whole-config save writes (Astra's tenth review of t645):
// `memory` is what this process holds, `snapshot` what it read when it
// started (or last saved), `disk` the file as it is now. A top-level setting
// or a project entry this process changed (it differs from the snapshot,
// or is gone from memory) is written as memory holds it; one it did not
// change is left as the disk has it, so another command's change since is
// kept, a removal or move included. Every entry's private names, copy of the list and former names are
// joined across memory and disk, so no save ever drops one; a folder named
// on disk is kept unless this process changed the entry. Only private
// remove (updateConfig) removes a private name.
export function mergeConfigForSave(disk, memory, snapshot) {
  // No file yet: nothing else wrote, so what this process holds stands.
  disk ??= memory; snapshot ??= {};
  const out = {};
  for (const key of new Set([...Object.keys(disk), ...Object.keys(memory), ...Object.keys(snapshot)])) {
    if (key === "projects") continue;
    const changed = !same(memory[key], snapshot[key]);
    const value = changed ? memory[key] : disk[key];
    if (value !== undefined) out[key] = value;
  }
  const dp = disk.projects ?? {}, mp = memory.projects ?? {}, sp = snapshot.projects ?? {};
  out.projects = {};
  const renamed = [];
  for (const name of new Set([...Object.keys(dp), ...Object.keys(mp), ...Object.keys(sp)])) {
    const changed = !same(mp[name], sp[name]);
    if (changed && !mp[name]) continue; // removed or moved by this process
    // An entry this process changed that another command renamed since is
    // never made again under its old name (Astra's eleventh review of
    // t645): the changes go to the entry that now lists the name among its
    // former names.
    const now = changed && !dp[name] && sp[name] ? Object.keys(dp).find((key) => Array.isArray(dp[key]?.formerNames) && dp[key].formerNames.includes(name)) : null;
    if (now) { renamed.push([name, now]); continue; }
    // Field by field (Astra's fourteenth review of t645): a field this
    // process changed since it read the config is written as it holds it;
    // every other field is left as the disk has it, so another command's
    // change to a field this process did not touch (a new privateHome) is
    // kept. An entry another command removed since stays gone unless this
    // process changed it.
    if (!dp[name] && !changed) continue;
    const entry = { ...(dp[name] ?? mp[name]) };
    if (dp[name]) applyChanges(entry, mp[name], sp[name] ?? {});
    joinPrivate(entry, mp[name]);
    for (const field of ["formerNames"]) {
      const joined = [...new Set([...(dp[name]?.[field] ?? []), ...(mp[name]?.[field] ?? [])])];
      if (joined.length) entry[field] = joined;
    }
    out.projects[name] = entry;
  }
  for (const [name, now] of renamed) {
    const entry = out.projects[now], mine = mp[name], before = sp[name] ?? {};
    if (!entry) continue;
    applyChanges(entry, mine, before);
    joinPrivate(entry, mine);
    entry.formerNames = [...new Set([...(entry.formerNames ?? []), ...(Array.isArray(mine.formerNames) ? mine.formerNames : [])])].filter((n) => n !== now);
  }
  return out;
}

// Writes into `entry` (the disk's) each field `mine` changed since `before`:
// a set field is set, a removed one removed. The private lists and former
// names are joined by the caller, never replaced; a folder named on disk is
// kept unless this process named another.
function applyChanges(entry, mine, before) {
  for (const field of new Set([...Object.keys(mine ?? {}), ...Object.keys(before)])) {
    if (PRIVATE_FIELDS.includes(field)) continue;
    if (same(mine?.[field], before[field])) continue;
    if (mine?.[field] === undefined) { if (field !== "privateHome") delete entry[field]; }
    else entry[field] = mine[field];
  }
}

// A whole-config save, as the CLI's saveConfig makes it: under the lock, the
// file is read again and merged with what this process holds
// (mergeConfigForSave), then written whole or not at all. Returns the
// config written.
export function saveWholeConfig(memory, snapshot) {
  return withConfigLock(() => {
    const file = configFile();
    const disk = readConfigFile(file);
    testHold("save");
    const merged = mergeConfigForSave(disk, memory, snapshot);
    mkdirSync(dirname(file), { recursive: true });
    writeConfigFile(file, merged);
    return merged;
  });
}

// `pending` stands for the entry of a project this Mac does not register
// yet (a first init), used only while the config holds none.
export function privateGuardFor(project, { root, discover = false, pending = null } = {}) {
  if (typeof project !== "string" || !project) throw new Error("the private-file guard needs the project's name");
  const homes = [];
  const run = (entry) => {
    let save = entry ? () => savePrivateFields(project, entry) : null;
    if (!entry && pending) { entry = pending; save = null; }
    if (discover) discoverPrivate(project, entry, { root, save });
    return privateGuard(project, entry, { root, save, homes });
  };
  const file = configFile();
  let cfg;
  try { cfg = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) {
    if (error?.code !== "ENOENT") return { paths: [PRIVATE_LIST], refusal: `${file} cannot be read (${error?.code ?? error?.message}), so ${project}'s private files cannot be known. Nothing was pushed.` };
    cfg = { projects: {} };
  }
  const { key: diskKey, entry: onDisk } = entryFor(cfg.projects ?? {}, project);
  if (shared) {
    shared.cfg.projects ??= {};
    const memKey = projectKey(shared.cfg.projects, project) ?? diskKey;
    if (memKey) entryFor(shared.cfg.projects, project);
    if (onDisk) {
      const entry = shared.cfg.projects[memKey] ??= { ...onDisk };
      // The folder on disk is the current one (another command may have
      // named a new one since this process started); the one held before
      // is still read.
      if (entry.privateHome && onDisk.privateHome && entry.privateHome !== onDisk.privateHome) {
        homes.push(entry.privateHome);
        entry.privateHome = onDisk.privateHome;
      }
      joinPrivate(entry, onDisk);
    }
    return run(memKey ? shared.cfg.projects[memKey] : undefined);
  }
  return run(onDisk);
}

// Moves a project's local entry from one name to another, or merges it
// into the entry already under the new name: the one helper every rename
// of a local entry uses (init --rename-local, projects rename), so no move
// loses what keeps a project's files private (Astra's seventh review of
// t645). The old name, and the names it had before, become former names of
// the destination, so workspaces made under any of them stay guarded. Into
// an existing entry, the private names and the copy of the list are joined
// (no name is dropped) and its folder is kept, else the source's; two
// different folders are refused, changing nothing, since which one keeps
// the files cannot be guessed. Returns { moved, merged, dropped } (the
// source's other settings, which a merge does not keep) or { error }.
// Moves the entry in config.json on disk, under the config lock, and then
// the same in `projects` held in memory, so a command that saves the whole
// config later keeps the move. Returns what moveProjectEntry returns.
export function moveProjectEntryOnDisk(projects, from, to) {
  let moved = { moved: false };
  const written = updateConfig((cfg) => {
    moved = moveProjectEntry(cfg.projects, from, to);
    return moved.error || !moved.moved ? false : true;
  });
  if (moved.error) return moved;
  if (written === false && !moved.moved) moved = moveProjectEntry(projects, from, to);
  else if (projects?.[from]) moveProjectEntry(projects, from, to);
  return moved;
}

// Why moving `from` to `to` would be refused, or null: checked before
// anything is renamed anywhere (projects rename asks this before the server).
// The folder each side's private files are kept in, as discovery resolves
// it: the one the entry names, else the one found by its name (or former
// names). Looked for only when either side has private files configured.
function resolvedHomes(projects, from, to) {
  const source = projects[from], target = projects[to];
  if (!privateConfigured(source) && !privateConfigured(target)) return { sourceHome: source.privateHome ?? null, targetHome: target.privateHome ?? null };
  return { sourceHome: source.privateHome || privateHome(from, source).home || null, targetHome: target.privateHome || privateHome(to, target).home || null };
}

export function moveConflict(projects, from, to) {
  const source = projects?.[from], target = projects?.[to];
  if (!source || !target || from === to) return null;
  // Both sides' folders as resolved, the one found by name included
  // (Astra's twelfth review of t645).
  const { sourceHome, targetHome } = resolvedHomes(projects, from, to);
  if (sourceHome && targetHome && sourceHome !== targetHome) {
    return `the local entries ${from} and ${to} name different folders for their private files (${sourceHome} and ${targetHome}); nothing was renamed and nothing in the local config was changed. Choose one with atelier private add --home DIR --project ${from} (or --project ${to}) so both name the same folder, then run this again`;
  }
  return null;
}

export function moveProjectEntry(projects, from, to) {
  if (!projects?.[from] || from === to) return { moved: false };
  const source = projects[from], target = projects[to];
  const former = (...lists) => [...new Set(lists.flatMap((l) => (Array.isArray(l) ? l : [])))].filter((n) => n !== to);
  // A folder found by the old name is recorded, so the move does not lose
  // it (Astra's eleventh review of t645); only a project with private files
  // configured has its folder looked for.
  const found = !source.privateHome && privateConfigured(source) ? privateHome(from, source) : null;
  const home = found?.home ? { privateHome: found.home } : {};
  if (!target) {
    projects[to] = { ...source, ...home, formerNames: former(source.formerNames, [from]) };
    delete projects[from];
    return { moved: true };
  }
  const conflict = moveConflict(projects, from, to);
  if (conflict) return { error: conflict };
  // The destination keeps the folder it resolves to; only when it has none
  // does it take the source's.
  const { sourceHome, targetHome } = resolvedHomes(projects, from, to);
  const keepHome = targetHome || sourceHome;
  joinPrivate(target, { ...source, privateHome: undefined });
  if (keepHome) target.privateHome = keepHome;
  target.formerNames = former(target.formerNames, source.formerNames, [from]);
  const kept = new Set(["private", "privateFromList", "privateHome", "formerNames"]);
  const dropped = Object.fromEntries(Object.entries(source).filter(([k]) => !kept.has(k)));
  delete projects[from];
  return { moved: true, merged: true, dropped };
}

// Joins the private settings of `other` (the entry on disk) into `entry`:
// each list holds every name either has, and a folder named in either is
// kept, this one's first. Nothing is ever dropped here.
export function joinPrivate(entry, other) {
  const union = (a, b) => [...new Set([...plainPaths(a), ...plainPaths(b)])];
  if (Array.isArray(other?.private) || Array.isArray(entry.private)) entry.private = union(entry.private, other?.private);
  if (Array.isArray(other?.privateFromList) || Array.isArray(entry.privateFromList)) entry.privateFromList = union(entry.privateFromList, other?.privateFromList);
  if (!entry.privateHome && other?.privateHome) entry.privateHome = other.privateHome;
  return entry;
}

// The links Atelier made in a checkout, kept in its Git directory
// (atelier-private-links, one JSON line each), so a later link to a moved
// folder can be told from a developer's own.
function linksFile(checkout) {
  const r = gitRead(checkout, ["rev-parse", "--git-path", "atelier-private-links"]);
  if (r.status !== 0) throw new Error(`${checkout} is not a Git checkout`);
  return resolve(checkout, r.stdout.trim());
}
export function linkedBefore(checkout) {
  const made = new Map();
  let text = "";
  try { text = readFileSync(linksFile(checkout), "utf8"); } catch { return made; }
  for (const line of text.split("\n")) { try { const { path, target } = JSON.parse(line); made.set(path, target); } catch { /* not a record */ } }
  return made;
}
function recordLink(checkout, path, target) {
  appendFileSync(linksFile(checkout), `${JSON.stringify({ path, target })}\n`);
}

// The checkout's info/exclude file, wherever its Git directory keeps it.
function excludeFile(checkout) {
  const r = gitRead(checkout, ["rev-parse", "--git-path", "info/exclude"]);
  if (r.status !== 0) throw new Error(`${checkout} is not a Git checkout`);
  return resolve(checkout, r.stdout.trim());
}

// Adds a line to the checkout's info/exclude for each private path it does
// not ignore yet. Returns the lines added.
// Under a lock of its own (in this Mac's config folder, keyed by the
// exclude file's path), and only by appending what is missing: the lines
// already there, Atelier's or anyone's, are never rewritten, and two
// commands at once never drop each other's (Astra's thirteenth review of
// t645).
export function excludePrivate(checkout, paths) {
  return withCheckoutLock(checkout, () => excludeHeld(checkout, paths));
}

// The lock for one checkout's private-file changes: its ignore lines and its
// links (Argon's eighteenth review of t645), keyed by its exclude file.
export function withCheckoutLock(checkout, fn) {
  const file = excludeFile(checkout);
  return withLock(join(dirname(configFile()), `exclude-${lockKey(file)}.lock`), file, fn);
}

function excludeHeld(checkout, paths) {
  const file = excludeFile(checkout);
  {
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    testHold("exclude");
    const have = new Set(text.split("\n"));
    const lines = [...new Set(paths.map(privateExcludeLine))].filter((line) => !have.has(line));
    if (!lines.length) return [];
    mkdirSync(dirname(file), { recursive: true });
    const head = have.has(EXCLUDE_HEADER) ? [] : [EXCLUDE_HEADER];
    appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}${[...head, ...lines].join("\n")}\n`);
    return lines;
  }
}

// Whether Git, with every ignore rule the checkout has, ignores a private
// path: a tracked .gitignore saying !PROJECT.md outweighs info/exclude
// (Astra's third review of t645), so the line alone proves nothing.
export function excludesPrivate(checkout, path) {
  const r = gitRead(checkout, ["check-ignore", "-q", "--no-index", "--", path], { env: SCRUBBED });
  return r.status === 0;
}

// The private paths Git tracks in the checkout, or holds files under,
// compared as a Mac compares names (letter case and Unicode form aside), so
// the whole index is read: a pathspec would match it byte for byte.
export function trackedPrivate(checkout, paths) {
  if (!paths.length) return [];
  const r = gitRead(checkout, ["ls-files", "-z"], { env: SCRUBBED });
  if (r.status !== 0) throw new Error(`git ls-files failed in ${checkout}: ${(r.stderr || "").trim().split("\n")[0]}`);
  const tracked = r.stdout.split("\0").filter(Boolean);
  return paths.filter((path) => privatePathsAmong(tracked, [path]).length);
}

// What is at a path, or null when nothing is: only ENOENT and ENOTDIR mean
// nothing is there. Any other error (EACCES, EIO, …) is thrown, so what
// cannot be read is never taken for absent (Astra's fifth review of t645).
const lstat = (path) => {
  try { return lstatSync(path); }
  catch (error) { if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null; throw error; }
};

// A folder between the checkout and a private path that is a symbolic link:
// a link made under it would land outside the checkout.
function linkAbove(checkout, path) {
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    const at = parts.slice(0, i).join("/"), stat = lstat(join(checkout, at));
    if (!stat) return null;
    if (stat.isSymbolicLink()) return at;
  }
  return null;
}

// The state of one private path in the checkout: "linked" to the file in
// the home, "missing" from the home, "file" (something Atelier did not make
// stands there), "other-link" (a link to elsewhere) or "absent".
export function privateState(checkout, home, path) {
  try { return stateOf(checkout, home, path); } catch { return "unreadable"; }
}
function stateOf(checkout, home, path) {
  const target = join(home, path), stat = lstat(join(checkout, path));
  if (stat?.isSymbolicLink()) return readlinkSync(join(checkout, path)) === target ? (lstat(target) ? "linked" : "missing") : "other-link";
  if (stat) return "file";
  return lstat(target) ? "absent" : "missing";
}

// Links each private path the project's entry names into the checkout, from
// the folder that keeps them, and makes Git ignore each one. Run by clone
// after it clones, by private add, and by atelier pull after a pull that
// succeeds (t651). It never overwrites a file or folder: one standing where a link
// would go is left as it is and reported. A link of its own pointing
// elsewhere (a home that moved) is replaced. Returns what it did, with the
// lines to print in `said`.
export function linkPrivate(checkout, entry, { name, root } = {}) {
  return withCheckoutLock(checkout, () => linkHeld(checkout, entry, { name, root }));
}

function linkHeld(checkout, entry, { name, root } = {}) {
  const list = privateList(name, entry, root);
  const paths = list.paths;
  const result = { linked: [], kept: [], missing: [], refused: [], invalid: list.refused, said: [] };
  const say = (line) => result.said.push(line);
  // A line of the list that is no plain path in the checkout is named and
  // skipped; the others are linked.
  for (const r of list.refused) say(`${PRIVATE_LIST}${r.line ? ` line ${r.line}` : ""}: ${r.error}; skipped.`);
  // A list or folder that is there but cannot be read is said, whatever
  // else is named (Argon's seventeenth review of t645).
  if (list.unreadable && !list.homeMissing && (list.listed || list.home)) say(`Warning: ${list.unreadable}; the private files it names cannot be known here, and Atelier refuses to push until it can be read.`);
  if (!paths.length && !list.listed) return result;
  excludeHeld(checkout, [...paths, PRIVATE_LIST]);
  if (!paths.length) return result;
  if (list.homeError) { say(`Private files not linked: ${list.homeError}. Git ignores ${paths.join(", ")} in ${checkout}.`); result.home = null; return result; }
  const home = result.home = list.home;
  let homeStat = null;
  try { homeStat = lstat(home) && statSync(home); }
  catch (error) { result.unreadableHome = true; say(`Private files not linked: ${home}, the folder that keeps them, cannot be read (${error.code ?? error.message}). Git ignores ${paths.join(", ")} in ${checkout} meanwhile.`); return result; }
  if (!homeStat || !homeStat.isDirectory()) {
    result.missingHome = true;
    say(`Private files not linked: ${home}, the folder that keeps them, is not on this Mac. iCloud may not have brought it here yet; once it has, run atelier private add ${paths.join(" ")} --project ${name} to link them. Git ignores them in ${checkout} meanwhile.`);
    return result;
  }
  if (realpathSync(home) === realpathSync(checkout)) {
    result.inPlace = true;
    say(`Private files stay where they are: this checkout is ${home}, the folder that keeps them. Git ignores ${paths.join(", ")} here.`);
    return result;
  }
  const tracked = new Set(trackedPrivate(checkout, paths));
  for (const path of paths) {
    const target = join(home, path), link = join(checkout, path);
    if (tracked.has(path)) { result.refused.push(path); say(`${path}: Git tracks it in the checkout, so it is not private there; not linked.`); continue; }
    let above;
    try { above = linkAbove(checkout, path); }
    catch (error) { result.refused.push(path); say(`${path}: a folder above it in the checkout cannot be read (${error.code ?? error.message}); not linked.`); continue; }
    if (above) { result.refused.push(path); say(`${path}: ${above} in the checkout is a symbolic link, so a link under it would land outside the checkout; not linked.`); continue; }
    let there, stat;
    try { there = lstat(target); stat = lstat(link); }
    catch (error) { result.refused.push(path); say(`${path}: cannot be read (${error.code ?? error.message}); not linked.`); continue; }
    if (!there) { result.missing.push(path); say(`${path}: not in ${home}; not linked.`); continue; }
    if (stat?.isSymbolicLink()) {
      const points = readlinkSync(link);
      if (points === target) { result.kept.push(path); continue; }
      // Only a link Atelier made is replaced: the one this checkout's record
      // says Atelier made at this path, to this target (Astra's fourteenth
      // and fifteenth reviews of t645). A developer's own link is left as it
      // is, wherever it points, the project's folder included.
      if (linkedBefore(checkout).get(path) !== points) {
        result.refused.push(path);
        say(`${path}: a link Atelier did not make is already in the checkout (to ${points}); it was left as it is, not linked. Remove it, then run atelier private add ${path} --project ${name} to link it.`);
        continue;
      }
      unlinkSync(link);
    } else if (stat) {
      result.refused.push(path);
      say(`${path}: a ${stat.isDirectory() ? "folder" : "file"} Atelier did not link is already in the checkout; it was left as it is, not linked. Move it into ${home}, then run atelier private add ${path} --project ${name} to link it.`);
      continue;
    }
    mkdirSync(dirname(link), { recursive: true });
    testHold("link");
    try { symlinkSync(target, link); }
    catch (error) {
      // Another command made the same link meanwhile (Argon's eighteenth
      // review of t645): it points where this one would, and is Atelier's.
      let points = null;
      try { points = readlinkSync(link); } catch { /* not a link */ }
      if (error?.code === "EEXIST" && points === target) { recordLink(checkout, path, target); result.kept.push(path); continue; }
      throw error;
    }
    recordLink(checkout, path, target);
    result.linked.push(path);
  }
  const done = [...result.linked, ...result.kept];
  if (done.length) say(`Private files linked from ${home}: ${done.join(", ")}. Atelier never stages or pushes them.`);
  // Ignore rules are a convenience, not the guard: a tracked .gitignore can
  // un-ignore a path (Astra's third review of t645), so each is checked.
  const shown = done.filter((path) => !excludesPrivate(checkout, path));
  result.notIgnored = shown;
  if (shown.length) say(`Warning: Git does not ignore ${shown.join(", ")} here: a rule in the checkout (a !-line in a .gitignore) outweighs Atelier's. Atelier still refuses to stage or push ${shown.length === 1 ? "it" : "them"}, but git add would take ${shown.length === 1 ? "it" : "them"}; remove that rule.`);
  return result;
}

// The paths wrap would stage that are private: tracked changes against HEAD,
// staged or not, and new files Git does not ignore. A deletion is not one:
// it stages no content. Read without writing the index.
export function privateChanges(cwd, privates) {
  if (!privates?.length) return [];
  const readOnly = [...SCAN_CONFIG, "-c", "diff.autoRefreshIndex=false", "--no-optional-locks"];
  const changed = gitRead(cwd, [...readOnly, "diff", "HEAD", "--name-only", "--no-renames", "--no-ext-diff", "--diff-filter=d", "-z"], { env: SCRUBBED });
  const added = gitRead(cwd, [...readOnly, "ls-files", "--others", "--exclude-standard", "-z"], { env: SCRUBBED });
  if (changed.status !== 0 || added.status !== 0) throw new Error(`the changes in ${cwd} could not be read for private files`);
  const paths = [...changed.stdout.split("\0"), ...added.stdout.split("\0")].filter(Boolean);
  return [...new Set(privatePathsAmong(paths, privates))];
}

// The commits reachable from `tip` and from none of `base` that add, change
// or retype a private path, as { commit, path }. A merge is read against its
// first parent, so what it brings in counts at the merge too. Throws when Git
// cannot list them, so a caller stops rather than pushing unread commits.
export function privateCommits(cwd, privates, tip, base = []) {
  if (!privates?.length) return [];
  const tips = Array.isArray(tip) ? tip : [tip];
  if ([...tips, ...base].some((rev) => typeof rev !== "string" || !rev || rev.startsWith("-"))) throw new Error("the commits to be pushed could not be read for private files (a revision was not named)");
  // Each merge is compared with every parent (--diff-merges=separate), so a
  // merge whose first parent still holds a private file shows it against the
  // parent that removed it. -z with --raw frames every field with a NUL: a commit's line, then for
  // each changed path its ":modes objects status" field and the path. A path
  // is only ever read as the field after a status, so no byte in it can be
  // taken for a commit or another path. --root shows a root commit's files
  // whatever log.showRoot says.
  const r = gitRead(cwd, [
    ...SCAN_CONFIG, "log", "--no-color", "--format=C%H", "-z", "--raw", "--no-abbrev", "--no-renames", "--no-ext-diff", "--no-textconv",
    "--root", "--diff-merges=separate", "--diff-filter=d", ...tips, ...(base.length ? ["--not", ...base] : []), "--",
  ], { env: SCRUBBED });
  if (r.status !== 0) throw new Error(`the commits to be pushed could not be read for private files (${(r.stderr || "").trim().split("\n")[0] || `git log exited ${r.status}`})`);
  const found = [], fields = r.stdout.split("\0");
  let commit = null;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i].replace(/^\n/, "");
    if (!field) continue;
    if (field.startsWith(":")) {
      const path = fields[++i];
      if (commit === null || path === undefined) throw new Error("the commits to be pushed could not be read for private files (git log's output was not as expected)");
      if (/ D$/.test(field)) continue;
      if (privatePathsAmong([path], privates).length) found.push({ commit, path });
    } else if (/^C[0-9a-f]{40,64}$/.test(field)) commit = field.slice(1);
    else throw new Error("the commits to be pushed could not be read for private files (git log's output was not as expected)");
  }
  // And the state, not only the changes: no tree pushed holds a private
  // file, however the history reached it (third reviews of t645). Every
  // commit pushed is one of these: a commit whose parents are all pushed
  // too holds a path only if a parent does or its diff against a parent
  // shows it, so reading the tree of each commit with a parent outside the
  // range (and each tip) covers every commit in it, every step of a stepped
  // push included.
  const listed = gitRead(cwd, [...SCAN_CONFIG, "rev-list", "--parents", ...tips, ...(base.length ? ["--not", ...base] : [])], { env: SCRUBBED });
  if (listed.status !== 0) throw new Error(`the commits to be pushed could not be listed for private files (${(listed.stderr || "").trim().split("\n")[0] || `git rev-list exited ${listed.status}`})`);
  const rows = listed.stdout.split("\n").filter(Boolean).map((l) => l.split(" "));
  const pushed = new Set(rows.map(([c]) => c));
  const tipCommits = tips.map((rev) => gitRead(cwd, ["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`], { env: SCRUBBED }).stdout?.trim()).filter(Boolean);
  const edge = new Set([...rows.filter(([, ...parents]) => !parents.length || parents.some((p) => !pushed.has(p))).map(([c]) => c), ...tipCommits.filter((c) => pushed.has(c))]);
  for (const commit of edge) {
    const tree = gitRead(cwd, [...SCAN_CONFIG, "ls-tree", "-r", "-z", "--full-tree", "--name-only", commit], { env: SCRUBBED });
    if (tree.status !== 0) throw new Error(`the tree to be pushed could not be read for private files (${(tree.stderr || "").trim().split("\n")[0] || `git ls-tree exited ${tree.status}`})`);
    for (const path of privatePathsAmong(tree.stdout.split("\0").filter(Boolean), privates)) {
      if (!found.some((f) => f.commit === commit && f.path === path)) found.push({ commit, path, tree: true });
    }
  }
  return found;
}

// The commits privateCommits found, as one line: each path with its commit.
export function privateCommitsText(found) {
  const shown = found.slice(0, 20).map(({ commit, path, tree }) => `${path} in ${tree ? "the tree of " : ""}${commit.slice(0, 12)}`);
  return `${shown.join(", ")}${found.length > 20 ? `, and ${found.length - 20} more` : ""}`;
}

// The refusal for commits that would carry private files, or null.
export function privateRefusal(cwd, privates, tip, base, what) {
  let found;
  try { found = privateCommits(cwd, privates, tip, base); } catch (error) { return `${what}: ${error.message}`; }
  if (!found.length) return null;
  return `${what} would carry private files: ${privateCommitsText(found)}. They are private to this Mac's iCloud folder (atelier private ls) and Atelier never pushes them. Take them out of those commits (git rm --cached PATH, then amend, or rewrite the commits) and try again.`;
}

// Every Atelier push of the developer's or a task's history goes through
// here (t645), named by its project, whose private configuration the one
// loader reads: `push` runs only when the guard's list could be read and no
// commit reachable from `tip` and from none of a `bases` entry carries a
// private file. Each entry of `bases` is what one destination already
// holds, and the check is made against each; `bases` may be a function,
// called only when there is something to check, returning the entries or
// { error } (a destination that cannot be read stops the push). `fail` takes
// the refusal (by default it is thrown). Returns what `push` returns.
// The push is pinned to what was read (Astra's thirteenth review of t645):
// `tip` is resolved to its commit once, that commit is what is scanned, and
// `push` is given it to push by its id (SHA:refs/heads/BRANCH), so a commit
// made on the branch between the scan and the push is never sent.
export function guardedPush({ project, cwd, tip, base = [], bases = [base], what, fail = (message) => { throw new Error(message); }, root, pending = null }, push) {
  const guard = privateGuardFor(project, { root, pending });
  if (guard.refusal) return fail(`${what}: ${guard.refusal}`);
  const resolved = typeof tip === "string" && tip && !tip.startsWith("-")
    ? gitRead(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${tip}^{commit}`], { env: SCRUBBED }) : null;
  const sha = resolved?.status === 0 ? resolved.stdout.trim() : null;
  if (!sha) return fail(`${what}: ${tip} does not name a commit here. Nothing was pushed.`);
  if (guard.paths.length) {
    const read = typeof bases === "function" ? bases() : { bases };
    if (read.error) return fail(`${what}: ${read.error}. Nothing was pushed.`);
    for (const held of read.bases) {
      const refusal = privateRefusal(cwd, guard.paths, sha, held, what);
      if (refusal) return fail(`${refusal} Nothing was pushed.`);
    }
  }
  testHold("push");
  return push(sha);
}

// What each place a push to `remote` actually goes holds of `ref`: every
// push URL Git would use for the remote (or the remote itself when it is a
// URL), each read and fetched when this checkout lacks it. Returns
// { bases } for guardedPush, or { error } when a destination cannot be read,
// so the push stops (fails closed). `git` is the CLI's runner.
export function remoteBases({ git, cwd, remote, ref, opts = {} }) {
  const run = (args) => git(args, { cwd, allowFail: true, ...opts });
  const urls = run(["remote", "get-url", "--push", "--all", remote]);
  const destinations = urls.status === 0 ? urls.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [remote];
  const bases = [];
  for (const destination of destinations) {
    const listed = run(["ls-remote", "--refs", destination, ref]);
    if (listed.status !== 0) return { error: `${destination} cannot be read to check it for private files (${(listed.stderr || "").trim().split("\n")[0] || "git ls-remote failed"})` };
    const head = listed.stdout.trim().split("\n").map((l) => l.split(/\s+/)).find(([, name]) => name === ref)?.[0] ?? null;
    if (head && run(["cat-file", "-e", `${head}^{commit}`]).status !== 0) {
      const fetched = run(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", destination, ref]);
      if (fetched.status !== 0) return { error: `${destination}'s ${ref} could not be fetched to check it for private files (${(fetched.stderr || "").trim().split("\n")[0]})` };
    }
    bases.push(head ? [head] : []);
  }
  return { bases };
}
