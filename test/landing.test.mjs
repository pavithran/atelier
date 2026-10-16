import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync,readFileSync,readdirSync,realpathSync,symlinkSync,renameSync,copyFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {adoptOldLanding,landingDir,landingJournal,landingJournalFile,landingLock,oldLandingJournalFile,oldLandingLockDir} from '../cli/landing.mjs';
import {SERVER_CAPABILITIES} from '../src/route-level.ts';
// No test reads this Mac's own iCloud folder (t645).
process.env.ATELIER_PRIVATE_ROOT ||= `${process.env.TMPDIR || "/tmp"}/atelier-tests-no-icloud-${process.pid}`;
// merge checks the server's capabilities first (t458); each stand-in answers the version before anything is recorded.
const versionAnswer=(req,res)=>{if(req.url!=='/api/version')return false;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({capabilities:SERVER_CAPABILITIES}));return true;};
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
// The commit identity the fixtures' commits carry (t451), which a landing checks.
const IDENTITY={name:'Fixture',email:'fixture@example.invalid',agentEmails:[]};

function root(t){const p=mkdtempSync(join(tmpdir(),'atelier-land-'));t.after(()=>rmSync(p,{recursive:true,force:true}));return p;}
test('landing journals survive restarts and refuse another revision or live lock',t=>{
 const p=root(t),identity={project:'p',item:'t1',head:'a'.repeat(40)};
 const journal=landingJournal(p,identity);journal.save({phase:'prepared',start:'base'});
 assert.equal(landingJournal(p,identity).state.phase,'prepared');assert.throws(()=>landingJournal(p,{...identity,head:'b'}),/pending landing/);
 const release=landingLock(p);assert.throws(()=>landingLock(p),/still running/);release();journal.clear();assert.equal(landingJournal(p,identity).state,null);
});

// The owner's checkout is in iCloud Drive, which renames a file it finds in
// conflict to a copy ("pid 2") and brings back one already removed. A lock or
// journal in its Git directory could then lose its owner record or its state,
// so neither is kept there: both live under the cache, keyed by the Git
// directory's real path.
test('the landing lock and journal live under the cache, keyed by the Git directory, never in it',t=>{
 const p=root(t),cache=join(p,'cache'),checkout=join(p,'checkout'),gitDir=join(checkout,'.git');mkdirSync(gitDir,{recursive:true});
 const dir=landingDir(cache,gitDir);
 assert.ok(dir.startsWith(join(cache,'landing')+'/'),dir);
 const release=landingLock(dir);
 assert.equal(readFileSync(join(dir,'lock','pid'),'utf8'),String(process.pid));
 const journal=landingJournal(dir,{project:'p',item:'t1',head:'a'.repeat(40)});journal.save({phase:'prepared'});
 assert.equal(journal.file,landingJournalFile(dir));assert.ok(existsSync(journal.file));
 assert.deepEqual(readdirSync(gitDir),[],'the Git directory holds neither lock nor journal');
 // The checkout reached through a symlink has the same lock, so a live owner blocks through either path.
 const alias=join(p,'alias');symlinkSync(checkout,alias);
 assert.equal(landingDir(cache,join(alias,'.git')),dir);
 assert.throws(()=>landingLock(landingDir(cache,join(alias,'.git'))),/pid \d+\) is still running/);
 release();journal.clear();
 assert.ok(!existsSync(join(dir,'lock')));assert.ok(!existsSync(journal.file));
});

test('a lock whose owner is gone is reclaimed; one with no owner record names itself and waits for a human',t=>{
 const p=root(t),dir=join(p,'landing'),lock=join(dir,'lock');
 // No process on a Mac or on Linux has this pid, so its owner is gone.
 mkdirSync(lock,{recursive:true});writeFileSync(join(lock,'pid'),'2147483647');
 const release=landingLock(dir);assert.equal(readFileSync(join(lock,'pid'),'utf8'),String(process.pid));release();
 mkdirSync(lock);
 assert.throws(()=>landingLock(dir),{message:`the landing lock ${lock} has no owner record; inspect it before retrying`});
 writeFileSync(join(lock,'pid'),'not a pid');
 assert.throws(()=>landingLock(dir),{message:`the landing lock ${lock} is invalid; inspect it before retrying`});
});

