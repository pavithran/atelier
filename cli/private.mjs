// Private files (t645): files a project keeps on the developer's Macs and
// never pushes anywhere, such as PROJECT.md, the developer's plan. Code moves
// between Macs by Git, through a checkout outside iCloud on each Mac; the
// private files stay in the project's iCloud folder, which iCloud syncs, and
// each checkout holds a symbolic link to each of them. Git ignores them
// through the checkout's .git/info/exclude, never .gitignore, which is
// pushed. The project's entry in this Mac's config.json names them:
// `private` (paths in the checkout) and `privateHome` (the folder holding
// them; by default the iCloud ai-projects folder named for the project).
//
// Atelier never pushes them: wrap refuses to stage one, and every command
// that pushes commits (sync, publish, merge, wrap --push and publish REMOTE)
// or lands them (fast land) refuses a commit that adds, changes or retypes
// one (privateCommits). Git commits a symbolic link as a link, never the
// file it points at, and the refusal covers the link too.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { privateExcludeLine, privateFolderMatches, privatePathsAmong } from "../src/rules.ts";

// The iCloud folder that holds a folder per project.
export const privateRoot = () => join(homedir(), "Library", "Mobile Documents", "com~apple~CloudDocs", "ai-projects");

const EXCLUDE_HEADER = "# Private files Atelier links into this checkout (atelier private ls); never committed";

function gitRead(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

// The folder that keeps a project's private files: the one its entry names,
// else the one folder in the iCloud ai-projects folder named for it.
export function privateHome(name, entry, root = privateRoot()) {
  if (entry?.privateHome) return { home: entry.privateHome, named: true };
  let found;
  try {
    found = readdirSync(root, { withFileTypes: true })
      .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && privateFolderMatches(String(name ?? ""), d.name))
      .map((d) => d.name).sort();
  } catch { return { error: `${root} cannot be read, so no folder there is known to be ${name}'s; name one with atelier private add --home DIR --project ${name}` }; }
  if (found.length === 1) return { home: join(root, found[0]), named: false };
  if (!found.length) return { error: `no folder in ${root} is named for ${name}; name one with atelier private add --home DIR --project ${name}` };
  return { error: `more than one folder in ${root} is named for ${name} (${found.join(", ")}); name one with atelier private add --home DIR --project ${name}` };
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

// Whether the checkout's info/exclude holds the line for a private path.
export function excludesPrivate(checkout, path) {
  const file = excludeFile(checkout);
  return existsSync(file) && readFileSync(file, "utf8").split("\n").includes(privateExcludeLine(path));
}

// The private paths Git tracks in the checkout, or holds files under.
export function trackedPrivate(checkout, paths) {
  if (!paths.length) return [];
  const r = gitRead(checkout, ["--literal-pathspecs", "ls-files", "-z", "--", ...paths]);
  if (r.status !== 0) throw new Error(`git ls-files failed in ${checkout}: ${(r.stderr || "").trim().split("\n")[0]}`);
  const tracked = r.stdout.split("\0").filter(Boolean);
  return paths.filter((path) => privatePathsAmong(tracked, [path]).length);
}

const lstat = (path) => { try { return lstatSync(path); } catch { return null; } };

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
  const paths = entry?.private ?? [];
  const result = { linked: [], kept: [], missing: [], refused: [], said: [] };
  if (!paths.length) return result;
  const say = (line) => result.said.push(line);
  excludePrivate(checkout, paths);
  const found = privateHome(name, entry, root);
  if (found.error) { say(`Private files not linked: ${found.error}. Git ignores ${paths.join(", ")} in ${checkout}.`); result.home = null; return result; }
  const home = result.home = found.home;
  if (!existsSync(home) || !statSync(home).isDirectory()) {
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
    const above = linkAbove(checkout, path);
    if (above) { result.refused.push(path); say(`${path}: ${above} in the checkout is a symbolic link, so a link under it would land outside the checkout; not linked.`); continue; }
    if (!lstat(target)) { result.missing.push(path); say(`${path}: not in ${home}; not linked.`); continue; }
    const stat = lstat(link);
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
  if (done.length) say(`Private files linked from ${home}: ${done.join(", ")}. Git ignores them, and Atelier never pushes them.`);
  return result;
}

// The paths wrap would stage that are private: tracked changes against HEAD,
// staged or not, and new files Git does not ignore. A deletion is not one:
// it stages no content. Read without writing the index.
export function privateChanges(cwd, privates) {
  if (!privates?.length) return [];
  const readOnly = ["-c", "diff.autoRefreshIndex=false", "-c", "core.quotePath=false", "--no-optional-locks"];
  const changed = gitRead(cwd, [...readOnly, "diff", "HEAD", "--name-only", "--no-renames", "--diff-filter=d", "-z"]);
  const added = gitRead(cwd, [...readOnly, "ls-files", "--others", "--exclude-standard", "-z"]);
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
  const r = gitRead(cwd, [
    "-c", "log.showSignature=false", "-c", "diff.relative=false", "-c", "core.quotePath=false", "--no-replace-objects",
    "log", "--format=%x01%H", "-z", "--name-only", "--no-renames", "--diff-filter=d", "--diff-merges=first-parent",
    tip, ...(base.length ? ["--not", ...base] : []), "--",
  ]);
  if (r.status !== 0) throw new Error(`the commits to be pushed could not be read for private files (${(r.stderr || "").trim().split("\n")[0] || `git log exited ${r.status}`})`);
  const found = [];
  for (const record of r.stdout.split("\x01").filter(Boolean)) {
    const [commit, ...rest] = record.split("\0");
    const paths = rest.map((p, i) => (i === 0 ? p.replace(/^\n/, "") : p)).filter(Boolean);
    for (const path of privatePathsAmong(paths, privates)) found.push({ commit, path });
  }
  return found;
}

// The commits privateCommits found, as one line: each path with its commit.
export function privateCommitsText(found) {
  const shown = found.slice(0, 20).map(({ commit, path }) => `${path} in ${commit.slice(0, 12)}`);
  return `${shown.join(", ")}${found.length > 20 ? `, and ${found.length - 20} more` : ""}`;
}

// The refusal for commits that would carry private files, or null.
export function privateRefusal(cwd, privates, tip, base, what) {
  let found;
  try { found = privateCommits(cwd, privates, tip, base); } catch (error) { return `${what}: ${error.message}`; }
  if (!found.length) return null;
  return `${what} would carry private files: ${privateCommitsText(found)}. They are private to this Mac's iCloud folder (atelier private ls) and Atelier never pushes them. Take them out of those commits (git rm --cached PATH, then amend, or rewrite the commits) and try again.`;
}
