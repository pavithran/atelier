import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { foldPath } from '../src/rules.ts';

// A landing's lock and journal live under the CLI's cache, in a directory per
// checkout, never inside the checkout's Git directory. The owner's checkout
// sits in iCloud Drive, which syncs .git like any folder: a file it finds in
// conflict is renamed to a copy ("pid 2"), and a file already removed here can
// come back from the cloud, so a lock or journal kept there loses its owner
// record or its state between two commands. The cache is local to this Mac,
// which is also the only place a process id means anything. The directory is
// keyed by the Git directory's real path: a checkout reached through a symlink
// shares it, a linked worktree has its own.
export function landingDir(cache, gitDir) {
  const key = createHash('sha256').update(realpathSync(gitDir)).digest('hex').slice(0, 32);
  return join(cache, 'landing', key);
}

export const landingJournalFile = (dir) => join(dir, 'journal.json');

// Where an earlier CLI kept the journal and the lock: in the Git directory.
export const oldLandingJournalFile = (gitDir) => join(gitDir, 'atelier-landing.json');
export const oldLandingLockDir = (gitDir) => join(gitDir, 'atelier-landing.lock');

// Whether a process with this pid is running: only "no such process" says it is gone.
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };

// Move a file with its bytes unchanged: a rename where both sit on one
// volume, otherwise a copy made whole beside the destination and renamed in.
function moveFile(from, to) {
  try { renameSync(from, to); return; }
  catch (error) { if (error.code !== 'EXDEV') throw error; }
  copyFileSync(from, `${to}.tmp`); renameSync(`${to}.tmp`, to); unlinkSync(from);
}

// A landing interrupted under an earlier CLI left its journal, and perhaps
// its lock, in the Git directory. Called before the landing state is read
// (merge, merge --cancel, sync). The old lock is removed when every owner it
// records is gone, the record being `pid` or the copy iCloud makes of it
// ("pid 2"); a live owner still blocks, and a lock with no readable owner
// waits for a human. The old journal then moves under the cache, unchanged,
// so the landing resumes or cancels as if it had always been there. A journal
// in both places is refused: nothing says which one the next step follows.
export function adoptOldLanding(gitDir, dir) {
  const lock = oldLandingLockDir(gitDir);
  if (existsSync(lock)) {
    const owners = readdirSync(lock).filter((name) => /^pid( \d+)?$/.test(name))
      .flatMap((name) => { try { return [Number(readFileSync(join(lock, name), 'utf8'))]; } catch { return []; } })
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
    if (!owners.length) throw new Error(`the landing lock ${lock}, left by an earlier CLI, has no owner record; inspect it before retrying`);
    const live = owners.find(alive);
    if (live !== undefined) throw new Error(`another landing process (pid ${live}) is still running; its lock is ${lock}`);
    rmSync(lock, { recursive: true });
  }
  const old = oldLandingJournalFile(gitDir), file = landingJournalFile(dir);
  if (!existsSync(old)) return;
  if (existsSync(file)) throw new Error(`a landing journal is in two places: ${old}, left by an earlier CLI, and ${file}; keep the one this landing follows and remove the other before retrying`);
  mkdirSync(dir, { recursive: true });
  moveFile(old, file);
}

// A local journal makes remote failures recoverable without repeating the Git
// merge. It is opened for one project and item, and for one accepted
// revision when `identity.head` is given; without it, the journal of that
// item at any revision opens, as merge --cancel needs once the acceptance
// has moved. A journal of another item is refused, naming the commands
// that end it.
export function landingJournal(dir, identity) {
  const file = landingJournalFile(dir);
  let state = existsSync(file) ? JSON.parse(readFileSync(file,'utf8')) : null;
  if (state && (state.project !== identity.project || state.item !== identity.item || ('head' in identity && state.head !== identity.head))) {
    const run = `atelier merge ${state.item} --project ${state.project}`;
    throw new Error(`finish the pending landing for ${state.project}/${state.item} before starting another: ${run}, or cancel it with ${run} --cancel`);
  }
  return {
    get state() { return state; },
    get file() { return file; },
    save(value) { state = {...identity,...state,...value}; mkdirSync(dir,{recursive:true}); writeFileSync(`${file}.tmp`,JSON.stringify(state,null,2)+'\n',{mode:0o600}); renameSync(`${file}.tmp`,file); },
    clear() { rmSync(file,{force:true}); state=null; },
  };
}

