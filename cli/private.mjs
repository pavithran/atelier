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
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PRIVATE_LIST, parsePrivateList, privateExcludeLine, privateFolderMatches, privateListText, privatePath, privatePathsAmong } from "../src/rules.ts";

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
  let found;
  try {
    found = readdirSync(root, { withFileTypes: true })
      .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && privateFolderMatches(String(name ?? ""), d.name))
      .map((d) => d.name).sort();
  } catch (error) {
    // No iCloud ai-projects folder on this Mac at all is no folder for the
    // project; one that is there and cannot be read hides what may be in it.
    if (error?.code === "ENOENT") return { error: `there is no ${root} on this Mac`, none: true };
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
export function privateGuard(name, entry, { root, save } = {}) {
  // Private files are opt-in (third reviews of t645): a project with none
  // configured here is not guarded and its iCloud folder is never read.
  if (!privateConfigured(entry)) return { paths: [], refusal: null };
  const list = discoverPrivate(name, entry, { root, save });
  const kept = Array.isArray(entry?.privateFromList);
  const copy = plainPaths(entry?.privateFromList);
  const paths = [...new Set([...list.paths, ...copy])];
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
// read: only such a list replaces the copy; a missing or unreadable one never
// shrinks it. clone, private add and private ls run this, so a list in iCloud
// opts the project in on this Mac. Returns what privateList returns.
export function discoverPrivate(name, entry, { root, save } = {}) {
  const list = privateList(name, entry, root);
  if (entry && list.fromList) {
    const kept = entry.privateFromList ?? null;
    if (!kept || kept.length !== list.fromList.length || kept.some((p, i) => p !== list.fromList[i])) {
      entry.privateFromList = [...list.fromList];
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
export function projectKey(projects, name) {
  if (!projects || typeof name !== "string") return null;
  if (Object.hasOwn(projects, name)) return name;
  return Object.keys(projects).find((key) => Array.isArray(projects[key]?.formerNames) && projects[key].formerNames.includes(name)) ?? null;
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
  const file = configFile();
  let cfg;
  try { cfg = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  const key = projectKey(cfg.projects, project);
  if (!key || !entry) return false;
  const target = cfg.projects[key];
  const names = [...new Set([...plainPaths(target.private), ...plainPaths(entry.private)])].filter((p) => !drop.includes(p));
  if (Array.isArray(target.private) || Array.isArray(entry.private)) target.private = names;
  if (Array.isArray(entry.privateFromList)) target.privateFromList = plainPaths(entry.privateFromList).filter((p) => !drop.includes(p));
  if (home) target.privateHome = home;
  else if (entry.privateHome && !target.privateHome) target.privateHome = entry.privateHome;
  const part = `${file}.${process.pid}.part`;
  writeFileSync(part, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  try { renameSync(part, file); } catch (error) { rmSync(part, { force: true }); throw error; }
  return true;
}

// `pending` stands for the entry of a project this Mac does not register
// yet (a first init), used only while the config holds none.
export function privateGuardFor(project, { root, discover = false, pending = null } = {}) {
  if (typeof project !== "string" || !project) throw new Error("the private-file guard needs the project's name");
  const run = (entry) => {
    let save = entry ? () => savePrivateFields(project, entry) : null;
    if (!entry && pending) { entry = pending; save = null; }
    if (discover) discoverPrivate(project, entry, { root, save });
    return privateGuard(project, entry, { root, save });
  };
  const file = configFile();
  let cfg;
  try { cfg = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) {
    if (error?.code !== "ENOENT") return { paths: [PRIVATE_LIST], refusal: `${file} cannot be read (${error?.code ?? error?.message}), so ${project}'s private files cannot be known. Nothing was pushed.` };
    cfg = { projects: {} };
  }
  const diskKey = projectKey(cfg.projects, project);
  if (shared) {
    const onDisk = diskKey ? cfg.projects[diskKey] : null;
    shared.cfg.projects ??= {};
    let memKey = projectKey(shared.cfg.projects, project) ?? diskKey;
    if (onDisk) {
      const entry = shared.cfg.projects[memKey] ??= { ...onDisk };
      joinPrivate(entry, onDisk);
    }
    return run(memKey ? shared.cfg.projects[memKey] : undefined);
  }
  return run(diskKey ? cfg.projects[diskKey] : undefined);
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

// The checkout's info/exclude file, wherever its Git directory keeps it.
function excludeFile(checkout) {
  const r = gitRead(checkout, ["rev-parse", "--git-path", "info/exclude"]);
  if (r.status !== 0) throw new Error(`${checkout} is not a Git checkout`);
  return resolve(checkout, r.stdout.trim());
}

// Adds a line to the checkout's info/exclude for each private path it does
// not ignore yet. Returns the lines added.
export function excludePrivate(checkout, paths) {
  const file = excludeFile(checkout);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const have = new Set(text.split("\n"));
  const lines = [...new Set(paths.map(privateExcludeLine))].filter((line) => !have.has(line));
  if (!lines.length) return [];
  mkdirSync(dirname(file), { recursive: true });
  const head = have.has(EXCLUDE_HEADER) ? [] : [EXCLUDE_HEADER];
  writeFileSync(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${[...head, ...lines].join("\n")}\n`);
  return lines;
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
// after it clones and by private add; atelier pull (t644) is to call it after
// it pulls. It never overwrites a file or folder: one standing where a link
// would go is left as it is and reported. A link of its own pointing
// elsewhere (a home that moved) is replaced. Returns what it did, with the
// lines to print in `said`.
export function linkPrivate(checkout, entry, { name, root } = {}) {
  const list = privateList(name, entry, root);
  const paths = list.paths;
  const result = { linked: [], kept: [], missing: [], refused: [], invalid: list.refused, said: [] };
  const say = (line) => result.said.push(line);
  // A line of the list that is no plain path in the checkout is named and
  // skipped; the others are linked.
  for (const r of list.refused) say(`${PRIVATE_LIST}${r.line ? ` line ${r.line}` : ""}: ${r.error}; skipped.`);
  if (!paths.length && !list.listed) return result;
  excludePrivate(checkout, [...paths, PRIVATE_LIST]);
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
      if (readlinkSync(link) === target) { result.kept.push(path); continue; }
      unlinkSync(link);
    } else if (stat) {
      result.refused.push(path);
      say(`${path}: a ${stat.isDirectory() ? "folder" : "file"} Atelier did not link is already in the checkout; it was left as it is, not linked. Move it into ${home}, then run atelier private add ${path} --project ${name} to link it.`);
      continue;
    }
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link);
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
export function guardedPush({ project, cwd, tip, base = [], bases = [base], what, fail = (message) => { throw new Error(message); }, root, pending = null }, push) {
  const guard = privateGuardFor(project, { root, pending });
  if (guard.refusal) return fail(`${what}: ${guard.refusal}`);
  if (guard.paths.length) {
    const read = typeof bases === "function" ? bases() : { bases };
    if (read.error) return fail(`${what}: ${read.error}. Nothing was pushed.`);
    for (const held of read.bases) {
      const refusal = privateRefusal(cwd, guard.paths, tip, held, what);
      if (refusal) return fail(`${refusal} Nothing was pushed.`);
    }
  }
  return push();
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
