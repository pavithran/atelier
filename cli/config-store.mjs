// How this Mac's config.json is written. Every read-modify-write holds a lock
// file beside it, and a whole-config save merges what the process holds with
// the file as it is now, so two Atelier commands running at once never lose
// each other's change. The atomic rename alone keeps a reader from seeing half
// a file; the lock keeps two writers from losing each other's change.
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const configFile = () => join(process.env.ATELIER_CONFIG_DIR ?? join(homedir(), ".config", "atelier"), "config.json");

// The key a project's entry has in `projects`: its name, or the entry that
// lists the name among its former names (projects rename records them),
// since a workspace made before a rename still names the old one. An entry
// that lists the name among its former names is the project's entry now, and
// wins over a stale entry still under the old name.
export function projectKey(projects, name) {
  if (!projects || typeof name !== "string") return null;
  const renamed = Object.keys(projects).find((key) => key !== name && Array.isArray(projects[key]?.formerNames) && projects[key].formerNames.includes(name));
  if (renamed) return renamed;
  return Object.hasOwn(projects, name) ? name : null;
}

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

// A lock is stale only when its owner is gone: a live owner keeps it however
// long it holds it. A lock still empty after LOCK_STALE_MS is one whose maker
// died between making and writing it.
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

// Every read-modify-write of config.json holds this lock.
export function withConfigLock(fn) {
  const file = configFile();
  return withLock(`${file}.lock`, file, fn);
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

// The config a whole-config save writes: `memory` is what this process holds,
// `snapshot` what it read when it started (or last saved), `disk` the file as
// it is now. A top-level setting or a project entry this process changed (it
// differs from the snapshot, or is gone from memory) is written as memory
// holds it; one it did not change is left as the disk has it, so another
// command's change since is kept, a removal or move included. A project's
// former names are joined across memory and disk, so no save ever drops one.
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
    // never made again under its old name: the changes go to the entry that
    // now lists the name among its former names.
    const now = changed && !dp[name] && sp[name] ? Object.keys(dp).find((key) => Array.isArray(dp[key]?.formerNames) && dp[key].formerNames.includes(name)) : null;
    if (now) { renamed.push([name, now]); continue; }
    // Field by field: a field this process changed since it read the config
    // is written as it holds it; every other field is left as the disk has
    // it. An entry another command removed since stays gone unless this
    // process changed it.
    if (!dp[name] && !changed) continue;
    const entry = { ...(dp[name] ?? mp[name]) };
    if (dp[name]) applyChanges(entry, mp[name], sp[name] ?? {});
    const joined = [...new Set([...(dp[name]?.formerNames ?? []), ...(mp[name]?.formerNames ?? [])])];
    if (joined.length) entry.formerNames = joined;
    out.projects[name] = entry;
  }
  for (const [name, now] of renamed) {
    const entry = out.projects[now], mine = mp[name], before = sp[name] ?? {};
    if (!entry) continue;
    applyChanges(entry, mine, before);
    entry.formerNames = [...new Set([...(entry.formerNames ?? []), ...(Array.isArray(mine.formerNames) ? mine.formerNames : [])])].filter((n) => n !== now);
  }
  return out;
}

// Writes into `entry` (the disk's) each field `mine` changed since `before`:
// a set field is set, a removed one removed. Former names are joined by the
// caller, never replaced.
function applyChanges(entry, mine, before) {
  for (const field of new Set([...Object.keys(mine ?? {}), ...Object.keys(before)])) {
    if (field === "formerNames") continue;
    if (same(mine?.[field], before[field])) continue;
    if (mine?.[field] === undefined) delete entry[field];
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

// Moves a project's local entry from one name to another, or merges it into
// the entry already under the new name: the one helper every rename of a
// local entry uses (init --rename-local, projects rename). The old name, and
// the names it had before, become former names of the destination, so
// workspaces made under any of them still find the project. Into an existing
// entry, the destination keeps its own settings and the source's other
// settings are dropped. Returns { moved } or { moved, merged, dropped } (the
// source's other settings, which a merge does not keep).
export function moveProjectEntry(projects, from, to) {
  if (!projects?.[from] || from === to) return { moved: false };
  const source = projects[from], target = projects[to];
  const former = (...lists) => [...new Set(lists.flatMap((l) => (Array.isArray(l) ? l : [])))].filter((n) => n !== to);
  if (!target) {
    projects[to] = { ...source, formerNames: former(source.formerNames, [from]) };
    delete projects[from];
    return { moved: true };
  }
  target.formerNames = former(target.formerNames, source.formerNames, [from]);
  const dropped = Object.fromEntries(Object.entries(source).filter(([k]) => k !== "formerNames"));
  delete projects[from];
  return { moved: true, merged: true, dropped };
}

// Moves the entry in config.json on disk, under the config lock, and then
// the same in `projects` held in memory, so a command that saves the whole
// config later keeps the move. Returns what moveProjectEntry returns.
export function moveProjectEntryOnDisk(projects, from, to) {
  let moved = { moved: false };
  const written = updateConfig((cfg) => {
    moved = moveProjectEntry(cfg.projects, from, to);
    return !moved.moved ? false : true;
  });
  if (written === false && !moved.moved) moved = moveProjectEntry(projects, from, to);
  else if (projects?.[from]) moveProjectEntry(projects, from, to);
  return moved;
}