// A landing interrupted under an earlier CLI left its journal, and perhaps
// its lock, in the Git directory. Before the landing state is read, the
// journal moves under the cache with its bytes unchanged; a journal in both
// places is refused, naming both. The lock's owner is read from `pid` or from
// the copy iCloud makes of it: a live owner blocks, a gone one frees the lock,
// and a lock with no readable owner waits for a human.
test('an old journal moves under the cache unchanged; one in both places, and an old lock with a live or no owner, refuse',t=>{
 const p=root(t),gitDir=join(p,'checkout','.git'),dir=join(p,'landing');mkdirSync(gitDir,{recursive:true});
 const old=oldLandingJournalFile(gitDir),file=landingJournalFile(dir),lock=oldLandingLockDir(gitDir),identity={project:'p',item:'t1',head:'a'.repeat(40)};
 const text=JSON.stringify({...identity,start:'base',phase:'prepared'},null,2)+'\n';
 adoptOldLanding(gitDir,dir);assert.ok(!existsSync(file),'nothing old, nothing moved');
 writeFileSync(old,text);adoptOldLanding(gitDir,dir);
 assert.ok(!existsSync(old));assert.equal(readFileSync(file,'utf8'),text);assert.equal(landingJournal(dir,identity).state.phase,'prepared');
 writeFileSync(old,'{}\n');
 assert.throws(()=>adoptOldLanding(gitDir,dir),{message:`a landing journal is in two places: ${old}, left by an earlier CLI, and ${file}; keep the one this landing follows and remove the other before retrying`});
 assert.equal(readFileSync(old,'utf8'),'{}\n');assert.equal(readFileSync(file,'utf8'),text);
 rmSync(old);
 mkdirSync(lock);writeFileSync(join(lock,'pid 2'),String(process.pid));
 assert.throws(()=>adoptOldLanding(gitDir,dir),{message:`another landing process (pid ${process.pid}) is still running; its lock is ${lock}`});
 // No process on a Mac or on Linux has this pid, so its owner is gone.
 writeFileSync(join(lock,'pid 2'),'2147483647');adoptOldLanding(gitDir,dir);assert.ok(!existsSync(lock));
 mkdirSync(lock);assert.throws(()=>adoptOldLanding(gitDir,dir),{message:`the landing lock ${lock}, left by an earlier CLI, has no owner record; inspect it before retrying`});
 writeFileSync(join(lock,'pid'),'not a pid');assert.throws(()=>adoptOldLanding(gitDir,dir),/has no owner record/);assert.ok(existsSync(lock));
});

