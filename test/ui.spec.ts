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

// ── decision brief ──
it('the brief renders above the diff, escapes a hostile summary, and tags the verdict',()=>{
 const d=detail();
 d.evidence[0].where='sandbox';
 d.reviews=[{itemId:'t1',head,approve:true,by:'claude-code/opus-5.5',note:'',at:time}];
 d.gate={ready:true,needsAssessor:false,blockers:[],outOfScope:[]};
 d.events=[{seq:1,itemId:'t1',at:time,actor:'codex/gpt-6',kind:'item.submitted',data:{head,summary:'<img src=x onerror=alert(1)> done'}}];
 const html=renderItem(project,d,'PAVI',{head,base:'b'.repeat(40),files:[],truncated:false});
 expect(html).toContain('Accept t1 at aaaaaaaa: &lt;script&gt;unsafe title&lt;/script&gt;.');
 expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; done');
 expect(html).not.toContain('<img src=x');
 expect(html).toContain('Summary from codex/gpt-6');
 // A summary by another actor at an older head is not shown for this one.
 d.events=[{seq:2,itemId:'t1',at:time,actor:'codex/gpt-6',kind:'item.submitted',data:{head,summary:'current words'}},
  {seq:1,itemId:'t1',at:time,actor:'someone/else',kind:'item.submitted',data:{head:'c'.repeat(40),summary:'stale words'}}];
 const briefOf=(h:string)=>h.slice(h.indexOf('id="brief"'),h.indexOf('id="changes"'));
 const other=briefOf(renderItem(project,d,'PAVI',null));
 expect(other).toContain('current words');expect(other).toContain('Summary from codex/gpt-6');
 expect(other).not.toContain('stale words');expect(other).not.toContain('someone/else');
 d.events=[{seq:1,itemId:'t1',at:time,actor:'someone/else',kind:'item.submitted',data:{head:'c'.repeat(40),summary:'stale words'}}];
 const none=briefOf(renderItem(project,d,'PAVI',null));
 expect(none).not.toContain('stale words');expect(none).not.toContain('Summary from');
 expect(html).toContain('1 passed in a Cloudflare container');
 expect(html).toContain('<span class="tag go">accept</span>');
 expect(html.indexOf('Decision brief')).toBeLessThan(html.indexOf('id="changes"'));
});
it('the brief tags a rejected revision as send back and a pending one as wait',()=>{
 const d=detail();
 d.evidence[0].passed=false;
 const sent=renderItem(project,d,'PAVI',null);
 expect(sent).toContain('<span class="tag bad">send back</span>');expect(sent).toContain('Send t1 back at aaaaaaaa');
 const w=detail();w.evidence=[];w.gate={ready:false,needsAssessor:false,blockers:[],outOfScope:[]};w.item.scope=[];
 w.events=[{seq:1,itemId:'t1',at:time,actor:'codex/gpt-6',kind:'item.submitted',data:{head:'c'.repeat(40),summary:'older revision'}}];
 const html=renderItem(project,w,'PAVI',null);
 const brief=html.slice(html.indexOf('id="brief"'),html.indexOf('id="changes"'));
 expect(brief).toContain('<span class="tag ask">wait</span>');
 expect(brief).toContain('Wait on t1 at aaaaaaaa');
 expect(brief).not.toContain('older revision');
});
it('a project with no required checks says so instead of counting zero of zero',()=>{
 const d=detail();d.policy={checks:[],protected:[]};d.evidence=[];
 const html=renderItem(project,d,'PAVI',null);
 expect(html).toContain('This project requires no checks.');expect(html).not.toContain('0 of 0');
});
it('banner, brief heading and tag name one ask for a protected revision with a rejection',()=>{
 const d=detail();d.reviews=[{itemId:'t1',head,approve:false,by:'claude-code/opus-5.5',note:'no',at:time}];
 const html=renderItem(project,d,'PAVI',null);
 const brief=html.slice(html.indexOf('id="brief"'),html.indexOf('id="changes"'));
 expect(html).toContain('Your review is needed');expect(brief).toContain('Review t1 at aaaaaaaa');expect(brief).toContain('<span class="tag ask">review</span>');
});
it('a claimed task shows the same ask in its banner and its brief',()=>{
 const brief=(h:string)=>h.slice(h.indexOf('id="brief"'),h.indexOf('id="changes"'));
 const failing=detail();failing.item.state='claimed';failing.evidence[0].passed=false;
 const f=renderItem(project,failing,'PAVI',null);
 expect(f).toContain('Checks need attention');expect(brief(f)).toContain('Send t1 back');expect(brief(f)).toContain('<span class="tag bad">send back</span>');
 const rejected=detail();rejected.item.state='claimed';rejected.reviews=[{itemId:'t1',head,approve:false,by:'codex/gpt-5.5',note:'no',at:time}];
 const r=renderItem(project,rejected,'PAVI',null);
 expect(r).toContain('Changes requested');expect(brief(r)).toContain('Send t1 back');expect(brief(r)).not.toContain('not been submitted');
 const idle=detail();idle.item.state='claimed';
 const i=renderItem(project,idle,'PAVI',null);
 expect(brief(i)).toContain('Wait on t1');expect(brief(i)).toContain('in progress');
});
it('a project with no checks says so once',()=>{
 const d=detail();d.policy={checks:[],protected:[]};d.evidence=[];
 const html=renderItem(project,d,'PAVI',null);
 expect(html).toContain('This project requires no checks.');expect(html).not.toContain('No required checks are configured');
});
it('a protected revision awaiting an assessor shows a review tag under a review heading',()=>{
 const html=renderItem(project,detail(),'PAVI',null);
 const brief=html.slice(html.indexOf('id="brief"'),html.indexOf('id="changes"'));
 expect(brief).toContain('<span class="tag ask">review</span>');
 expect(brief).toContain('Review t1 at aaaaaaaa');
});
