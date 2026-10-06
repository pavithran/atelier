import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync,readFileSync,readdirSync,symlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {landingDir,landingJournal,landingJournalFile,landingLock} from '../cli/landing.mjs';
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();

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

test('merge --head resumes after ledger failure without a second merge; finish stops on failed checks',async t=>{
 const p=root(t),seed=join(p,'seed'),baseline=join(p,'baseline.git'),fork=join(p,'fork.git'),checkout=join(p,'checkout'),workspace=join(p,'workspace'),config=join(p,'config');
 mkdirSync(seed);mkdirSync(config);git(seed,'init','-b','main');git(seed,'config','user.name','Fixture');git(seed,'config','user.email','fixture@example.invalid');writeFileSync(join(seed,'work.txt'),'base\n');git(seed,'add','.');git(seed,'commit','-m','Initial');
 git(p,'clone','--bare',seed,baseline);git(p,'clone','--bare',baseline,fork);git(p,'clone',baseline,checkout);git(p,'clone',fork,workspace);
 for(const dir of [checkout,workspace]){git(dir,'config','user.name','Fixture');git(dir,'config','user.email','fixture@example.invalid');}
 for(const [key,value] of Object.entries({project:'proj',item:'t1',actor:'codex/test',branch:'main'}))git(workspace,'config',`atelier.${key}`,value);
 writeFileSync(join(workspace,'work.txt'),'changed\n');git(workspace,'add','.');git(workspace,'commit','-m','Task');git(workspace,'push','origin','main');
 const head=git(workspace,'rev-parse','HEAD');let state='submitted',failMerge=true,failChecks=false;const requests=[];
 const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{};requests.push({path:req.url,body});
  const item={id:'t1',title:'Fixture task',state,owner:'codex/test',head,acceptedHead:state==='accepted'||state==='merged'?head:null};
  let answer={item,policy:{checks:[failChecks?'exit 9':'exit 0'],protected:[]},gate:{ready:true,outOfScope:[],blockers:[]},evidence:[],reviews:[],events:[]};
  if(req.url.endsWith('/review'))assert.equal(body.head,head);
  else if(req.url.endsWith('/accept')){assert.equal(body.head,head);state='accepted';answer={...item,state,acceptedHead:head};}
  else if(req.url.endsWith('/baseline-token'))answer={remote:baseline,token:'fixture',defaultBranch:'main'};
  else if(req.url.endsWith('/read-token'))answer={remote:fork,token:'fixture',head,defaultBranch:'main'};
  else if(req.url.endsWith('/merged')){
   if(failMerge){failMerge=false;res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'temporary',detail:'retry'}));return;}
   state='merged';answer={...item,state};
  }else if(req.url.endsWith('/push'))answer={...item,head};
  else if(req.url.endsWith('/submit')){state='submitted';answer={...item,state};}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(answer));
 });
 await new Promise(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>server.close());
 const url=`http://127.0.0.1:${server.address().port}`;writeFileSync(join(config,'config.json'),JSON.stringify({server:url,owner:'owner',projects:{proj:{path:checkout,branch:'main'}}}));
 async function run(cwd,...args){const child=spawn(process.execPath,[resolve('cli/atelier.mjs'),...args,'--project','proj'],{cwd,env:{...process.env,ATELIER_CONFIG_DIR:config,ATELIER_TOKEN:'fixture',ATELIER_CACHE:join(p,'cache'),ATELIER_SERVER:url}});let output='';child.stdout.on('data',s=>output+=s);child.stderr.on('data',s=>output+=s);const status=await new Promise(ok=>child.on('close',ok));return{status,output};}
 // The ledger's temporary failure is a server error: exit 4, the merge journal kept for the retry.
 const first=await run(checkout,'merge','t1','--head',head,'--approve');assert.equal(first.status,4,first.output);const mergedHead=git(checkout,'rev-parse','HEAD');assert.notEqual(mergedHead,head);const journalFile=landingJournalFile(landingDir(join(p,'cache'),join(checkout,'.git')));assert.ok(existsSync(journalFile));
 // Simulate another baseline commit before retrying the failed ledger acknowledgment.
 const next=join(p,'next');git(p,'clone',baseline,next);git(next,'config','user.name','Fixture');git(next,'config','user.email','fixture@example.invalid');
 writeFileSync(join(next,'later.txt'),'later work\n');git(next,'add','.');git(next,'commit','-m','Later work');git(next,'push','origin','main');
 const advanced=git(next,'rev-parse','HEAD');
 // Also simulate a partial ref publication: the baseline arrived but its notes did not.
 git(p,'--git-dir',baseline,'update-ref','-d','refs/notes/atelier');
 const second=await run(checkout,'merge','t1','--head',head);assert.equal(second.status,0,second.output);assert.equal(git(checkout,'rev-parse','HEAD'),mergedHead);assert.equal(git(p,'--git-dir',baseline,'rev-parse','HEAD'),advanced);assert.match(git(p,'--git-dir',baseline,'notes','--ref=atelier','show',mergedHead),/accepted head/);assert.equal(state,'merged');assert.ok(!existsSync(journalFile));
 state='claimed';failChecks=true;requests.length=0;const failed=await run(workspace,'finish');assert.equal(failed.status,2,failed.output);assert.ok(!requests.some(r=>r.path.endsWith('/submit')));
 failChecks=false;const finished=await run(workspace,'finish');assert.equal(finished.status,0,finished.output);assert.equal(state,'submitted');
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
  for await(const chunk of req);requests.push(req.url);
  let answer={item:{id:'t1',title:'Fixture task',state:'accepted',owner:'codex/test',head,acceptedHead:head},policy:{checks:[],protected:[]},acceptanceProtected:[],gate:{ready:true,outOfScope:[],blockers:[]},evidence:[],reviews:[],events:[]};
  if(req.url.endsWith('/baseline-token'))answer={remote:baseline,token:'fixture',defaultBranch:'main'};
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