// The owner's checkout, its baseline, and a task fork pushed from a workspace,
// served by a fake ledger that answers from `box`: the item's state, whether
// the next landing lease or merged acknowledgment fails once with a 503, and
// whether the registered check fails.
async function mergeFixture(t){
 const p=root(t),seed=join(p,'seed'),baseline=join(p,'baseline.git'),fork=join(p,'fork.git'),checkout=join(p,'checkout'),workspace=join(p,'workspace'),config=join(p,'config'),cache=join(p,'cache');
 mkdirSync(seed);mkdirSync(config);git(seed,'init','-b','main');git(seed,'config','user.name','Fixture');git(seed,'config','user.email','fixture@example.invalid');writeFileSync(join(seed,'work.txt'),'base\n');git(seed,'add','.');git(seed,'commit','-m','Initial');
 git(p,'clone','--bare',seed,baseline);git(p,'clone','--bare',baseline,fork);git(p,'clone',baseline,checkout);git(p,'clone',fork,workspace);
 for(const dir of [checkout,workspace]){git(dir,'config','user.name','Fixture');git(dir,'config','user.email','fixture@example.invalid');}
 for(const [key,value] of Object.entries({project:'proj',item:'t1',actor:'codex/test',branch:'main'}))git(workspace,'config',`atelier.${key}`,value);
 writeFileSync(join(workspace,'work.txt'),'changed\n');git(workspace,'add','.');git(workspace,'commit','-m','Task');git(workspace,'push','origin','main');
 const head=git(workspace,'rev-parse','HEAD');const box={state:'submitted',failLanding:false,failMerge:false,failChecks:false,requests:[]};
 const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{};if(versionAnswer(req,res))return;box.requests.push({path:req.url,body});
  const item={id:'t1',title:'Fixture task',state:box.state,owner:'codex/test',head,acceptedHead:box.state==='accepted'||box.state==='merged'?head:null};
  let answer={item,policy:{checks:[box.failChecks?'exit 9':'exit 0'],protected:[],commitIdentity:IDENTITY},gate:{ready:true,outOfScope:[],blockers:[]},evidence:[],reviews:[],events:[]};
  const failOnce=()=>{res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'temporary',detail:'retry'}));};
  if(req.url.endsWith('/review'))assert.equal(body.head,head);
  else if(req.url.endsWith('/accept')){assert.equal(body.head,head);box.state='accepted';answer={...item,state:box.state,acceptedHead:head};}
  else if(req.url.endsWith('/baseline-token')||req.url.endsWith('/base-token'))answer={remote:baseline,token:'fixture',defaultBranch:'main'};
  else if(req.url.endsWith('/read-token'))answer={remote:fork,token:'fixture',head,defaultBranch:'main'};
  else if(req.url.endsWith('/landing')&&body.cancel!==true&&box.failLanding){box.failLanding=false;return failOnce();}
  else if(req.url.endsWith('/merged')){
   if(box.failMerge){box.failMerge=false;return failOnce();}
   box.state='merged';answer={...item,state:box.state,...(box.postMerge?{postMerge:box.postMerge}:{})};
  }else if(req.url.endsWith('/post-merge/t1'))answer={run:box.postMerge??null};
  else if(req.url.endsWith('/push'))answer={...item,head};
  else if(req.url.endsWith('/submit')){box.state='submitted';answer={...item,state:box.state};}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(answer));
 });
 await new Promise(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>server.close());
 const url=`http://127.0.0.1:${server.address().port}`;writeFileSync(join(config,'config.json'),JSON.stringify({server:url,owner:'owner',projects:{proj:{path:checkout,branch:'main'}}}));
 async function run(cwd,...args){const child=spawn(process.execPath,[resolve('cli/atelier.mjs'),...args,'--project','proj'],{cwd,env:{...process.env,ATELIER_CONFIG_DIR:config,ATELIER_TOKEN:'fixture',ATELIER_CACHE:cache,ATELIER_SERVER:url}});let output='';child.stdout.on('data',s=>output+=s);child.stderr.on('data',s=>output+=s);const status=await new Promise(ok=>child.on('close',ok));return{status,output};}
 return{p,baseline,checkout,workspace,head,box,run,journalFile:landingJournalFile(landingDir(cache,join(checkout,'.git')))};
}

test('an accepted task merge conflict names both owner paths back to building',async t=>{
 const {checkout,baseline,head,box,run,journalFile}=await mergeFixture(t);
 box.state='accepted';
 writeFileSync(join(checkout,'work.txt'),'main changed the same line\n');
 git(checkout,'add','work.txt');git(checkout,'commit','-m','Conflicting main');
 const before=git(checkout,'rev-parse','HEAD'),baselineBefore=git(checkout,'ls-remote',baseline,'refs/heads/main');
 const result=await run(checkout,'merge','t1');
 assert.equal(result.status,1,result.output);
 assert.match(result.output,/atelier dispatch t1 --job merge-main/);
 assert.match(result.output,/atelier handoff t1 --to H\/M/);
 assert.match(result.output,/earlier reviews and acceptance stay in the history/);
 assert.equal(box.state,'accepted');assert.equal(git(checkout,'rev-parse','HEAD'),before);
 assert.equal(git(checkout,'ls-remote',baseline,'refs/heads/main'),baselineBefore);
 assert.equal(git(checkout,'status','--porcelain'),'');assert.ok(!existsSync(journalFile));
 assert.ok(!box.requests.some(r=>r.path.endsWith('/merged')||r.path.endsWith('/handoff')||r.path.endsWith('/dispatch')));
});

