import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

// A local journal makes remote failures recoverable without repeating the Git merge.
export function landingJournal(dir, identity) {
  const file = landingJournalFile(dir);
  let state = existsSync(file) ? JSON.parse(readFileSync(file,'utf8')) : null;
  if (state && (state.project !== identity.project || state.item !== identity.item || state.head !== identity.head)) {
    throw new Error(`finish the pending landing for ${state.project}/${state.item} before starting another`);
  }
  return {
    get state() { return state; },
    get file() { return file; },
    save(value) { state = {...identity,...state,...value}; mkdirSync(dir,{recursive:true}); writeFileSync(`${file}.tmp`,JSON.stringify(state,null,2)+'\n',{mode:0o600}); renameSync(`${file}.tmp`,file); },
    clear() { rmSync(file,{force:true}); state=null; },
  };
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