// What a landing left in the owner's checkout, read from its journal
// `begun`. `commit` is the merge commit it made: the journal's, or else the
// first commit on `branch` after the start when it is this landing's own
// (two parents, the start first, and `marker`, the landing's line, in its
// message), made just before a crash kept the journal from naming it.
// `held` says whether the branch still holds that commit. `merging` says
// whether the Git merge the landing began is unfinished in the checkout: a
// merge in progress on the start whose incoming tree is the accepted
// revision's. In a project whose baseline holds part of its history the
// incoming commit is the accepted revision rebuilt, with the same tree.
// `git` is the landing's Git runner.
export function landingLeft(git, cwd, gitDir, begun, branch, marker) {
  const ref = `refs/heads/${branch}`;
  let commit = begun.mergeCommit ?? null;
  if (!commit) {
    const chain = git(['rev-list', '--first-parent', '--reverse', '--parents', `${begun.start}..${ref}`], { cwd, allowFail: true });
    const [first, ...parents] = chain.status === 0 ? chain.stdout.split('\n')[0].split(' ') : [];
    if (parents.length === 2 && parents[0] === begun.start && git(['log', '-1', '--format=%B', first], { cwd }).split('\n').includes(marker)) commit = first;
  }
  const held = !!commit && git(['merge-base', '--is-ancestor', commit, ref], { cwd, allowFail: true }).status === 0;
  const tree = (rev) => { const r = git(['rev-parse', '--verify', '--quiet', `${rev}^{tree}`], { cwd, allowFail: true }); return r.status === 0 ? r.stdout.trim() : null; };
  const incoming = !begun.mergeCommit && existsSync(join(gitDir, 'MERGE_HEAD')) && git(['rev-parse', 'HEAD'], { cwd }) === begun.start ? tree('MERGE_HEAD') : null;
  return { commit, held, merging: !!incoming && incoming === tree(begun.head) };
}

// One landing at a time per checkout: the lock is a directory, created
// atomically, holding the owner's pid. A lock whose owner is gone is
// reclaimed; one with no readable owner record is left for a human, since
// nothing says whose it is.
export function landingLock(dir) {
  const path=join(dir,'lock');
  mkdirSync(dir,{recursive:true});
  try { mkdirSync(path); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let pid;
    try { pid=Number(readFileSync(join(path,'pid'),'utf8')); } catch { throw new Error(`the landing lock ${path} has no owner record; inspect it before retrying`); }
    if (!Number.isSafeInteger(pid)||pid<=0) throw new Error(`the landing lock ${path} is invalid; inspect it before retrying`);
    try { process.kill(pid,0); throw new Error(`another landing process (pid ${pid}) is still running`); }
    catch (error) { if(error.code!=='ESRCH') throw error; }
    rmSync(path,{recursive:true}); mkdirSync(path);
  }
  writeFileSync(join(path,'pid'),String(process.pid));
  return ()=>rmSync(path,{recursive:true,force:true});
}

// ── what a landing must not run ──────────────────────────────────────────────

// Every hook off for one Git command of a landing, as configuration entries
// for its environment. core.hooksPath=/dev/null stops the hooks in a hooks
// folder, and Git 2.54 still runs a hook defined in configuration
// (hook.NAME.command with hook.NAME.event) under it, so each such hook is also
// set to hook.NAME.enabled=false, which Git 2.54 honours whatever scope
// defines the hook. The names are read just before the command, with the
// environment and folder it runs in, so they are the hooks it would see.
// core.fsmonitor=false keeps a configured fsmonitor hook from running too.
export function hooksOff(cwd, env = process.env) {
  const r = spawnSync('git', ['config', '--get-regexp', '-z', '^hook\\.'], { cwd, env, encoding: 'utf8' });
  // Exit status 1 means no hook.* setting exists.
  if (r.error || (r.status !== 0 && r.status !== 1)) throw new Error(`could not read which hooks Git's configuration defines, so the landing cannot turn them off: ${(r.stderr || r.error?.message || '').trim()}`);
  const names = new Set();
  for (const entry of r.stdout.split('\0')) {
    const key = entry.split('\n')[0], last = key.lastIndexOf('.');
    if (last > 'hook.'.length) names.add(key.slice('hook.'.length, last));
  }
  return [['core.hooksPath', '/dev/null'], ['core.fsmonitor', 'false'], ...[...names].map((name) => [`hook.${name}.enabled`, 'false'])];
}