test('merge --head resumes after ledger failure without a second merge; finish stops on failed checks',async t=>{
  if (!canInspectSlots(t)) return;
 const {p,baseline,checkout,workspace,head,box,run,journalFile}=await mergeFixture(t);
 // The ledger's temporary failure is a server error: exit 4, the merge journal kept for the retry.
 box.failMerge=true;const first=await run(checkout,'merge','t1','--head',head,'--approve');assert.equal(first.status,4,first.output);const mergedHead=git(checkout,'rev-parse','HEAD');assert.notEqual(mergedHead,head);assert.ok(existsSync(journalFile));
 // Simulate another baseline commit before retrying the failed ledger acknowledgment.
 const next=join(p,'next');git(p,'clone',baseline,next);git(next,'config','user.name','Fixture');git(next,'config','user.email','fixture@example.invalid');
 writeFileSync(join(next,'later.txt'),'later work\n');git(next,'add','.');git(next,'commit','-m','Later work');git(next,'push','origin','main');
 const advanced=git(next,'rev-parse','HEAD');
 // Also simulate a partial ref publication: the baseline arrived but its notes did not.
 git(p,'--git-dir',baseline,'update-ref','-d','refs/notes/atelier');
 const second=await run(checkout,'merge','t1','--head',head);assert.equal(second.status,0,second.output);assert.equal(git(checkout,'rev-parse','HEAD'),mergedHead);assert.equal(git(p,'--git-dir',baseline,'rev-parse','HEAD'),advanced);assert.match(git(p,'--git-dir',baseline,'notes','--ref=atelier','show',mergedHead),/accepted head/);assert.equal(box.state,'merged');assert.ok(!existsSync(journalFile));
 box.state='claimed';box.failChecks=true;box.requests.length=0;const failed=await run(workspace,'finish');assert.equal(failed.status,2,failed.output);assert.ok(!box.requests.some(r=>r.path.endsWith('/submit')));
 box.failChecks=false;const finished=await run(workspace,'finish');assert.equal(finished.status,0,finished.output);assert.equal(box.state,'submitted');
});

// The same landing interrupted under the earlier CLI, which kept the journal
// in the Git directory: the next merge --cancel or merge reads it from there.
test('a landing the earlier CLI interrupted is cancelled or resumed from the journal it left in the Git directory',async t=>{
 const {p,baseline,checkout,head,box,run,journalFile}=await mergeFixture(t);
 // The CLI names the Git directory by its real path, as git rev-parse gives it.
 const gitDir=realpathSync(join(checkout,'.git')),oldJournal=oldLandingJournalFile(gitDir),oldLock=oldLandingLockDir(gitDir),before=git(checkout,'rev-parse','HEAD');
 // The merge commit is made, then the server fails: the journal names the commit. Put it where the earlier CLI kept it, with a lock whose owner record iCloud renamed.
 const interrupt=async(...args)=>{const r=await run(checkout,'merge','t1','--head',head,...args);assert.equal(r.status,4,r.output);renameSync(journalFile,oldJournal);mkdirSync(oldLock);writeFileSync(join(oldLock,'pid 2'),'2147483647');return readFileSync(oldJournal,'utf8');};
 const noOldFiles=()=>assert.ok(!existsSync(oldJournal)&&!existsSync(oldLock),'nothing of the earlier CLI is left in the Git directory');
 // A refusal before the landing state is read makes none of the calls that follow it.
 const nothingLanded=()=>assert.ok(!box.requests.some(r=>/\/(baseline-token|landing|merged)$/.test(r.path)),box.requests.map(r=>r.path).join(' '));
 // The landing lease fails: the merge commit is in the checkout and nowhere else.
 box.failLanding=true;const text=await interrupt('--approve');
 // Cancel finds the moved journal: it keeps the unpublished commit unless asked, then returns the checkout to where the merge began.
 const kept=await run(checkout,'merge','t1','--cancel');assert.equal(kept.status,1,kept.output);assert.match(kept.output,/unpublished commit/);
 noOldFiles();assert.equal(readFileSync(journalFile,'utf8'),text,'the journal moved with its bytes unchanged');
 const cancelled=await run(checkout,'merge','t1','--cancel','--discard-local');assert.equal(cancelled.status,0,cancelled.output);
 assert.equal(git(checkout,'rev-parse','HEAD'),before);assert.ok(!existsSync(journalFile));assert.ok(box.requests.some(r=>r.path.endsWith('/landing')&&r.body.cancel===true));
 // The merged acknowledgment fails after the push: the retry has only the ledger left to tell.
 box.failMerge=true;const again=await interrupt();const mergedHead=git(checkout,'rev-parse','HEAD');
 // A live owner of the old lock still blocks, and nothing moves.
 writeFileSync(join(oldLock,'pid 2'),String(process.pid));box.requests.length=0;
 const blocked=await run(checkout,'merge','t1','--head',head);assert.equal(blocked.status,1,blocked.output);assert.match(blocked.output,new RegExp(`pid ${process.pid}\\) is still running; its lock is `));
 assert.equal(readFileSync(oldJournal,'utf8'),again);assert.ok(!existsSync(journalFile));nothingLanded();
 // A journal in both places is refused by name; the stale lock is freed first.
 writeFileSync(join(oldLock,'pid 2'),'2147483647');mkdirSync(dirname(journalFile),{recursive:true});copyFileSync(oldJournal,journalFile);box.requests.length=0;
 const both=await run(checkout,'merge','t1','--head',head);assert.equal(both.status,1,both.output);
 assert.ok(both.output.includes(`a landing journal is in two places: ${oldJournal}, left by an earlier CLI, and ${journalFile};`),both.output);
 assert.ok(!existsSync(oldLock));assert.equal(readFileSync(oldJournal,'utf8'),again);assert.equal(readFileSync(journalFile,'utf8'),again);assert.equal(git(checkout,'rev-parse','HEAD'),mergedHead);nothingLanded();
 // With one journal left, the retry moves it and completes the landing from its commit.
 rmSync(journalFile);
 const resumed=await run(checkout,'merge','t1','--head',head);assert.equal(resumed.status,0,resumed.output);
 assert.equal(git(checkout,'rev-parse','HEAD'),mergedHead);assert.equal(git(p,'--git-dir',baseline,'rev-parse','HEAD'),mergedHead);assert.equal(box.state,'merged');
 noOldFiles();assert.ok(!existsSync(journalFile));
});

