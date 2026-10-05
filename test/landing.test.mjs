import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {landingJournal,landingLock} from '../cli/landing.mjs';
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();

function root(t){const p=mkdtempSync(join(tmpdir(),'atelier-land-'));t.after(()=>rmSync(p,{recursive:true,force:true}));return p;}
test('landing journals survive restarts and refuse another revision or live lock',t=>{
 const p=root(t),identity={project:'p',item:'t1',head:'a'.repeat(40)};
 const journal=landingJournal(p,identity);journal.save({phase:'prepared',start:'base'});
 assert.equal(landingJournal(p,identity).state.phase,'prepared');assert.throws(()=>landingJournal(p,{...identity,head:'b'}),/pending landing/);
 const release=landingLock(p);assert.throws(()=>landingLock(p),/still running/);release();journal.clear();assert.equal(landingJournal(p,identity).state,null);
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
 const first=await run(checkout,'merge','t1','--head',head,'--approve');assert.equal(first.status,4,first.output);const mergedHead=git(checkout,'rev-parse','HEAD');assert.notEqual(mergedHead,head);assert.ok(existsSync(join(checkout,'.git','atelier-landing.json')));
 // Simulate another baseline commit before retrying the failed ledger acknowledgment.
 const next=join(p,'next');git(p,'clone',baseline,next);git(next,'config','user.name','Fixture');git(next,'config','user.email','fixture@example.invalid');
 writeFileSync(join(next,'later.txt'),'later work\n');git(next,'add','.');git(next,'commit','-m','Later work');git(next,'push','origin','main');
 const advanced=git(next,'rev-parse','HEAD');
 // Also simulate a partial ref publication: the baseline arrived but its notes did not.
 git(p,'--git-dir',baseline,'update-ref','-d','refs/notes/atelier');
 const second=await run(checkout,'merge','t1','--head',head);assert.equal(second.status,0,second.output);assert.equal(git(checkout,'rev-parse','HEAD'),mergedHead);assert.equal(git(p,'--git-dir',baseline,'rev-parse','HEAD'),advanced);assert.match(git(p,'--git-dir',baseline,'notes','--ref=atelier','show',mergedHead),/accepted head/);assert.equal(state,'merged');assert.ok(!existsSync(join(checkout,'.git','atelier-landing.json')));
 state='claimed';failChecks=true;requests.length=0;const failed=await run(workspace,'finish');assert.equal(failed.status,2,failed.output);assert.ok(!requests.some(r=>r.path.endsWith('/submit')));
 failChecks=false;const finished=await run(workspace,'finish');assert.equal(finished.status,0,finished.output);assert.equal(state,'submitted');
});
