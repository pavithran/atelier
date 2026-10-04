import {expect,it} from 'vitest';
import {renderInbox,renderItem,renderProject,renderHistory,type Detail} from '../src/ui';
import type {ProjectRecord} from '../src/ledger';
const head='a'.repeat(40),time='2026-10-03T12:00:00Z';
const project:ProjectRecord={name:'example',repo:'example',policy:{checks:['npm test'],protected:['src/**']},createdAt:time};
function detail():Detail{return{ownerActor:'pavi',item:{id:'t1',title:'<script>unsafe title</script>',state:'submitted',owner:'codex/gpt-6',scope:['src/**'],fork:'example--t1',base:'b'.repeat(40),head,acceptedHead:null,lastPushAt:time,updatedAt:time,createdAt:time},policy:project.policy,evidence:[{itemId:'t1',claim:'npm test',grade:'observed',head,passed:true,by:'codex/gpt-6',at:time,changedPaths:['src/a.ts']}],reviews:[],gate:{ready:false,needsAssessor:true,blockers:['Protected'],outOfScope:[]},events:[]};}
it('review puts revision-bound actions before the diff and escapes untrusted task text',()=>{
 const html=renderItem(project,detail(),'PAVI',{head,base:'b'.repeat(40),files:[],truncated:false});
 expect(html).toContain('&lt;script&gt;unsafe title&lt;/script&gt;');expect(html).not.toContain('<script>unsafe');
 expect(html).toContain(`name="head" value="${head}"`);
 expect(html.indexOf('Approve revision')).toBeLessThan(html.indexOf('id="changes"'));
 expect(html).toContain('name="note" required');
});
it('merged tasks show completion without actionable approval or a misleading closed gate',()=>{
 const d=detail();d.item.state='merged';d.item.acceptedHead=head;
 const html=renderItem(project,d,'PAVI',null);
 expect(html).toContain('Merged into the project');expect(html).not.toContain('Approve revision');expect(html).not.toContain('Readiness details');expect(html).not.toContain('Close task without merging');
});
it('acceptance renders only after current owner approval and passing evidence',()=>{
 const d=detail();d.reviews=[{itemId:'t1',head,approve:true,by:'pavi',note:'approved',at:time}];
 expect(renderItem(project,d,'PAVI',{head,base:'b'.repeat(40),files:[],truncated:false})).toContain('Accept revision');
 d.evidence[0].passed=false;expect(renderItem(project,d,'PAVI',{head,base:'b'.repeat(40),files:[],truncated:false})).not.toContain('Accept revision');
});
it('empty decisions, history, project creation and unavailable projects remain actionable',()=>{
 expect(renderInbox([],[])).toContain('Bring your first project');
 expect(renderInbox([], [project], 'PAVI', undefined, [{project,items:[],unavailable:true}])).toContain('list may be incomplete');
 expect(renderProject(project,[],[])).toContain('What should change?');
 expect(renderHistory([{project,items:[]}])).toContain('Completed tasks will appear here');
});

it('approval and acceptance require visible changes at the recorded revision',()=>{
 const d=detail();
 for(const diff of ['unavailable' as const,null,{head:'c'.repeat(40),base:'b'.repeat(40),files:[],truncated:false}]){
  const html=renderItem(project,d,'PAVI',diff);
  expect(html).not.toContain('Approve revision');expect(html).toContain('Reload this task');
  d.reviews=[{itemId:'t1',head,approve:true,by:'pavi',note:'approved',at:time}];
  expect(renderItem(project,d,'PAVI',diff)).not.toContain('Accept revision');
 }
});

it('the dispatch and withdraw forms carry the revision, as every other form does', () => {
  const d = detail();
  d.item.state = 'open'; d.item.owner = null;
  const send = renderItem(project, d, 'PAVI', null);
  const sendForm = send.slice(send.indexOf('action="/ui/example/t1/dispatch"'));
  expect(sendForm.slice(0, 200)).toContain(`name="head" value="${head}"`);
  d.item.dispatch = { to: 'home', agent: null, model: null, by: 'pavi', at: time, note: '' };
  const wait = renderItem(project, d, 'PAVI', null);
  const withdraw = wait.slice(wait.indexOf('action="/ui/example/t1/undispatch"'));
  expect(withdraw.slice(0, 200)).toContain(`name="head" value="${head}"`);
});

