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

// ── showcase ──
import {renderShowcase} from '../src/ui';
it('the showcase is read only: no forms, no links into signed-in pages, and no notes',()=>{
 const s=buildStory('example',[{...detail().item,id:'t1',state:'merged'}],[
  ev(1,'t1','codex/gpt-6','item.claimed'),ev(2,'t1','claude-code/opus-5.5','review.rejected',{note:'secret reviewer note'}),
  ev(3,'t1','pavi','item.accepted'),ev(4,'t1','pavi','item.merged',{mergeCommit:'c'.repeat(40)})].reverse(),'pavi',false,'Example',{redact:true,ownerLabel:'PAVI'});
 const html=renderShowcase([s],s.tally,'pavi','PAVI');
 expect(html).toContain('PAVI made 1 decision.');
 expect(html).toContain('PAVI&#39;s decisions');
 expect(html).not.toContain('your decisions');
 expect(html).not.toMatch(/· you</);
 expect(html).not.toContain('<form');
 expect(html).not.toContain('href="/p/');
 expect(html).not.toContain('secret reviewer note');
 expect(html).not.toContain('class="rail"');
 expect(html).toContain('https://github.com/pavithran/atelier');
});
it('the showcase route is public only when the owner names projects, and caches briefly',async()=>{
 const none=await worker.fetch(new Request('https://atelier.test/showcase'),{...env} as typeof env);
 expect(none.status).toBe(404);
 const record={name:'shown',repo:'shown',title:'Shown project',policy:{checks:[],protected:[]},createdAt:time};
 await env.LEDGER.get(env.LEDGER.idFromName('project:shown')).setProject(record,'owner');
 const res=await worker.fetch(new Request('https://atelier.test/showcase'),{...env,SHOWCASE:'shown, missing'} as typeof env);
 expect(res.status).toBe(200);
 expect(res.headers.get('cache-control')).toBe('public, max-age=60');
 expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
 const body=await res.text();
 expect(body).toContain('Atelier · public showcase');
 expect(body).toContain('could not be read just now');
 // A second request inside the minute is the cached copy, whatever its query.
 const again=await worker.fetch(new Request('https://atelier.test/showcase?replay=x'),{...env,SHOWCASE:'shown'} as typeof env);
 expect(await again.text()).toBe(body);
 await caches.default.delete(new Request('https://atelier.test/showcase'));
 const only=await worker.fetch(new Request('https://atelier.test/showcase'),{...env,SHOWCASE:'shown'} as typeof env);
 expect(await only.text()).not.toContain('could not be read just now');
 const login=await worker.fetch(new Request('https://atelier.test/login'),{...env,SHOWCASE:'shown'} as typeof env);
 expect(await login.text()).toContain('href="/showcase"');
});

it('the Models page lists the pool by where it runs, escapes it, and adds through a same-origin form',async()=>{
 const {renderModels}=await import('../src/ui');
 const html=renderModels([
  {id:'GLM-5.3-Flash-4_8bit',harness:'opencode',where:'home',provider:'ai-studio',aliases:[],family:'zai',note:'<b>local</b>',addedBy:'pavi',addedAt:time,status:{state:'available',at:time}},
  {id:'mystery-1',harness:'codex',where:'cloud',provider:'subscription',aliases:[],family:'other',note:'',addedBy:'pavi',addedAt:time},
 ],new Map([['opencode/GLM-5.3-Flash-4_8bit',{itemsClaimed:2,checkPasses:3,checkFailures:0,reviewsApproved:0,reviewsRejected:1,handoffsAway:0,merges:2}]]),'PAVI');
 expect(html).toContain('At home · 1');
 expect(html).toContain('In the cloud · 1');
 expect(html).toContain('&lt;b&gt;local&lt;/b&gt;');
 expect(html).toContain('Took 2 tasks, merged 2');
 expect(html).toContain('family not recognised');
 expect(html).toContain('action="/models/add"');
 const TOKEN='models-page-token';
 const hex=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(TOKEN)))].map(b=>b.toString(16).padStart(2,'0')).join('');
 const post=(origin:string,form:Record<string,string>)=>worker.fetch(new Request('https://atelier.test/models/add',{method:'POST',headers:{cookie:`atelier=${hex}`,origin},body:new URLSearchParams(form),redirect:'manual'}),{...env,ATELIER_TOKEN:TOKEN} as typeof env);
 expect((await post('https://evil.test',{id:'x',harness:'codex',where:'cloud'})).status).toBe(403);
 expect((await post('https://atelier.test',{id:'deepseek-chat',harness:'opencode',where:'cloud',provider:'deepseek',keychain:'deepseek.API_KEY'})).status).toBe(303);
 const bad=await post('https://atelier.test',{id:'x',harness:'opencode',where:'cloud',endpoint:'https://u:p@x.test'});
 expect(bad.status).toBe(400);
 expect(await bad.text()).toContain('must not carry a user name or password');
 const page=await worker.fetch(new Request('https://atelier.test/models',{headers:{cookie:`atelier=${hex}`}}),{...env,ATELIER_TOKEN:TOKEN} as typeof env);
 expect(await page.text()).toContain('deepseek-chat');
});