// A task whose tree holds paths that differ only by letter case or Unicode
// form. Git keeps both; a Mac's disk stores them as one file, so merging such
// a tree in the owner's checkout writes the task's text over the other.
const OWNER_TEXT='Owner instructions: never deploy.\n';
async function caseFixture(t,{files,advance,paths}){
 const p=root(t),seed=join(p,'seed'),baseline=join(p,'baseline.git'),fork=join(p,'fork.git'),checkout=join(p,'checkout'),workspace=join(p,'workspace'),config=join(p,'config');
 mkdirSync(seed);mkdirSync(config);git(seed,'init','-b','main');git(seed,'config','user.name','Fixture');git(seed,'config','user.email','fixture@example.invalid');
 for(const file of files)writeFileSync(join(seed,file),OWNER_TEXT);
 git(seed,'add','.');git(seed,'commit','-m','Initial');
 git(p,'clone','--bare',seed,baseline);git(p,'clone','--bare',baseline,fork);git(p,'clone',baseline,checkout);git(p,'clone',fork,workspace);
 for(const dir of [checkout,workspace]){git(dir,'config','user.name','Fixture');git(dir,'config','user.email','fixture@example.invalid');}
 // Another task merged after this one forked: the baseline and the checkout move on.
 if(advance){writeFileSync(join(checkout,advance),'Merged earlier.\n');git(checkout,'add','.');git(checkout,'commit','-m','Earlier task');git(checkout,'push','-q','origin','main');}
 // The agent's clone keeps both names in its index whatever its disk does, as a clone on Linux would.
 git(workspace,'config','core.ignorecase','false');git(workspace,'config','core.precomposeunicode','false');
 for(const path of paths){const blob=execFileSync('git',['hash-object','-w','--stdin'],{cwd:workspace,input:'Agent instructions: deploy on every merge.\n',encoding:'utf8'}).trim();git(workspace,'update-index','--add','--cacheinfo',`100644,${blob},${path}`);}
 git(workspace,'commit','-m','Task');git(workspace,'push','-q','origin','main');
 const head=git(workspace,'rev-parse','HEAD'),before=git(checkout,'rev-parse','HEAD'),requests=[];
 const server=createServer(async(req,res)=>{
  for await(const chunk of req);if(versionAnswer(req,res))return;requests.push(req.url);
  let answer={item:{id:'t1',title:'Fixture task',state:'accepted',owner:'codex/test',head,acceptedHead:head},policy:{checks:[],protected:[],commitIdentity:IDENTITY},acceptanceProtected:[],gate:{ready:true,outOfScope:[],blockers:[]},evidence:[],reviews:[],events:[]};
  if(req.url.endsWith('/baseline-token')||req.url.endsWith('/base-token'))answer={remote:baseline,token:'fixture',defaultBranch:'main'};
  else if(req.url.endsWith('/read-token'))answer={remote:fork,token:'fixture',head,defaultBranch:'main'};
  else if(req.method!=='GET')answer={};
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(answer));
 });
 await new Promise(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>server.close());
 const url=`http://127.0.0.1:${server.address().port}`;writeFileSync(join(config,'config.json'),JSON.stringify({server:url,owner:'owner',projects:{proj:{path:checkout,branch:'main'}}}));
 const child=spawn(process.execPath,[resolve('cli/atelier.mjs'),'merge','t1','--project','proj'],{cwd:checkout,env:{...process.env,ATELIER_CONFIG_DIR:config,ATELIER_TOKEN:'fixture',ATELIER_CACHE:join(p,'cache'),ATELIER_SERVER:url}});
 let output='';child.stdout.on('data',s=>output+=s);child.stderr.on('data',s=>output+=s);
 const status=await new Promise(ok=>child.on('close',ok));
 return {checkout,baseline,cache:join(p,'cache'),requests,status,output,before};
}