// ── flow ──
import {env} from 'cloudflare:workers';
import worker from '../src/index.ts';
import {renderFlow} from '../src/ui';
import {buildStory} from '../src/graph';
const ev=(seq:number,itemId:string,actor:string,kind:string,data:Record<string,unknown>={})=>({seq,itemId,at:`2026-10-04T10:0${seq}:00.000Z`,actor,kind,data});
const story=()=>buildStory('example',[{...detail().item,id:'t1',state:'merged'}],[
 ev(1,'t1','codex/gpt-6','item.claimed'),ev(2,'t1','claude-code/opus-5.5','review.rejected',{note:'<img src=x>'}),
 ev(3,'t1','pavi','item.accepted'),ev(4,'t1','pavi','item.merged',{mergeCommit:'c'.repeat(40)})].reverse(),'pavi');
it('the flow tells who did what, escapes what agents wrote, and links each task',()=>{
 const s=story();
 const html=renderFlow([s],s.tally,'pavi','PAVI');
 expect(html).toContain('You made 1 decision.');
 expect(html).toContain('2 agents did the other 2 moves, and sent work back 1 time.');
 expect(html).toContain('href="/p/example/t1"');
 expect(html).not.toContain('<img src=x>');
 expect(html).toContain('data-theme="night"');
});
it('decisions at rest show the latest graph, and the old resting sheet when there is none',()=>{
 const s=story();
 expect(renderInbox([],[project],'PAVI',undefined,[],undefined,new Date(),[],{story:s,owner:'pavi'})).toContain('See the whole flow');
 expect(renderInbox([],[project],'PAVI')).toContain('Space to focus.');
});
it('the flow route is served behind sign-in, under a policy that allows only the fonts',async()=>{
 const TOKEN='flow-test-token';
 const testEnv={...env,ATELIER_TOKEN:TOKEN} as typeof env;
 const hex=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(TOKEN)))].map(b=>b.toString(16).padStart(2,'0')).join('');
 const out=await worker.fetch(new Request('https://atelier.test/flow',{redirect:'manual'}),testEnv);
 expect(out.status).not.toBe(200);
 const res=await worker.fetch(new Request('https://atelier.test/flow',{headers:{cookie:`atelier=${hex}`}}),testEnv);
 expect(res.status).toBe(200);
 expect(await res.text()).toContain('<title>Flow · Atelier</title>');
 const csp=res.headers.get('content-security-policy')!;
 expect(csp).toContain("default-src 'none'");
 expect(csp).toContain('font-src https://fonts.gstatic.com');
 expect(csp).not.toContain('script-src');
});

// ── project titles ──
import {cleanTitle,titleOf,renderProjects,renderStudio} from '../src/ui';
it('a project title is one clean line, and the name stands in when there is none',()=>{
 expect(cleanTitle('  Atelier ')).toBe('Atelier');
 expect(cleanTitle('A\ntwo\u0007line')).toBe('A two line');
 expect(cleanTitle('x'.repeat(200))).toHaveLength(80);
 expect(cleanTitle('')).toBeUndefined();
 expect(cleanTitle(undefined)).toBeUndefined();
 expect(titleOf({name:'cloudflare-git'})).toBe('cloudflare-git');
 expect(titleOf({name:'cloudflare-git',title:'Atelier'})).toBe('Atelier');
});
it('pages call a project by its title and link it by its name',()=>{
 const titled={...project,name:'cloudflare-git',title:'<Atelier>'};
 const list=renderProjects([{project:titled,items:[]}]);
 expect(list).toContain('&lt;Atelier&gt;');
 expect(list).toContain('href="/p/cloudflare-git"');
 const page=renderProject(titled,[],[]);
 expect(page).toContain('<h1>&lt;Atelier&gt;</h1>');
 expect(page).toContain('action="/ui/cloudflare-git/new"');
 const s=buildStory('cloudflare-git',[],[],'pavi',false,'Atelier');
 expect(s.title).toBe('Atelier');
 expect(renderStudio({benches:[],from:time,to:time},'PAVI',new Date(time),false,[titled])).toContain('Studio');
});

