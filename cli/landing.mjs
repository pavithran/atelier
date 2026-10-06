import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