// The refusal leaves the checkout, the baseline and the ledger as they were.
function assertUntouched(r,files){
 assert.equal(r.status,1,r.output);
 assert.match(r.output,/Nothing was merged/);
 assert.equal(git(r.checkout,'rev-parse','HEAD'),r.before);
 assert.equal(git(r.checkout,'status','--porcelain','--untracked-files=all'),'');
 for(const [file,text] of Object.entries(files))assert.equal(readFileSync(join(r.checkout,file),'utf8'),text);
 assert.ok(!existsSync(join(r.checkout,'.git','MERGE_HEAD')),'MERGE_HEAD');
 assert.ok(!existsSync(landingJournalFile(landingDir(r.cache,join(r.checkout,'.git')))),'journal');
 assert.equal(git(r.checkout,'--git-dir',r.baseline,'rev-parse','main'),r.before);
 assert.ok(!r.requests.some(u=>u.endsWith('/landing')||u.endsWith('/merged')),r.requests.join(' '));
}

test('merge refuses an accepted tree holding claude.md beside CLAUDE.md and leaves the checkout as it was',async t=>{
 const r=await caseFixture(t,{files:['CLAUDE.md'],paths:['claude.md']});
 assert.match(r.output,/CLAUDE\.md and claude\.md/);
 assertUntouched(r,{'CLAUDE.md':OWNER_TEXT});
});

test('merge refuses an accepted tree holding a decomposed spelling of a precomposed name',async t=>{
 const nfc='caf\u00e9.md',nfd='cafe\u0301.md';
 const r=await caseFixture(t,{files:[nfc],paths:[nfd]});
 assert.ok(r.output.includes(`${nfd} and ${nfc}`),r.output);
 assertUntouched(r,{[nfc]:OWNER_TEXT});
});

test('merge refuses when the merge, not the accepted tree, would hold two names for one file on a Mac',async t=>{
 // The task forked before Notes.md merged, so its own tree is clean; the merge would hold both.
 const r=await caseFixture(t,{files:['CLAUDE.md'],advance:'Notes.md',paths:['notes.md']});
 assert.match(r.output,/Notes\.md and notes\.md/);
 assertUntouched(r,{'Notes.md':'Merged earlier.\n','CLAUDE.md':OWNER_TEXT});
});