// Settings whose value is a command Git runs in this checkout, during a
// landing or at the owner's later Git commands. Keys are as `git config
// --list` prints them: section and name in lower case, subsection as written.
const COMMAND_SETTING = /^(hook\..+\.command|filter\..+\.(clean|smudge|process)|merge\..+\.driver|diff\..+\.(textconv|command)|diff\.external|core\.(fsmonitor|editor|pager|sshcommand|askpass)|sequence\.editor|interactive\.difffilter|pager\..+|gpg\.(.+\.)?program|credential\.(.+\.)?helper|alias\..+)$/;

// The words of a shell command that can name a file. Quotes and backslashes
// are read as the shell reads them, and `;`, `&`, `|`, parentheses and
// redirections start a new command. Left out: the first word of a command
// when it has no slash, since the shell finds that program on PATH; an
// option (from `-`), though the value after its `=` is kept; and a word
// holding a placeholder Git fills in (%f, %O, %A). A variable or command
// substitution, as in $(git rev-parse --show-toplevel)/tools/x.sh, becomes
// `.`, which reads the path after it from the top of the work tree. A word
// holding spaces or `;`, `&` or `|` is read again as a command of its own,
// as `sh -c 'cd tools && ./x.sh'` runs it.
export function commandWords(command) {
  const text = String(command).replace(/^\s*!/, '').replace(/\$\((?:[^()]|\([^()]*\))*\)|\$\{[^}]*\}|\$\w+|`[^`]*`/g, '.');
  const commands = [[]];
  let word = null, quote = null;
  const end = () => { if (word !== null) commands.at(-1).push(word); word = null; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else word += c === '\\' && quote === '"' && i + 1 < text.length ? text[++i] : c;
    } else if (c === "'" || c === '"') { quote = c; word ??= ''; }
    else if (c === '\\' && i + 1 < text.length) word = (word ?? '') + text[++i];
    else if (/\s/.test(c)) end();
    else if (/[;&|()<>]/.test(c)) { end(); if (commands.at(-1).length) commands.push([]); }
    else word = (word ?? '') + c;
  }
  end();
  return commands.flatMap((words) => words.flatMap((w, i) => {
    const value = w.startsWith('-') ? (w.includes('=') ? w.slice(w.indexOf('=') + 1) : '') : w;
    const own = value && !value.includes('%') && (i > 0 || value.includes('/')) ? [value] : [];
    return /[\s;&|]/.test(w) ? [...own, ...commandWords(w)] : own;
  }));
}

// A path with every symlink in its existing part resolved; the part that
// does not exist yet is kept as written.
function realish(path) {
  let head = resolve(path);
  const rest = [];
  for (;;) {
    try { return join(realpathSync(head), ...rest); }
    catch {
      const parent = dirname(head);
      if (parent === head) return resolve(path);
      rest.unshift(basename(head));
      head = parent;
    }
  }
}

// The paths in this checkout's work tree that its Git configuration runs, or
// reads as configuration, each with a phrase saying why, to follow the path
// in a message. They are the hooks folder (core.hooksPath, or .git/hooks
// when it is a symlink into the tree) with everything in it; the target of
// each hook there that is a symlink into the tree; each configuration file
// the checkout includes from inside the tree, since a change to it can
// define any of the others; and each path a command setting
// (COMMAND_SETTING) names. A path counts as inside the tree as written or
// with its symlinks resolved. Nothing under .git counts: Git never writes
// there from a tree. Paths are relative to the top of the work tree, with
// `/` between parts.
export function executablePaths(cwd, env = process.env) {
  const read = (args, dir) => {
    const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.error || r.status !== 0) throw new Error(`git ${args.join(' ')} failed while listing what this checkout's Git configuration runs: ${(r.stderr || r.error?.message || '').trim()}`);
    return r.stdout;
  };
  const top = read(['rev-parse', '--show-toplevel'], cwd).trim(), realTop = realpathSync(top);
  const found = new Map();
  const add = (path, setting) => {
    for (const [base, full] of [[top, resolve(top, path)], [realTop, realish(resolve(top, path))]]) {
      const rel = relative(base, full).split(sep).join('/');
      if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel) || foldPath(rel.split('/')[0]) === '.git') continue;
      if (!found.has(rel)) found.set(rel, setting);
    }
  };
  const fromTop = (word) => (word === '~' || word.startsWith('~/') ? join(homedir(), word.slice(1)) : resolve(top, word));
  // Each entry is the origin, then the key, a newline and the value.
  const listed = read(['config', '--list', '--show-origin', '-z'], top).split('\0');
  let hooksPathSet = false;
  for (let i = 0; i + 1 < listed.length; i += 2) {
    const origin = listed[i], newline = listed[i + 1].indexOf('\n');
    const key = newline < 0 ? listed[i + 1] : listed[i + 1].slice(0, newline), value = newline < 0 ? '' : listed[i + 1].slice(newline + 1);
    if (origin.startsWith('file:')) add(origin.slice('file:'.length), 'a Git configuration file this checkout includes');
    if (key === 'core.hookspath') hooksPathSet = true;
    if (COMMAND_SETTING.test(key)) for (const word of commandWords(value)) add(fromTop(word), `named by ${key}`);
  }
  // Git prints the hooks folder relative to the top, or in full.
  const shown = read(['rev-parse', '--git-path', 'hooks'], top).trim(), hooks = resolve(top, shown);
  // Without core.hooksPath the folder is .git/hooks, inside the tree only through a symlink.
  add(hooks, hooksPathSet ? 'the hooks folder named by core.hooksPath' : `the hooks folder ${shown} links to`);
  let names = [];
  try { names = readdirSync(hooks); } catch { /* no hooks folder: nothing in it runs */ }
  for (const name of names) if (lstatSync(join(hooks, name)).isSymbolicLink()) add(join(hooks, name), `the file the hook ${shown}/${name} links to`);
  return [...found].map(([path, setting]) => ({ path, setting }));
}