// ── browsing ──
import {renderTree,renderBlob,renderCommit,renderLog,codeHref} from '../src/browse/view';
it('browsing pages escape names and contents and keep links inside the repository',()=>{
 const head={hash:'a'.repeat(40),treeHash:'b'.repeat(40),message:'<b>Subject</b>\nbody',author:{name:'<A>',email:'a@x'},parents:['c'.repeat(40)],authoredAt:1759600000};
 const w={project,item:'t1',at:null};
 const tree=renderTree(w,head,['src'],{kind:'tree',hash:'d'.repeat(40),entries:[{name:'<x>.ts',type:'blob',mode:'100644',hash:'e'.repeat(40)},{name:'lib',type:'tree',mode:'40000',hash:'f'.repeat(40)},{name:'run.sh',type:'exec',mode:'100755',hash:'1'.repeat(40)}],total:3});
 expect(tree).toContain('href="/p/example/t1/code/src/run.sh"');
 expect(tree).toContain('&lt;x&gt;.ts');
 expect(tree).toContain('href="/p/example/t1/code/src/%3Cx%3E.ts"');
 expect(tree).toContain('href="/p/example/t1/code/src/lib"');
 expect(tree).not.toContain('<b>Subject</b>');
 const blob=renderBlob(w,head,['src','a.ts'],{kind:'text',lines:['<script>alert(1)</script>'],bytes:26});
 expect(blob).toContain('&lt;script&gt;');
 expect(blob).toContain('href="/p/example/t1/history/src/a.ts"');
 expect(renderCommit(w,{commit:head,parent:'c'.repeat(40),files:[],truncated:false})).toContain('href="/p/example/t1/commit/'+'c'.repeat(40)+'"');
 expect(renderLog({project,item:null,at:null},head,[head],1,true)).toContain('href="/p/example/log?page=2"');
 expect(codeHref({project,item:null,at:'a'.repeat(40)},['a b'])).toBe('/p/example/code/a%20b?at='+'a'.repeat(40));
});

it('browsing routes read only the baseline or that task fork, and say plainly what is missing',async()=>{
 const {env}=await import('cloudflare:workers');
 const {default:worker}=await import('../src/index');
 const TOKEN='browse-test-token';
 const hex=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(TOKEN)))].map(b=>b.toString(16).padStart(2,'0')).join('');
 const record={name:'browsed',repo:'browsed',policy:{checks:[],protected:[]},createdAt:time};
 const L=env.LEDGER.get(env.LEDGER.idFromName('project:browsed'));
 await L.setProject(record,'owner');
 await env.LEDGER.get(env.LEDGER.idFromName('__index')).registerProject(record);
 await L.newItem('Work',[],'owner');await L.claim('t1','codex/gpt-6');await L.setFork('t1','browsed--t1','0'.repeat(40),'codex/gpt-6');
 const C='c'.repeat(40),T='d'.repeat(40),B='b'.repeat(40),X='e'.repeat(40);
 const asked:string[]=[];
 const repo=(name:string)=>({
  log:async({ref}:{ref?:string})=>ref&&ref!=='HEAD'&&ref!==C?[]:[{hash:C,treeHash:T,message:`On ${name}`,author:{name:'A',email:'a@x'},committer:{name:'A',email:'a@x'},parents:[],authoredAt:1,committedAt:1}],
  readCommit:async()=>null,
  readTree:async(h:string)=>h===T?[{name:'README.md',mode:'100644',hash:B,type:'blob'},{name:'run.sh',mode:'100755',hash:X,type:'exec'}]:null,
  readBlob:async(h:string)=>h===B?new Blob(['hello\n']):h===X?new Blob(['#!/bin/sh\n']):null,
  [Symbol.dispose](){},
 });
 const ARTIFACTS={get:async(name:string)=>{asked.push(name);return repo(name)}} as unknown as Artifacts;
 const bindings={...env,ARTIFACTS,ATELIER_TOKEN:TOKEN} as typeof env;
 const get=(path:string,signed=true)=>worker.fetch(new Request(`https://atelier.test${path}`,{headers:signed?{cookie:`atelier=${hex}`}:{},redirect:'manual'}),bindings);
 expect((await get('/p/browsed/code',false)).status).toBe(303);
 const base=await get('/p/browsed/code');
 expect(base.status).toBe(200);
 expect(await base.text()).toContain('On browsed');
 const fork=await get('/p/browsed/t1/code/run.sh');
 expect(fork.status).toBe(200);
 expect(await fork.text()).toContain('#!/bin/sh');
 expect(asked).toEqual(['browsed','browsed--t1']);
 const missing=await get(`/p/browsed/code?at=${'f'.repeat(40)}`);
 expect(missing.status).toBe(404);
 expect(await missing.text()).toContain('That commit is not in this repository');
 expect((await get('/p/browsed/code/%2E%2E/x')).status).toBe(404);
 expect((await get('/p/browsed/t1')).status).toBe(200);
});