test('a privacy publication reservation prevents the legacy notes push from publishing an unscanned ref',async t=>{
 for(const protectedPublication of [false,true]){
  const {p,checkout,head,box,run}=await mergeFixture(t);
  const remote=join(p,'public.git');git(p,'init','--bare',remote);
  const configPath=join(p,'config','config.json'),config=JSON.parse(readFileSync(configPath,'utf8'));
  config.projects.proj.notesRemote=remote;writeFileSync(configPath,JSON.stringify(config));
  if(protectedPublication)box.postMerge={state:'complete',policy:{steps:[{class:'publish'}]}};
  const result=await run(checkout,'merge','t1','--head',head,'--approve');
  assert.equal(result.status,0,result.output);
  const notes=git(p,'--git-dir',remote,'for-each-ref','--format=%(refname)','refs/notes/atelier');
  assert.equal(notes,protectedPublication?'':'refs/notes/atelier');
 }
});

test('provenance notes carry the project identity, and notes commits that do not are never pushed (t451)',async t=>{
 // The checkout's own Git identity is a private address; the landing's notes must not carry it.
 const {p,baseline,checkout,box,run}=await mergeFixture(t);
 git(checkout,'config','user.email','owner@personal.example');git(checkout,'config','user.name','Private Owner');
 box.state='accepted';
 const landed=await run(checkout,'merge','t1');assert.equal(landed.status,0,landed.output);
 const ids=git(p,'--git-dir',baseline,'log','refs/notes/atelier','--format=%an <%ae> %cn <%ce>').split('\n');
 assert.ok(ids.length>0&&ids.every(l=>l==='Fixture <fixture@example.invalid> Fixture <fixture@example.invalid>'),ids.join('\n'));
});