// The executable paths a change reaches, each with the changed paths that
// reach it: a changed path is the executable path, lies inside it (a hooks
// folder), or is a file or symlink in place of a folder above it. Paths are
// compared as a Mac's disk stores them, whatever their letter case or
// Unicode form, since that is where the change is written.
export function touchedExecutables(changed, executables) {
  const folded = changed.map((path) => [path, foldPath(path)]);
  return executables.flatMap(({ path, setting }) => {
    const e = foldPath(path);
    const by = folded.filter(([, c]) => c === e || c.startsWith(`${e}/`) || e.startsWith(`${c}/`)).map(([p]) => p);
    return by.length ? [{ path, setting, changed: by }] : [];
  });
}

// The paths a landing reads or writes in the ControlPlane folder: its policy
// files, read at every merge and sync; the receipt template; the receipts
// folder and the receipt written into it.
const CONTROL_PLANE = 'docs/control-plane';
export const RECEIPTS_DIR = `${CONTROL_PLANE}/landing-receipts`;
export const RECEIPT_TEMPLATE = `${CONTROL_PLANE}/landing-receipt.v1.json`;
const LANDING_PATHS = ['docs', CONTROL_PLANE, RECEIPTS_DIR, RECEIPT_TEMPLATE, ...['agent-policy.v1.json', 'execution-policy.v1.json', 'project-adapter.v1.json'].map((name) => `${CONTROL_PLANE}/${name}`)];

// The entries of a tree, from `git ls-tree -r -z --full-tree`: mode and path.
export function treeEntries(listing) {
  return listing.split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    return { mode: line.slice(0, line.indexOf(' ')), path: line.slice(tab + 1) };
  });
}

// The symlinks in a tree on a path a landing reads or writes, or directly in
// the receipts folder, where the receipt is written. A landing that follows
// one reads or writes outside the checkout. Compared folded, as a Mac's disk
// finds them.
export function landingSymlinks(entries) {
  const exact = new Set(LANDING_PATHS.map(foldPath)), receipts = `${foldPath(RECEIPTS_DIR)}/`;
  return entries.filter(({ mode, path }) => {
    if (mode !== '120000') return false;
    const f = foldPath(path);
    return exact.has(f) || (f.startsWith(receipts) && !f.slice(receipts.length).includes('/'));
  }).map(({ path }) => path);
}
