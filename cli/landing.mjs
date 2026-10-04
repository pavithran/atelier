import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// A local journal makes remote failures recoverable without repeating the Git merge.
export function landingJournal(gitDir, identity) {
  const file = join(gitDir, 'atelier-landing.json');
  let state = existsSync(file) ? JSON.parse(readFileSync(file,'utf8')) : null;
  if (state && (state.project !== identity.project || state.item !== identity.item || state.head !== identity.head)) {
    throw new Error(`finish the pending landing for ${state.project}/${state.item} before starting another`);
  }
  return {
    get state() { return state; },
    save(value) { state = {...identity,...state,...value}; writeFileSync(`${file}.tmp`,JSON.stringify(state,null,2)+'\n',{mode:0o600}); renameSync(`${file}.tmp`,file); },
    clear() { rmSync(file,{force:true}); state=null; },
  };
}

export function landingLock(gitDir) {
  const path=join(gitDir,'atelier-landing.lock');
  try { mkdirSync(path); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let pid;
    try { pid=Number(readFileSync(join(path,'pid'),'utf8')); } catch { throw new Error('a landing lock has no owner record; inspect it before retrying'); }
    if (!Number.isSafeInteger(pid)||pid<=0) throw new Error('invalid landing lock; inspect it before retrying');
    try { process.kill(pid,0); throw new Error('another landing process is still running'); }
    catch (error) { if(error.code!=='ESRCH') throw error; }
    rmSync(path,{recursive:true}); mkdirSync(path);
  }
  writeFileSync(join(path,'pid'),String(process.pid));
  return ()=>rmSync(path,{recursive:true,force:true});
}