test('a landing refuses to push a local notes commit whose identity the policy refuses (t451)',async t=>{
 const {p,baseline,checkout,box,run}=await mergeFixture(t);
 // An earlier notes commit made by hand with a private address, never published.
 execFileSync('git',['-c','user.name=Private Owner','-c','user.email=owner@personal.example','notes','--ref=atelier','add','-m','hand note','HEAD'],{cwd:checkout});
 box.state='accepted';
 const refused=await run(checkout,'merge','t1');
 assert.notEqual(refused.status,0,refused.output);
 assert.match(refused.output,/provenance notes whose identity the project's policy refuses/);
 assert.match(refused.output,/owner@personal\.example/);
 assert.equal(execFileSync('git',['--git-dir',baseline,'for-each-ref','refs/notes/atelier'],{encoding:'utf8'}).trim(),'');
 assert.ok(!box.requests.some(r=>r.path.endsWith('/merged')));
});

test('notes go to a notes remote the policy declares a public mirror only under the public rule: an agent address is held back (t451)',async t=>{
 const saved={agentEmails:IDENTITY.agentEmails,publicMirrors:IDENTITY.publicMirrors};
 IDENTITY.agentEmails=['agent@example.invalid'];IDENTITY.publicMirrors=['github'];
 t.after(()=>{IDENTITY.agentEmails=saved.agentEmails;if(saved.publicMirrors===undefined)delete IDENTITY.publicMirrors;else IDENTITY.publicMirrors=saved.publicMirrors;});
 const {p,checkout,box,run}=await mergeFixture(t);
 const pub=join(p,'public.git');git(p,'init','--bare','-q',pub);git(checkout,'remote','add','github',pub);
 const configFile=join(p,'config','config.json');const cfg=JSON.parse(readFileSync(configFile,'utf8'));cfg.projects.proj.notesRemote='github';writeFileSync(configFile,JSON.stringify(cfg));
 // A notes commit an agent made: allowed on the baseline, not on a public mirror.
 execFileSync('git',['-c','user.name=Agent','-c','user.email=agent@example.invalid','notes','--ref=atelier','add','-m','agent note','HEAD'],{cwd:checkout});
 box.state='accepted';
 const landed=await run(checkout,'merge','t1');assert.equal(landed.status,0,landed.output);
 assert.match(landed.output,/Provenance notes were not pushed to github/);
 assert.match(landed.output,/agent@example\.invalid/);
 assert.equal(execFileSync('git',['--git-dir',pub,'for-each-ref','refs/notes/atelier'],{encoding:'utf8'}).trim(),'');
});

// Private files (t645): a landing puts no private file on the baseline,
// whether the task's commits carry one or the checkout's own commits do.
function namePrivate(p,paths){const file=join(p,'config','config.json');const config=JSON.parse(readFileSync(file,'utf8'));config.projects.proj.private=paths;writeFileSync(file,JSON.stringify(config));}
test('a merge refuses a task whose accepted revision touches a private file, before anything is merged',async t=>{
 const {p,checkout,baseline,box,run}=await mergeFixture(t);
 box.state='accepted';namePrivate(p,['work.txt']);
 const before=git(checkout,'rev-parse','HEAD'),baselineBefore=git(checkout,'ls-remote',baseline,'refs/heads/main');
 const r=await run(checkout,'merge','t1');
 assert.notEqual(r.status,0,r.output);
 assert.match(r.output,/t1's accepted revision would carry private files: work\.txt in [0-9a-f]{12}\..*Nothing was merged\./s);
 assert.equal(git(checkout,'rev-parse','HEAD'),before);
 assert.equal(git(checkout,'ls-remote',baseline,'refs/heads/main'),baselineBefore);
 assert.ok(!box.requests.some(r=>r.path.endsWith('/merged')));
});
test('a merge refuses to push the checkout\'s own commit holding a private file with the landing',async t=>{
 const {p,checkout,baseline,box,run}=await mergeFixture(t);
 box.state='accepted';namePrivate(p,['PROJECT.md']);
 writeFileSync(join(checkout,'PROJECT.md'),'the plan\n');git(checkout,'add','-f','PROJECT.md');git(checkout,'commit','-m','by hand');
 const baselineBefore=git(checkout,'ls-remote',baseline,'refs/heads/main');
 const r=await run(checkout,'merge','t1');
 assert.notEqual(r.status,0,r.output);
 assert.match(r.output,/The landing would carry private files: PROJECT\.md in [0-9a-f]{12}.*Nothing was pushed\./s);
 assert.equal(git(checkout,'ls-remote',baseline,'refs/heads/main'),baselineBefore);
 assert.ok(!box.requests.some(r=>r.path.endsWith('/merged')));
});
// Both reviews of t645: a task's push to its fork was not checked, so a
// private file committed in a workspace reached Artifacts before any merge.
test('a task\'s push carries no private file of the project to its fork',async t=>{
 const {p,workspace,run}=await mergeFixture(t);
 namePrivate(p,['PROJECT.md']);
 const fork=join(p,'fork.git'),before=git(p,'--git-dir',fork,'rev-parse','main');
 writeFileSync(join(workspace,'PROJECT.md'),'the plan\n');git(workspace,'add','-f','PROJECT.md');git(workspace,'commit','-m','by hand\n\nAgent: codex/test');
 const r=await run(workspace,'push','t1','--as','codex/test');
 assert.notEqual(r.status,0,r.output);
 assert.match(r.output,/t1's push to its fork would carry private files: PROJECT\.md in [0-9a-f]{12}\..*Nothing was pushed\./s);
 assert.equal(git(p,'--git-dir',fork,'rev-parse','main'),before);
});
// Astra's sixth review of t645, finding 1: after projects rename, a
// workspace made before still names the old project, and its push was
// checked against no configuration.
test('a task\'s push from a workspace that still names a renamed project is guarded',async t=>{
 const {p,workspace,run}=await mergeFixture(t);
 const file=join(p,'config','config.json'),config=JSON.parse(readFileSync(file,'utf8'));
 // As projects rename leaves it: the entry under the new name, the old one kept as a former name.
 config.projects.renamed={...config.projects.proj,private:['PROJECT.md'],formerNames:['proj']};delete config.projects.proj;
 writeFileSync(file,JSON.stringify(config));
 const fork=join(p,'fork.git'),before=git(p,'--git-dir',fork,'rev-parse','main');
 writeFileSync(join(workspace,'PROJECT.md'),'the plan\n');git(workspace,'add','-f','PROJECT.md');git(workspace,'commit','-m','by hand\n\nAgent: codex/test');
 const r=await run(workspace,'push','t1','--as','codex/test');
 assert.notEqual(r.status,0,r.output);
 assert.match(r.output,/t1's push to its fork would carry private files: PROJECT\.md/);
 assert.equal(git(p,'--git-dir',fork,'rev-parse','main'),before);
});
