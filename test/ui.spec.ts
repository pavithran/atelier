import {expect,it} from 'vitest';
import { NO_CRITERIA } from "../src/criteria.ts";
import {renderInbox,renderItem,renderProject,renderProjectTasks,renderProjectSettings,renderProjectFlow,renderProjectShip,renderHome,renderHistory,renderProjectPlans,renderModels,renderError,type Detail} from '../src/ui';
import {buildFloor} from '../src/floor';
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
it('acceptance renders only after an independent approval and passing evidence; the owner\'s approval leaves the override instead',()=>{
 const diff={head,base:'b'.repeat(40),files:[],truncated:false};
 const d=detail();d.reviews=[{itemId:'t1',head,criteria:NO_CRITERIA,approve:true,by:'pavi',note:'approved',at:time}];
 const own=renderItem(project,d,'PAVI',diff);
 expect(own).not.toContain('Accept revision');expect(own).toContain('Waiting for an independent review');expect(own).toContain('Your own approval does not count as that review.');
 expect(own).toContain('Accept without an independent review');expect(own).toContain('action="/ui/example/t1/override"');expect(own).toContain('<textarea name="note" required rows="3" maxlength="500">');
 d.reviews.push({itemId:'t1',head,criteria:NO_CRITERIA,approve:true,by:'claude-code/opus-5.5',note:'another family',at:time});d.gate={ready:true,needsAssessor:false,blockers:[],outOfScope:[]};
 const independent=renderItem(project,d,'PAVI',diff);
 expect(independent).toContain('Accept revision');expect(independent).not.toContain('Accept without an independent review');
 d.evidence[0].passed=false;expect(renderItem(project,d,'PAVI',diff)).not.toContain('Accept revision');
});
it('while the gate waits for the independent review, asking a reviewer is the primary action and the owner\'s Approve is secondary',()=>{
  const diff={head,base:'b'.repeat(40),files:[],truncated:false};
  const html=renderItem(project,detail(),'PAVI',diff);
  // The owner's approval cannot satisfy the gate, so its button is not the primary one.
  expect(html).not.toContain('<button class="primary">Approve revision</button>');
  expect(html).toContain('<button>Approve revision</button>');
  // The primary action is the move that settles it: the landing that requests the review and waits, above the diff.
  expect(html).toContain('ask a model of another family to review the revision');
  expect(html).toContain('atelier land t1 --project');
  expect(html.indexOf('atelier land t1')).toBeLessThan(html.indexOf('id="changes"'));
  // The override stays available for when no reviewer qualifies.
  expect(html).toContain('Accept without an independent review');
});
it('where the owner\'s approval counts, Approve stays the primary action and no landing is asked for',()=>{
  const diff={head,base:'b'.repeat(40),files:[],truncated:false};
  const d=detail();
  // A revision outside the protected paths, sent back by the owner's own review: approving it is the owner's move.
  d.gate={ready:false,needsAssessor:false,blockers:['rejected by pavi: tighten'],outOfScope:[]};
  d.reviews=[{itemId:'t1',head,criteria:NO_CRITERIA,approve:false,by:'pavi',note:'tighten',at:time}];
  d.evidence[0].changedPaths=['docs/a.md'];
  const html=renderItem(project,d,'PAVI',diff);
  expect(html).toContain('<button class="primary">Approve revision</button>');
  expect(html).not.toContain('atelier land t1');
});
 it('the owner\'s override is shown with its reason, apart from the reviews, and only at its head',()=>{
  const diff={head,base:'b'.repeat(40),files:[],truncated:false};
  const reviewOverride={head,by:'pavi',reason:'No <b>other</b> family is available',at:time};
  const d=detail();d.item.reviewOverride=reviewOverride;d.gate={ready:true,needsAssessor:false,blockers:[],outOfScope:[],overridden:reviewOverride};
  const html=renderItem(project,d,'PAVI',diff);
  expect(html).toContain('Review overridden');expect(html).toContain('No &lt;b&gt;other&lt;/b&gt; family is available');expect(html).toContain("the project owner's override, not a review");
  // The brief says it once; the header's description is not drawn beside that brief (finding 7).
  expect(html).toContain('The project owner overrode the independent review at this revision: No &lt;b&gt;other&lt;/b&gt; family is available.');expect(html).toContain('Accept revision');
  d.item.state='accepted';d.item.acceptedHead=head;
  expect(renderItem(project,d,'PAVI',diff)).toContain('The project owner overrode the independent review at this revision: No &lt;b&gt;other&lt;/b&gt; family is available.');
  const moved=detail();moved.item.reviewOverride={...reviewOverride,head:'c'.repeat(40)};
  expect(renderItem(project,moved,'PAVI',diff)).not.toContain('Review overridden');
 });
it('an accepted revision offers its re-acceptance under the current policy, which a merge refused after a policy change asks for',()=>{
 const diff={head,base:'b'.repeat(40),files:[],truncated:false};
 const d=detail();d.item.state='accepted';d.item.acceptedHead=head;d.gate={ready:true,needsAssessor:false,blockers:[],outOfScope:[]};
 const html=renderItem(project,d,'PAVI',diff);
 expect(html).toContain('Accept this revision again');expect(html).toContain('action="/ui/example/t1/accept"');expect(html).toContain(`name="head" value="${head}"`);
 expect(html).toContain('atelier merge t1');
 // Not without the changes at the recorded revision, and not for a revision that is not the accepted one or not yet accepted.
 expect(renderItem(project,d,'PAVI',null)).not.toContain('Accept this revision again');
 d.item.head='c'.repeat(40);expect(renderItem(project,d,'PAVI',{...diff,head:'c'.repeat(40)})).not.toContain('Accept this revision again');
 expect(renderItem(project,detail(),'PAVI',diff)).not.toContain('Accept this revision again');
});
it('empty decisions, history, project creation and unavailable projects remain actionable',()=>{
 expect(renderInbox([],[])).toContain('Bring your first project');
 expect(renderInbox([], [project], 'PAVI', undefined, [{project,items:[],unavailable:true}])).toContain('list may be incomplete');
 expect(renderProjectTasks(project,[])).toContain('What should change?');
 expect(renderHistory([{project,items:[]}])).toContain('Completed tasks will appear here');
});

it('approval and acceptance require visible changes at the recorded revision',()=>{
 const d=detail();
 for(const diff of ['unavailable' as const,null,{head:'c'.repeat(40),base:'b'.repeat(40),files:[],truncated:false}]){
  const html=renderItem(project,d,'PAVI',diff);
  expect(html).not.toContain('Approve revision');expect(html).toContain('Reload this task');
  d.reviews=[{itemId:'t1',head,criteria:NO_CRITERIA,approve:true,by:'pavi',note:'approved',at:time}];
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
import {signIn} from './signin.ts';
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
it('the flow headline counts only the projects whose threads are drawn',()=>{
 const s1=story();
 const hollow=buildStory('hollow',[{...detail().item,id:'t9',state:'merged'}],[
  ev(1,'t9','pavi','item.accepted'),ev(2,'t9','pavi','item.accepted')].reverse(),'pavi');
 expect(hollow.threads.length).toBe(0);
 const html=renderFlow([s1,hollow],hollow.tally,'pavi','PAVI');
 expect(html).toContain('You made 1 decision.');
 expect(html).toContain('2 agents did the other 2 moves');
});
it('a cut record says so where the graph rests',()=>{
 const partial=buildStory('example',[{...detail().item,id:'t1',state:'merged'}],[
  ev(1,'t1','codex/gpt-6','item.claimed')].reverse(),'pavi',true);
 expect(renderInbox([],[project],'PAVI',undefined,[],undefined,new Date(),[],{story:partial,owner:'pavi'}))
  .toContain('the most recent part of the record');
});
// A live page: the policy names one nonce, every script tag carries it and
// loads only Atelier's own script, and the next request gets another nonce.
const NONCE=/'nonce-([A-Za-z0-9+/=]+)'/;
function liveChecks(html:string,csp:string){
 const nonce=NONCE.exec(csp)?.[1];
 expect(nonce,csp).toBeTruthy();
 expect(nonce!.length).toBeGreaterThanOrEqual(20);
 expect(csp).toContain(`script-src 'nonce-${nonce}'`);expect(csp).toContain("connect-src 'self'");expect(csp).toContain("default-src 'none'");
 const tags=html.match(/<script\b[^>]*>/g)??[];
 expect(tags.length).toBeGreaterThan(0);
 for(const t of tags){expect(t).toContain(`nonce="${nonce}"`);expect(t).toContain('src="/live.js"');}
 expect(html).not.toMatch(/<script\b[^>]*>[^<]/);
 return nonce!;
}
it('the flow route is served behind sign-in, under a policy that admits the fonts and the live script by its nonce',async()=>{
 const TOKEN='flow-test-token';
 const testEnv={...env,ATELIER_TOKEN:TOKEN} as typeof env;
 const signedIn=await signIn(TOKEN,{...env,ATELIER_TOKEN:TOKEN} as typeof env);
 const out=await worker.fetch(new Request('https://atelier.test/flow',{redirect:'manual'}),testEnv);
 expect(out.status).not.toBe(200);
 const res=await worker.fetch(new Request('https://atelier.test/flow',{headers:{cookie:signedIn}}),testEnv);
 expect(res.status).toBe(200);
 const html=await res.text();
 expect(html).toContain('<title>Flow · Atelier</title>');
 const csp=res.headers.get('content-security-policy')!;
 expect(csp).toContain('font-src https://fonts.gstatic.com');
 expect(html).toContain('<main id="main" data-live-refresh="15">');
 expect(html).toContain('class="meta live-note" hidden');
 const first=liveChecks(html,csp);
 const again=await worker.fetch(new Request('https://atelier.test/flow',{headers:{cookie:signedIn}}),testEnv);
 const second=liveChecks(await again.text(),again.headers.get('content-security-policy')!);
 expect(second).not.toBe(first);
 // Decisions and a task's page are live too; the public pages and the Studio carry no script and admit none.
 const decisions=await worker.fetch(new Request('https://atelier.test/decisions',{headers:{cookie:signedIn}}),testEnv);
 liveChecks(await decisions.text(),decisions.headers.get('content-security-policy')!);
 for(const path of ['/studio','/home','/how']){
  const r=await worker.fetch(new Request(`https://atelier.test${path}`,{headers:{cookie:signedIn}}),testEnv);
  expect(r.status).toBe(200);
  expect(r.headers.get('content-security-policy')).not.toContain('script-src');
  expect(await r.text()).not.toContain('<script');
 }
 const js=await worker.fetch(new Request('https://atelier.test/live.js'),testEnv);
 expect(js.status).toBe(200);expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
 const script=await js.text();
 expect(script).toContain('data-live-refresh');
 // The revision rule's functions arrive as plain JavaScript, whatever bundled the Worker.
 expect(script).toMatch(/function headsIn\(html\s*\)/);expect(script).toMatch(/function decideRefresh\(current\s*,\s*fetched\s*,\s*dirty\s*\)/);
 expect(script).not.toMatch(/: string|RegExpExecArray/);
});
it('a page without a nonce carries no script tag, and one with a nonce carries exactly the live script',()=>{
 const s=story();
 expect(renderFlow([s],s.tally,'pavi','PAVI')).not.toContain('<script');
 const live=renderFlow([s],s.tally,'pavi','PAVI',false,new Map(),'all',undefined,[],{nonce:'abc+/=',refresh:15});
 expect(live).toContain('<script nonce="abc+/=" src="/live.js" defer></script>');
 expect(live.match(/<script/g)).toHaveLength(1);
 expect(live).toContain('it refreshes every 15 seconds.');
 const noRefresh=renderItem(project,detail(),'PAVI',null,{nonce:'abc'});
 expect(noRefresh).toContain('<script nonce="abc"');expect(noRefresh).not.toContain('data-live-refresh');expect(noRefresh).not.toContain('class="meta live-note"');
});

// ── project titles ──
import {cleanTitle,titleOf,renderStudio} from '../src/ui';
import {renderLogin} from '../src/ui';
it('a project title is one clean line, and the name stands in when there is none',()=>{
 expect(cleanTitle('  Atelier ')).toBe('Atelier');
 expect(cleanTitle('A\ntwo\u0007line')).toBe('A two line');
 expect(cleanTitle('A\u202ab\u200bc\u2066d\ufeff')).toBe('A b c d');
 expect(cleanTitle('x'.repeat(200))).toHaveLength(80);
 expect(cleanTitle('')).toBeUndefined();
 expect(cleanTitle(undefined)).toBeUndefined();
 expect(titleOf({name:'cloudflare-git'})).toBe('cloudflare-git');
 expect(titleOf({name:'cloudflare-git',title:'Atelier'})).toBe('Atelier');
});
it('invisible characters in a title become spaces, not hidden markup',()=>{
 const removed:[string,string][]=[['U+0080','\u0080'],['U+009F','\u009f'],['U+00AD','\u00ad'],['U+061C','\u061c'],['U+180E','\u180e'],['U+200E','\u200e'],['U+200F','\u200f'],['U+2060','\u2060'],['U+2061','\u2061'],['U+2062','\u2062'],['U+2063','\u2063'],['U+2064','\u2064']];
 for(const [name,ch] of removed) expect(cleanTitle('a'+ch+'b'),name).toBe('a b');
 expect(cleanTitle('a‏b')).toBe('a b');
});
it('default ignorable characters in a title become spaces, and an invisible title is no title',()=>{
 const removed:[string,string][]=[
  ['U+034F','\u034f'],['U+115F','\u115f'],['U+1160','\u1160'],['U+17B4','\u17b4'],['U+17B5','\u17b5'],
  ['U+180B','\u180b'],['U+180F','\u180f'],['U+206A','\u206a'],['U+206F','\u206f'],['U+3164','\u3164'],
  ['U+FE00','\ufe00'],['U+FE0F','\ufe0f'],['U+FFA0','\uffa0'],['U+FFF0','\ufff0'],['U+FFF8','\ufff8'],
  ['U+1BCA0','\u{1bca0}'],['U+1BCA3','\u{1bca3}'],['U+1D173','\u{1d173}'],['U+1D17A','\u{1d17a}'],
  ['U+E0000','\u{e0000}'],['U+E0FFF','\u{e0fff}']];
 for(const [name,ch] of removed) expect(cleanTitle('a'+ch+'b'),name).toBe('a b');
 expect(cleanTitle('\u034f\ufe00\u{e0000}')).toBeUndefined();
 expect(cleanTitle('͏'.repeat(80)+'Visible')).toBe('Visible');
});
it('pages call a project by its title and link it by its name',()=>{
 const titled={...project,name:'cloudflare-git',title:'<Atelier>'};
 const list=renderHome([{project:titled,items:[]}]);
 expect(list).toContain('&lt;Atelier&gt;');
 expect(list).toContain('href="/p/cloudflare-git"');
 const page=renderProject(titled,[],[]);
 expect(page).toContain('<h1>&lt;Atelier&gt;</h1>');
 // The form that starts a task lives on the Tasks tab.
 expect(renderProjectTasks(titled,[])).toContain('action="/ui/cloudflare-git/new"');
 const s=buildStory('cloudflare-git',[],[],'pavi',false,'Atelier');
 expect(s.title).toBe('Atelier');
 // A bench of the titled project: the lane names it by title, not by name.
 const benchItem={id:'t1',title:'Fix the lane',scope:[],state:'claimed' as const,owner:'codex/gpt-6',fork:'cloudflare-git--t1',base:null,head:null,acceptedHead:null,createdAt:time,updatedAt:time,lastPushAt:null};
 const floor=buildFloor([{project:titled,items:[benchItem],events:[{seq:1,itemId:'t1',at:time,actor:'codex/gpt-6',kind:'item.claimed',data:{}}]}],new Date(time));
 const studio=renderStudio(floor,'PAVI',new Date(time),false,[titled]);
 expect(studio).toContain('<p class="meta">&lt;Atelier&gt;');
 expect(studio).not.toContain('<p class="meta">cloudflare-git');
 expect(studio).not.toContain('<p class="meta">example');
});

// ── decision brief ──
it('the brief renders above the diff, escapes a hostile summary, and tags the verdict',()=>{
 const d=detail();
 d.evidence[0].where='sandbox';
 d.reviews=[{itemId:'t1',head,criteria:NO_CRITERIA,approve:true,by:'claude-code/opus-5.5',note:'',at:time}];
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
 const d=detail();d.reviews=[{itemId:'t1',head,criteria:NO_CRITERIA,approve:false,by:'claude-code/opus-5.5',note:'no',at:time}];
 const html=renderItem(project,d,'PAVI',null);
 const brief=html.slice(html.indexOf('id="brief"'),html.indexOf('id="changes"'));
 expect(html).toContain('Waiting for an independent review');expect(brief).toContain('Review t1 at aaaaaaaa');expect(brief).toContain('<span class="tag ask">review</span>');
});
it('a claimed task shows the same ask in its banner and its brief',()=>{
 const brief=(h:string)=>h.slice(h.indexOf('id="brief"'),h.indexOf('id="changes"'));
 const failing=detail();failing.item.state='claimed';failing.evidence[0].passed=false;
 const f=renderItem(project,failing,'PAVI',null);
 expect(f).toContain('Checks need attention');expect(brief(f)).toContain('Send t1 back');expect(brief(f)).toContain('<span class="tag bad">send back</span>');
 const rejected=detail();rejected.item.state='claimed';rejected.reviews=[{itemId:'t1',head,criteria:NO_CRITERIA,approve:false,by:'codex/gpt-5.5',note:'no',at:time}];
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
 const index=env.LEDGER.get(env.LEDGER.idFromName('__index'));
 await index.registerProject(record);
 await index.registerProject({...record,name:'missing',repo:'missing'});
 const res=await worker.fetch(new Request('https://atelier.test/showcase'),{...env,SHOWCASE:'shown, missing'} as typeof env);
 expect(res.status).toBe(200);
 expect(res.headers.get('cache-control')).toBe('public, max-age=60, s-maxage=60');
 expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
 const body=await res.text();
 expect(body).toContain('Atelier · public showcase');
 expect(body).toContain('could not be read just now');
 // A second request inside the minute is the cached copy, whatever its query.
 const again=await worker.fetch(new Request('https://atelier.test/showcase?replay=x'),{...env,SHOWCASE:'shown, missing'} as typeof env);
 expect(await again.text()).toBe(body);
 // A different set of public projects has a different cached copy.
 const only=await worker.fetch(new Request('https://atelier.test/showcase'),{...env,SHOWCASE:'shown'} as typeof env);
 expect(await only.text()).not.toContain('could not be read just now');
 const login=await worker.fetch(new Request('https://atelier.test/login'),{...env,SHOWCASE:'shown'} as typeof env);
 expect(await login.text()).toContain('<a href="/">See the public showcase</a>');
});

it('the Models page lists the pool by where it runs, escapes it, and adds through a same-origin form',async()=>{
 const {renderModels}=await import('../src/ui');
 const html=renderModels([
  {id:'GLM-5.3-Flash-4_8bit',harness:'opencode',where:'home',provider:'ai-studio',aliases:[],family:'zai',note:'<b>local</b>',addedBy:'pavi',addedAt:time,status:{state:'available',at:time,by:'home:studio'}},
  {id:'mystery-1',harness:'codex',where:'cloud',provider:'subscription',aliases:[],family:'other',note:'',addedBy:'pavi',addedAt:time},
 ],new Map([['opencode/GLM-5.3-Flash-4_8bit',{itemsClaimed:2,checkPasses:3,checkFailures:0,reviewsApproved:0,reviewsRejected:1,handoffsAway:0,merges:2}]]),'PAVI');
 expect(html).toContain('At home · 1');
 expect(html).toContain('In the cloud · 1');
 expect(html).toContain('&lt;b&gt;local&lt;/b&gt;');
 expect(html).toContain('Took 2 tasks, merged 2');
 expect(html).toContain('checked by home:studio');
 expect(html).toContain('all 1,000 events');
 expect(html).toContain('family not recognised');
 expect(html).toContain('action="/models/add"');
 const TOKEN='models-page-token';
 const signedIn=await signIn(TOKEN,{...env,ATELIER_TOKEN:TOKEN} as typeof env);
 const post=(origin:string,form:Record<string,string>)=>worker.fetch(new Request('https://atelier.test/models/add',{method:'POST',headers:{cookie:signedIn,origin},body:new URLSearchParams(form),redirect:'manual'}),{...env,ATELIER_TOKEN:TOKEN} as typeof env);
 expect((await post('https://evil.test',{id:'x',harness:'codex',where:'cloud'})).status).toBe(403);
 expect((await post('https://atelier.test',{id:'deepseek-chat',harness:'opencode',where:'cloud',provider:'deepseek',keychain:'deepseek.API_KEY'})).status).toBe(303);
 const bad=await post('https://atelier.test',{id:'x',harness:'opencode',where:'cloud',provider:'openai-compatible',endpoint:'https://u:p@x.test'});
 expect(bad.status).toBe(400);
 expect(await bad.text()).toContain('must not carry a user name or password');
 const page=await worker.fetch(new Request('https://atelier.test/models',{headers:{cookie:signedIn}}),{...env,ATELIER_TOKEN:TOKEN} as typeof env);
 expect(await page.text()).toContain('deepseek-chat');
});
it('the front door: / is the public showcase for everyone, and the owner signs in to Home at /home',async()=>{
 const TOKEN='door-test-token';
 const signedIn=await signIn(TOKEN,{...env,ATELIER_TOKEN:TOKEN} as typeof env);
 const go=(path:string,extra:Record<string,string>={},signed=false,method='GET')=>worker.fetch(new Request(`https://atelier.test${path}`,{method,headers:signed?{cookie:signedIn}:{},redirect:'manual'}),{...env,ATELIER_TOKEN:TOKEN,OWNER_NAME:'Door Owner',...extra} as typeof env);
 const record={name:'door',repo:'door',title:'Door project',policy:{checks:[],protected:[]},createdAt:time};
 const L=env.LEDGER.get(env.LEDGER.idFromName('project:door'));
 await L.setProject(record,'owner');
 await env.LEDGER.get(env.LEDGER.idFromName('__index')).registerProject(record);
 await L.newItem('Door work',[],'owner');await L.claim('t1','codex/gpt-6');
 // No session at all: / answers the showcase itself, 200, as /showcase does,
 // anonymised and with none of the owner's pages or forms in it (the owner's
 // display name is public there by design), its header offering Sign in.
 const front=await go('/',{SHOWCASE:'door:anonymous'});
 expect(front.status).toBe(200);
 expect(front.headers.get('cache-control')).toBe('public, max-age=60, s-maxage=60');
 const page=await front.text();
 expect(page).toContain('<title>Atelier · public showcase</title>');
 expect(page).toContain('<a href="/login">Sign in</a>');
 expect(page).toContain('<a class="brand" href="/">Atelier</a>');
 for(const secret of ['Door project','Door work','class="rail"','href="/home"','href="/p/','action="/projects/showcase"'])expect(page).not.toContain(secret);
 expect(await (await go('/showcase',{SHOWCASE:'door:anonymous'})).text()).toBe(page);
 expect((await go('/',{SHOWCASE:'door:anonymous'},false,'HEAD')).status).toBe(200);
 // Signed in, / is still the public front; Home moved to /home.
 const signedFront=await go('/',{SHOWCASE:'door:anonymous'},true);
 expect(signedFront.status).toBe(200);
 expect(await signedFront.text()).toBe(page);
 // Home and the other owner pages send a visitor to sign in.
 expect((await go('/home')).headers.get('location')).toBe('https://atelier.test/login');
 expect((await go('/flow',{SHOWCASE:'door'})).headers.get('location')).toBe('https://atelier.test/login');
 const home=await go('/home',{},true);
 expect(home.status).toBe(200);
 expect(await home.text()).toContain('<title>Home · Atelier</title>');
 const decisions=await go('/decisions',{},true);
 expect(decisions.status).toBe(200);
 expect(await decisions.text()).toContain('<title>Decisions · Atelier</title>');
});
it('the showcase draws a named project that has work, and survives a cache that refuses it',async()=>{
 const record={name:'drawn',repo:'drawn',title:'Drawn project',policy:{checks:[],protected:[]},createdAt:time};
 const L=env.LEDGER.get(env.LEDGER.idFromName('project:drawn'));
 await L.setProject(record,'owner');
 await env.LEDGER.get(env.LEDGER.idFromName('__index')).registerProject(record);
 await L.newItem('Visible work',[],'owner');await L.claim('t1','codex/gpt-6');
 await caches.default.delete(new Request('https://atelier.test/showcase'));
 const put=caches.default.put;
 (caches.default as {put:unknown}).put=async()=>{throw new Error('413')};
 try{
  const res=await worker.fetch(new Request('https://atelier.test/showcase'),{...env,SHOWCASE:'drawn',OWNER_NAME:''} as typeof env);
  expect(res.status).toBe(200);
  const body=await res.text();
  expect(body).toContain('Drawn project');
  expect(body).toContain('>t1<');
  expect(body).toContain('The owner made 0 decisions.');
  expect(body).toContain('the owner decides');
 }finally{(caches.default as {put:unknown}).put=put;}
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
 const link=renderBlob(w,head,['docs'],{kind:'text',lines:['../<b>elsewhere</b>'],bytes:20},null,true);
 expect(link).toContain('A symbolic link to <code>../&lt;b&gt;elsewhere&lt;/b&gt;</code>');
 expect(link).not.toContain('class="code-lines"');
 expect(renderCommit(w,{commit:head,parent:'c'.repeat(40),files:[],truncated:false})).toContain('href="/p/example/t1/commit/'+'c'.repeat(40)+'"');
 expect(renderLog({project,item:null,at:null},head,[head],1,true)).toContain('href="/p/example/log?page=2"');
 expect(codeHref({project,item:null,at:'a'.repeat(40)},['a b'])).toBe('/p/example/code/a%20b?at='+'a'.repeat(40));
});

it('browsing routes read only the baseline or that task fork, and say plainly what is missing',async()=>{
 const {env}=await import('cloudflare:workers');
 const {default:worker}=await import('../src/index');
 const TOKEN='browse-test-token';
 const signedIn=await signIn(TOKEN,{...env,ATELIER_TOKEN:TOKEN} as typeof env);
 const record={name:'browsed',repo:'browsed',policy:{checks:[],protected:[]},createdAt:time};
 const L=env.LEDGER.get(env.LEDGER.idFromName('project:browsed'));
 await L.setProject(record,'owner');
 await env.LEDGER.get(env.LEDGER.idFromName('__index')).registerProject(record);
 await L.newItem('Work',[],'owner');await L.claim('t1','codex/gpt-6');await L.setFork('t1','browsed--t1','0'.repeat(40),'codex/gpt-6');
 const C='c'.repeat(40),T='d'.repeat(40),B='b'.repeat(40),X='e'.repeat(40);
 const asked:string[]=[];
 const repo=(name:string)=>({
  // As Artifacts does: no ref, or this commit, gives it; "HEAD" gives nothing.
  log:async({ref}:{ref?:string})=>ref!==undefined&&ref!==C?[]:[{hash:C,treeHash:T,message:`On ${name}`,author:{name:'A',email:'a@x'},committer:{name:'A',email:'a@x'},parents:[],authoredAt:1,committedAt:1}],
  readCommit:async(h:string)=>h===C?{hash:C,treeHash:T,message:'Only',author:{name:'A',email:'a@x'},committer:{name:'A',email:'a@x'},parents:[],authoredAt:1,committedAt:1}:null,
  readTree:async(h:string)=>h===T?[{name:'README.md',mode:'100644',hash:B,type:'blob'},{name:'run.sh',mode:'100755',hash:X,type:'exec'}]:null,
  readBlob:async(h:string)=>h===B?new Blob(['hello\n']):h===X?new Blob(['#!/bin/sh\n']):null,
  [Symbol.dispose](){},
 });
 const ARTIFACTS={get:async(name:string)=>{asked.push(name);return repo(name)}} as unknown as Artifacts;
 const bindings={...env,ARTIFACTS,ATELIER_TOKEN:TOKEN} as typeof env;
 const get=(path:string,signed=true)=>worker.fetch(new Request(`https://atelier.test${path}`,{headers:signed?{cookie:signedIn}:{},redirect:'manual'}),bindings);
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
 const log=await get('/p/browsed/log');
 expect(log.status).toBe(200);
 expect(await log.text()).toContain(`/p/browsed/commit/${C}`);
 const commit=await get(`/p/browsed/commit/${C}`);
 expect(commit.status).toBe(200);
 expect(await commit.text()).toContain('README.md');
 const history=await get('/p/browsed/history/README.md');
 expect(history.status).toBe(200);
 expect(await history.text()).toContain('On browsed');
 expect((await get('/p/browsed/history')).status).toBe(404);
});

it('the log stops offering older pages at its last page instead of looping',async()=>{
 const {renderLog,LOG_PAGES}=await import('../src/browse/view');
 const head={hash:'a'.repeat(40),treeHash:'b'.repeat(40),message:'m',author:{name:'A',email:'a@x'},parents:[],authoredAt:1};
 const last=renderLog({project,item:null,at:null},head,[head],LOG_PAGES-1,true);
 expect(last).not.toContain('>Older<');
 expect(last).toContain('Older commits are not paged here');
 expect(renderLog({project,item:null,at:null},head,[head],3,true)).toContain('>Older<');
});

// ── a task's thread and Decisions as cards ──
const tev=(seq:number,itemId:string,actor:string,kind:string,data:Record<string,unknown>={})=>({seq,itemId,at:`2026-10-04T10:${String(seq).padStart(2,'0')}:00.000Z`,actor,kind,data});
function threaded(id='t1',title='A <b>bold</b> task'):Detail{
 const d=detail();d.item.id=id;d.item.title=title;d.item.owner='claude-code/opus-5.5';
 d.events=[
  tev(1,id,'codex/gpt-6','item.claimed'),tev(2,id,'codex/gpt-6','push.observed',{head}),
  tev(3,id,'atelier/sandbox','evidence.observed',{claim:'npm test',passed:true,where:'sandbox'}),
  tev(4,id,'pavi','item.handoff',{from:'codex/gpt-6',to:'claude-code/opus-5.5'}),
  tev(5,id,'claude-code/opus-5.5','item.submitted',{head}),
  tev(6,id,'zcode/glm-5.3','review.approved'),tev(7,id,'codex/gpt-5.5','review.rejected',{note:'n'}),
 ].reverse();
 return d;
}
it('the task page draws its own thread above the brief, with its beads, and escapes the title',()=>{
 const html=renderItem(project,threaded(),'PAVI',null);
 const thread=html.slice(html.indexOf('id="thread"'),html.indexOf('id="brief"'));
 expect(html.indexOf('id="thread"')).toBeGreaterThan(-1);
 expect(html.indexOf('id="thread"')).toBeLessThan(html.indexOf('id="brief"'));
 expect(thread).toContain('<svg class="graph"');
 for(const kind of ['push','pass','handoff','submit','approve','reject'])expect(thread).toContain(`class="g-bead pop ${kind}"`);
 expect(thread).toContain('--c:var(--m-zai)');
 expect(thread).toContain('--c:var(--m-openai)');
 expect(thread).toContain('class="g-clock"');
 expect(thread).toContain('A &lt;b&gt;bold&lt;/b&gt; task');
 expect(thread).not.toContain('<b>bold</b>');
  expect(html.match(/<svg class="graph/g)).toHaveLength(1);
});
it('the thread is left off when the record holds no claim, and the note when the task is closed',()=>{
 const bare=detail();
 expect(renderItem(project,bare,'PAVI',null)).not.toContain('id="thread"');
 const merged=threaded();merged.item.state='merged';merged.item.acceptedHead=head;
 const html=renderItem(project,merged,'PAVI',null);
 expect(html).toContain('id="thread"');expect(html).not.toContain('<g class="g-note');
});
it('Decisions draws one card per waiting entry, each with its brief and a mini-thread',()=>{
 const a=threaded('t1','First'),b=threaded('t2','Second <i>x</i>');
 const entries=[{project:'example',itemId:'t2',title:'Second <i>x</i>',kind:'assess' as const,reason:'r',weight:80},{project:'example',itemId:'t1',title:'First',kind:'accept' as const,reason:'r',weight:100}];
 const html=renderInbox(entries,[project],'PAVI',undefined,[],undefined,new Date(),[],undefined,new Map([['example/t1',a],['example/t2',b]]));
 expect(html.match(/class="decision-card"/g)).toHaveLength(2);
 expect(html.match(/<svg class="graph compact mini"/g)).toHaveLength(2);
 expect(html.indexOf('data-task="example/t2"')).toBeLessThan(html.indexOf('data-task="example/t1"'));
 expect(html).toContain('href="/decisions?project=example&task=t1#review"');
 expect(html).toContain('href="/p/example/t1">Open the task page</a>');
 expect(html).toContain('class="card-brief"');
 expect(html).toContain('<span class="tag ask">review</span>');
 expect(html).toContain('class="g-edge approve pop"');expect(html).toContain('class="g-edge reject pop"');
 expect(html).toContain('Second &lt;i&gt;x&lt;/i&gt;');expect(html).not.toContain('<i>x</i>');
});
it('a waiting entry without its record stays a plain row, and an empty inbox renders as before',()=>{
 const entries=[{project:'example',itemId:'t1',title:'First',kind:'accept' as const,reason:'r',weight:100}];
 const plain=renderInbox(entries,[project],'PAVI');
 expect(plain).toContain('class="decision-row"');expect(plain).not.toContain('class="decision-card"');
 const empty=renderInbox([],[project],'PAVI');
 expect(empty).toContain('You’re clear.');expect(empty).toContain('Nothing is waiting on you.');expect(empty).not.toContain('class="decision-card"');
 const selected=renderInbox(entries,[project],'PAVI',{project,detail:threaded(),diff:null},[],undefined,new Date(),[],undefined,new Map([['example/t1',threaded()]]));
 expect(selected).toContain('aria-current="true"');expect(selected).toContain('aria-label="Selected task"');
});
it('a selected decision marks the desk and carries a back link; without one, the list stands alone',()=>{
 const entries=[{project:'example',itemId:'t1',title:'First',kind:'accept' as const,reason:'r',weight:100}];
 const selected=renderInbox(entries,[project],'PAVI',{project,detail:threaded(),diff:null},[],undefined,new Date(),[],undefined,new Map([['example/t1',threaded()]]));
 expect(selected).toContain('class="desk has-selection"');
 expect(selected).toContain('class="review-back" href="/decisions"');
 expect(selected).toContain('>All decisions</span>');
 const rest=renderInbox(entries,[project],'PAVI');
 expect(rest).toContain('class="desk">');
 expect(rest).not.toContain('class="desk has-selection"');
 expect(rest).not.toContain('class="review-back"');
});
it('the merge preview says plainly whether a task would merge into main, and escapes paths',async()=>{
 const {renderMainPreview}=await import('../src/ui');
 expect(renderMainPreview(undefined)).toBe('');
 expect(renderMainPreview(null)).toContain('could not be read just now');
 expect(renderMainPreview({head:'h',ahead:0,aheadCapped:false,merge:{clean:true,conflicts:[],both:[],ours:0,theirs:1}})).toContain('Main has not moved');
 const clean=renderMainPreview({head:'h',ahead:3,aheadCapped:false,merge:{clean:true,conflicts:[],both:['x.ts'],ours:4,theirs:1}});
 expect(clean).toContain('Merges cleanly');
 expect(clean).toContain('3 commits along its first-parent line since this task forked (a merge counts once), changing 4 paths; both sides changed 1 path, and the changes do not overlap');
 const bad=renderMainPreview({head:'h',ahead:1000,aheadCapped:true,merge:{clean:false,conflicts:[{path:'<b>.ts',reason:'both sides changed the same lines'}],both:['<b>.ts'],ours:1,theirs:1}});
 expect(bad).toContain('1 conflict');
 expect(bad).toContain('at least 1,000 commits');
 expect(bad).toContain('<code>&lt;b&gt;.ts</code>');
});

it('the showcase sets a project known only from git beside Atelier\'s record, and says what git cannot show',async()=>{
 const {renderShowcase}=await import('../src/ui');
 const {buildStory}=await import('../src/graph');
 const {buildImported}=await import('../src/import/history');
 const at=(m:number)=>new Date(Date.UTC(2026,9,4,12,m)).toISOString();
 const evs=[
  {seq:1,at:at(0),actor:'pavi',kind:'item.created',itemId:'t1',data:{}},
  {seq:2,at:at(1),actor:'codex/gpt-6-astra',kind:'item.claimed',itemId:'t1',data:{}},
 ].reverse();
 const withs=buildStory('built',[{id:'t1',title:'Work',state:'claimed'}] as never,evs as never,'pavi',false,'Built',{redact:true,ownerLabel:'PAVI'});
 const before=buildStory('old',[],[],'pavi',false,'<Old> project',{redact:true,ownerLabel:'PAVI'});
 const h=buildImported([{hash:'a',committedAt:100,message:'x\n\nCo-Authored-By: Claude Opus 4.7 <n@x>'},{hash:'b',committedAt:200,message:'y'}],null,true);
 const html=renderShowcase([withs,before],withs.tally,'pavi','PAVI',false,new Map([['old',h]]));
 expect(html).toContain('class="compare"');
 expect(html).toContain('Before Atelier · from git');
 expect(html).toContain('&lt;Old&gt; project');
 expect(html).toContain('href="#card-2"');
 expect(html).toContain('href="#card-1"');
 expect(html).toContain('It cannot say whether the checks passed');
 expect(html).toContain('No agent has worked here yet.');
 expect(html).not.toContain('0 tasks taken');
 const card=(cls:string)=>html.split(`class="compare-card ${cls}"`)[1].split('</a>')[0];
 expect(card('before')).toContain('&lt;Old&gt; project');
 expect(card('before')).not.toContain('<Old>');
 expect(card('with')).toContain('>Built<');
 expect(card('before')).toContain('<b>50%</b> of commits name an agent');
 expect(card('with')).not.toContain('class="compare-lead"');
 // A planned task nobody has claimed is still a task: that project is not "before".
 const planned=buildStory('planned',[{id:'t1',title:'Later',state:'open'}] as never,[{seq:1,at:at(0),actor:'pavi',kind:'item.created',itemId:'t1',data:{}}] as never,'pavi',false,'Planned',{redact:true,ownerLabel:'PAVI'});
  const both=renderShowcase([withs,planned,before],withs.tally,'pavi','PAVI',false,new Map([['old',h],['planned',h]]));
  const beforeCard=both.split('class="compare-card before"')[1].split('</a>')[0];
  expect(beforeCard).toContain('href="#card-3"');
  expect(beforeCard).toContain('&lt;Old&gt; project');
  expect(beforeCard).not.toContain('>Planned<');
 expect(renderShowcase([withs,planned],withs.tally,'pavi','PAVI',false,new Map([['planned',h]]))).not.toContain('class="compare"');
 // With nothing imported there is nothing to compare.
 expect(renderShowcase([withs],withs.tally,'pavi','PAVI',false,new Map())).not.toContain('class="compare"');
});

it('the comparison leads with the share of reviews that sent work back',async()=>{
 const {renderShowcase}=await import('../src/ui');
 const {buildStory}=await import('../src/graph');
 const {buildImported}=await import('../src/import/history');
 const at=(m:number)=>new Date(Date.UTC(2026,9,4,12,m)).toISOString();
 const evs=[
  {seq:1,at:at(0),actor:'pavi',kind:'item.created',itemId:'t1',data:{}},
  {seq:2,at:at(1),actor:'codex/gpt-6-astra',kind:'item.claimed',itemId:'t1',data:{}},
  {seq:3,at:at(2),actor:'zcode/glm-5.3',kind:'review.rejected',itemId:'t1',data:{}},
  {seq:4,at:at(3),actor:'zcode/glm-5.3',kind:'review.approved',itemId:'t1',data:{}},
  {seq:5,at:at(4),actor:'opencode/gemini-3.1-pro-preview',kind:'review.approved',itemId:'t1',data:{}},
 ].reverse();
 const withs=buildStory('built',[{id:'t1',title:'Work',state:'claimed'}] as never,evs as never,'pavi',false,'Built',{redact:true,ownerLabel:'PAVI'});
 const before=buildStory('old',[],[],'pavi',false,'Old',{redact:true,ownerLabel:'PAVI'});
 const h=buildImported([{hash:'a',committedAt:100,message:'x\n\nAgent: codex/gpt-6'}],null,true);
 const html=renderShowcase([withs,before],withs.tally,'pavi','PAVI',false,new Map([['old',h]]));
 const card=html.split('class="compare-card with"')[1].split('</a>')[0];
 expect(card).toContain('<b>33%</b> of reviews sent the work back: 1 of 3.');
});

it('a share that rounds to 0% or 100% without being exactly that says so',async()=>{
 const {renderShowcase}=await import('../src/ui');
 const {buildStory}=await import('../src/graph');
 const {buildImported}=await import('../src/import/history');
 const at=(m:number)=>new Date(Date.UTC(2026,9,4,12,m)).toISOString();
 const withs=buildStory('built',[{id:'t1',title:'Work',state:'claimed'}] as never,[{seq:2,at:at(1),actor:'codex/gpt-6-astra',kind:'item.claimed',itemId:'t1',data:{}},{seq:1,at:at(0),actor:'pavi',kind:'item.created',itemId:'t1',data:{}}] as never,'pavi',false,'Built',{redact:true,ownerLabel:'PAVI'});
 const before=buildStory('old',[],[],'pavi',false,'Old',{redact:true,ownerLabel:'PAVI'});
 const commits=(named:number,total:number)=>Array.from({length:total},(_,i)=>({hash:`h${i}`,committedAt:i+1,message:i<named?'x\n\nAgent: codex/gpt-6':'x'}));
 const lead=(named:number,total:number)=>renderShowcase([withs,before],withs.tally,'pavi','PAVI',false,new Map([['old',buildImported(commits(named,total),null,true)]])).split('class="compare-card before"')[1].split('</p>')[0];
 expect(lead(1,300)).toContain('<b>&lt;1%</b>');
 expect(lead(299,300)).toContain('<b>&gt;99%</b>');
 expect(lead(300,300)).toContain('<b>100%</b>');
 expect(lead(0,300)).toContain('<b>0%</b>');
});

it('Flow offers time and family filters that keep each other, and the showcase has none',async()=>{
 const {renderFlow,renderShowcase}=await import('../src/ui');
 const {buildStory}=await import('../src/graph');
 const evs=[{seq:2,itemId:'t1',at:'2026-10-04T10:01:00Z',actor:'codex/gpt-6-astra',kind:'item.claimed',data:{}},{seq:1,itemId:'t1',at:'2026-10-04T10:00:00Z',actor:'pavi',kind:'item.created',data:{}}];
 const s=buildStory('p',[{id:'t1',title:'T',state:'claimed'}] as never,evs as never,'pavi');
 const html=renderFlow([s],s.tally,'pavi','PAVI',false,new Map(),'7d','openai',['openai']);
 expect(html).toContain('href="?since=1d&amp;family=openai"');
 expect(html).toContain('href="?since=7d"');
 expect(html).toMatch(/<a href="\?since=7d&amp;family=openai" aria-current="page"/);
 // Replay is the scrubber the live script adds, not a second control beside it (finding 6).
 expect(html).not.toContain('class="replay"');
 expect(renderFlow([s],s.tally,'pavi','PAVI',false,new Map())).not.toContain('class="replay"');
 expect(renderShowcase([s],s.tally,'pavi','PAVI')).not.toContain('aria-label="Filters"');
});

it('the front door and the login link follow a showcase only while its project is registered',async()=>{
 const TOKEN='door-removed-token';
 const go=(path:string)=>worker.fetch(new Request(`https://atelier.test${path}`,{redirect:'manual'}),{...env,ATELIER_TOKEN:TOKEN,SHOWCASE:'vanishing'} as typeof env);
 const index=env.LEDGER.get(env.LEDGER.idFromName('__index'));
 await index.registerProject({name:'vanishing',repo:'vanishing',policy:{checks:[],protected:[]},createdAt:time});
 expect((await go('/')).status).toBe(200);
 expect(await (await go('/login')).text()).toContain('See the public showcase');
 expect(await index.removeProject('vanishing')).toBe(true);
 expect((await go('/')).status).toBe(404);
 expect(await (await go('/login')).text()).not.toContain('See the public showcase');
 expect((await go('/showcase')).status).toBe(404);
});

// ── the comparison of one project with itself ──
async function sameParts(){
 const {renderShowcase}=await import('../src/ui');
 const {buildStory}=await import('../src/graph');
 const {buildImported}=await import('../src/import/history');
 const unix=(d:string)=>Math.floor(Date.parse(d)/1000);
 const at=(d:number,m=0)=>new Date(Date.UTC(2026,9,d,12,m)).toISOString();
 // Two tasks taken from 5 Oct; the second is sent back once and approved once.
 const evs=(p:string)=>[
  {seq:1,at:at(5,0),actor:'pavi',kind:'item.created',itemId:'t1',data:{}},
  {seq:2,at:at(5,1),actor:'codex/gpt-6-astra',kind:'item.claimed',itemId:'t1',data:{}},
  {seq:3,at:at(5,2),actor:'atelier/sandbox',kind:'evidence.observed',itemId:'t1',data:{claim:'npm test',passed:true,where:'sandbox'}},
  {seq:4,at:at(6,0),actor:'claude-code/opus-5.5',kind:'item.claimed',itemId:'t2',data:{}},
  {seq:5,at:at(6,1),actor:'zcode/glm-5.3',kind:'review.rejected',itemId:'t2',data:{}},
  {seq:6,at:at(6,2),actor:'zcode/glm-5.3',kind:'review.approved',itemId:'t2',data:{}},
  {seq:7,at:at(6,3),actor:'pavi',kind:'item.accepted',itemId:'t2',data:{}},
 ].reverse();
 const items=[{id:'t1',title:'One',state:'claimed'},{id:'t2',title:'Two',state:'accepted'}] as never;
 const story=(p:string,title:string,partial=false)=>buildStory(p,items,evs(p) as never,'pavi',partial,title,{redact:true,ownerLabel:'PAVI'});
 const history=(complete=true)=>buildImported([
  {hash:'a',committedAt:unix('2026-09-04T12:00:00Z'),message:'x\n\nCo-Authored-By: Claude Opus 4.7 <n@x>'},
  {hash:'b',committedAt:unix('2026-09-20T12:00:00Z'),message:'y'},
  {hash:'c',committedAt:unix('2026-10-04T12:00:00Z'),message:'z\n\nAgent: codex/gpt-6'},
 ],unix('2026-10-05T00:00:00Z'),complete);
 return {renderShowcase,story,history};
}
const side=(html:string,cls:string)=>html.split(`class="compare-card ${cls}"`)[1].split('</a>')[0];
it('a project with history before its first task and tasks since is compared with itself',async()=>{
 const {renderShowcase,story,history}=await sameParts();
 const photo=story('photograph','<Photograph>');
 const html=renderShowcase([photo],photo.tally,'pavi','PAVI',false,new Map([['photograph',history()]]));
 const before=side(html,'before'),withs=side(html,'with');
 expect(html).toContain('class="compare"');
 expect(before).toContain('&lt;Photograph&gt;');expect(withs).toContain('&lt;Photograph&gt;');
 expect(before).not.toContain('<Photograph>');
 expect(before).toContain('<p class="meta compare-dates">4 Sept to 4 Oct</p>');
 expect(withs).toContain('since 5 Oct · the same project');
 expect(before).toContain('<b>67%</b> of commits name an agent');
 expect(before).toContain('<b>3</b> commits');
 expect(withs).toContain('<b>50%</b> of reviews sent the work back: 1 of 2.');
 expect(withs).toContain('<b>2</b> tasks taken');
 expect(withs).toContain('<b>1</b> checks run');
 expect(withs).toContain('<b>2</b> reviews, 1 sending work back');
 expect(withs).toContain('<b>1</b> decisions by PAVI');
 expect(before).toContain('href="#card-1"');expect(withs).toContain('href="#card-1"');
 expect(html).toContain('id="card-1"');
 expect(before).toContain('It cannot say whether the checks passed');
 expect(withs).toContain('Atelier records each step as it happens');
});
it('the comparison says when only the recent part of a history or record was read',async()=>{
 const {renderShowcase,story,history}=await sameParts();
 const photo=story('photograph','Photograph',true);
 const html=renderShowcase([photo],photo.tally,'pavi','PAVI',false,new Map([['photograph',history(false)]]));
 expect(side(html,'before')).toContain('4 Sept to 4 Oct · only the most recent part of the history was read');
 expect(side(html,'before')).toContain('<b>3</b> commits (the most recent part)');
 expect(side(html,'with')).toContain('since 5 Oct · only the most recent part of the record was read · the same project');
 const whole=renderShowcase([story('photograph','Photograph')],photo.tally,'pavi','PAVI',false,new Map([['photograph',history(true)]]));
 expect(side(whole,'before')).not.toContain('only the most recent part');
 expect(side(whole,'with')).not.toContain('only the most recent part');
});
it('with no project holding both, the comparison stays across projects, and with several the busiest is chosen',async()=>{
 const {renderShowcase,story,history}=await sameParts();
 const {buildStory}=await import('../src/graph');
 const built=story('built','Built');
 const idle=buildStory('old',[],[],'pavi',false,'Old',{redact:true,ownerLabel:'PAVI'});
 const cross=renderShowcase([built,idle],built.tally,'pavi','PAVI',false,new Map([['old',history()]]));
 expect(side(cross,'before')).toContain('href="#card-2"');expect(side(cross,'with')).toContain('href="#card-1"');
 expect(cross).not.toContain('compare-dates');expect(cross).not.toContain('the same project');
 expect(side(cross,'before')).toContain('>Old<');
 // Two projects with both: the one with more tasks.
 const one=buildStory('small',[{id:'t1',title:'One',state:'claimed'}] as never,[
  {seq:2,at:'2026-10-05T12:01:00Z',actor:'codex/gpt-6-astra',kind:'item.claimed',itemId:'t1',data:{}}] as never,'pavi',false,'Small',{redact:true,ownerLabel:'PAVI'});
 const both=renderShowcase([one,built],one.tally,'pavi','PAVI',false,new Map([['small',history()],['built',history()]]));
 expect(side(both,'before')).toContain('>Built<');expect(side(both,'with')).toContain('>Built<');
 expect(side(both,'with')).toContain('<b>2</b> tasks taken');
 expect(both.match(/class="compare-card before"/g)).toHaveLength(1);
});
it('the comparison dates follow the owner\'s time zone',async()=>{
 const {renderShowcase,story,history}=await sameParts();
 const {setTimeZone}=await import('../src/time');
 const photo=story('photograph','Photograph');
 try{
  setTimeZone('Pacific/Kiritimati');
  const html=renderShowcase([photo],photo.tally,'pavi','PAVI',false,new Map([['photograph',history()]]));
  expect(side(html,'before')).toContain('5 Sept to 5 Oct');
 }finally{setTimeZone(undefined);}
});

// ── where a project stands ──
async function standingFixture(over:Partial<{approval:string}>={}){
 const {buildStanding,renderProject,renderProjectSettings,renderProjectTasks}=await import('../src/ui');
 const p:ProjectRecord={...project,title:'Stand <ing>',policy:{...project.policy,...(over.approval?{approval:over.approval,eligible:['claude'],refuseOverlap:true}:{})}};
 const at=(m:number)=>`2026-10-04T10:${String(m).padStart(2,'0')}:00.000Z`;
 const base={fork:null,base:null,head:null,acceptedHead:null,createdAt:at(0),updatedAt:at(30),lastPushAt:null,scope:[]};
 const items=[
  {...base,id:'t1',title:'Held <b>task</b>',state:'claimed',owner:'claude-code/opus-5.5'},
  {...base,id:'t2',title:'Ready task',state:'submitted',owner:'codex/gpt-6',head},
  {...base,id:'t3',title:'Queued task',state:'open',owner:null,dispatch:{to:'home',agent:'codex',model:'gpt-6',by:'pavi',at:at(5),note:'<i>small</i>'}},
  ...[4,5,6,7,8,9,10].map((n)=>({...base,id:`t${n}`,title:`Merged ${n}`,state:'merged',owner:null,acceptedHead:head,updatedAt:at(n+6)})),
 ] as never[];
 const evs=[
  {seq:1,at:at(1),actor:'codex/gpt-6',kind:'item.claimed',itemId:'t1',data:{}},
  {seq:2,at:at(2),actor:'pavi',kind:'item.handoff',itemId:'t1',data:{from:'codex/gpt-6',to:'claude-code/opus-5.5',note:'Read <script>x</script> first'}},
  {seq:3,at:at(3),actor:'claude-code/opus-5.5',kind:'item.submitted',itemId:'t2',data:{head,summary:'Summary <u>text</u>'}},
  {seq:9,at:at(9),actor:'codex/gpt-6',kind:'item.submitted',itemId:'t10',data:{head,summary:'Merged <u>summary</u>'}},
  ...[4,5,6,7,8,9,10].map((n,i)=>({seq:10+i,at:at(10+i),actor:'pavi',kind:'item.merged',itemId:`t${n}`,data:{mergeCommit:`${n}`.repeat(40),head}})),
 ].reverse() as never[];
 const inbox=[{project:'example',itemId:'t2',title:'Ready task',kind:'accept' as const,reason:'all checks observed passing',weight:100},{project:'example',itemId:'t1',title:'x',kind:'failing' as const,reason:'bad',weight:20}];
 const d=detail();d.item=items[1] as never;d.item.id='t2';d.events=[evs.find((x:any)=>x.kind==='item.submitted')] as never;
 d.gate={ready:true,needsAssessor:false,blockers:[],outOfScope:[]};
 const tasks=new Map<string,any[]>();
 for(const ev of evs as any[])tasks.set(ev.itemId,[...(tasks.get(ev.itemId)??[]),ev]);
 return {buildStanding,renderProject,renderProjectSettings,renderProjectTasks,p,items,evs,tasks,inbox,details:new Map([['t2',d]]),now:new Date('2026-10-05T12:00:00Z')};
}
it('the Overview tab leads with where the project stands: waiting with a brief, queued, merged and handoff notes; who holds what is the Tasks tab',async()=>{
 const f=await standingFixture();
 const s=f.buildStanding(f.p,f.items,f.tasks,300,f.inbox,f.details,f.now);
 const html=f.renderProject(f.p,f.items,[],'PAVI',s);
 const sec=html.slice(html.indexOf('id="standing"'),html.indexOf('<details class="disclosure"'));
 expect(html.indexOf('id="standing"')).toBeLessThan(html.indexOf('<details class="disclosure"'));
 // The one list of who holds what is the Tasks tab's, not a second one here (finding 8).
 expect(sec).not.toContain('Held now');
 expect(sec).toContain('Waiting on the owner');expect(sec).toContain('all checks observed passing · brief, accept: 1 of 1 required checks passed at this revision and nothing blocks it.');
 expect(sec).not.toContain('bad');expect(sec).toContain('Ready to accept');
 expect(sec).toContain('Queued for a runner');expect(sec).toContain('for home codex/gpt-6 · sent by pavi');
 expect(sec).toContain('Last merges');
 expect((sec.match(/href="\/p\/example\/t(?:4|5|6|7|8|9|10)"/g)||[]).length).toBe(5);
 expect(sec).toContain('Merged 10');expect(sec).toContain('Merged &lt;u&gt;summary&lt;/u&gt;');
 expect(sec).toContain('Handoff notes');expect(sec).toContain('codex/gpt-6 to claude-code/opus-5.5');
 expect(sec).toContain('atelier status --project example');
 expect(sec).not.toContain('ControlPlane');
 const tasks=f.renderProjectTasks(f.p,f.items);
 expect(tasks).toContain('claude-code/opus-5.5');expect(tasks).toContain('codex/gpt-6');
});
it('the standing section and the Settings tab escape everything a person or agent wrote',async()=>{
 const f=await standingFixture({approval:'<b>PAVI</b>'});
 const s=f.buildStanding(f.p,f.items,f.tasks,300,f.inbox,f.details,f.now);
 const page=f.renderProject(f.p,f.items,[],'PAVI',s);
 const sec=page.split('id="standing"')[1].split('<details class="disclosure"')[0];
 for(const raw of ['<b>task</b>','<script>x</script>','<i>small</i>','<b>PAVI</b>','<u>summary</u>'])expect(page).not.toContain(raw);
 for(const esc of ['Read &lt;script&gt;x&lt;/script&gt; first','&lt;i&gt;small&lt;/i&gt;','Merged &lt;u&gt;summary&lt;/u&gt;'])expect(sec).toContain(esc);
 // The ControlPlane policy the project records is drawn on the Settings tab, escaped.
 expect(page).not.toContain('ControlPlane');
 const settings=f.renderProjectSettings(f.p);
 for(const esc of ['ControlPlane policy, approved: &lt;b&gt;PAVI&lt;/b&gt;','Protected areas: src/**. Eligible agents: claude. Overlapping claims: refused.'])expect(settings).toContain(esc);
 expect(settings).not.toContain('<b>PAVI</b>');
});
it('the standing data lists the last five merges newest first, with the agent\'s summary, and empty parts are left out',async()=>{
 const f=await standingFixture();
 const s=f.buildStanding(f.p,f.items,f.tasks,300,f.inbox,f.details,f.now);
 expect(s.merged.map((m)=>m.id)).toEqual(['t10','t9','t8','t7','t6']);
 expect(s.merged[0].commit).toBe('10'.repeat(40));
 expect(s.merged[0].line).toBe('Merged <u>summary</u>');expect(s.merged[1].line).toBeNull();
 expect(s.waiting.map((w)=>w.id)).toEqual(['t2']);
 expect(s.live.map((l)=>l.id)).toEqual(['t1','t2']);
 expect(s.handoffs.map((h)=>h.note)).toEqual(['Read <script>x</script> first']);
 const quiet=f.buildStanding(f.p,[],new Map(),300,[],new Map(),f.now);
 expect(f.renderProject(f.p,[],[],'PAVI',quiet)).toContain('Nothing is waiting, queued or recently merged.');
 expect(f.renderProject(f.p,[],[],'PAVI',quiet)).not.toContain('<h3>');
});

it('a waiting task keeps the inbox\'s own reason, with the brief after it, and an overlap names the other task',async()=>{
 const f=await standingFixture();
 const inbox=[
  {project:'example',itemId:'t2',title:'Ready task',kind:'accept' as const,reason:'all checks observed passing',weight:100},
  {project:'example',itemId:'t2',title:'Ready task',kind:'overlap' as const,reason:'scope overlaps t9 (codex/gpt-6)',weight:40},
  {project:'example',itemId:'t1',title:'Held',kind:'stale' as const,reason:'claude-code/opus-5.5 has not pushed for 14h; hand it off or release it',weight:50},
 ];
 const s=f.buildStanding(f.p,f.items,f.tasks,300,inbox,f.details,f.now);
 const t2=s.waiting.find((w)=>w.id==='t2')!,t1=s.waiting.find((w)=>w.id==='t1')!;
 expect(t2.kind).toBe('accept');expect(t2.kinds).toEqual(['accept','overlap']);
 expect(t2.reason).toBe('all checks observed passing; scope overlaps t9 (codex/gpt-6)');
 expect(t1.kind).toBe('stale');expect(t1.reason).toContain('hand it off or release it');expect(t1.brief).toBeNull();
 const sec=f.renderProject(f.p,f.items,[],'PAVI',s).split('id="standing"')[1].split('<details class="disclosure"')[0];
 expect(sec).toContain('scope overlaps t9 (codex/gpt-6) · brief, accept: ');
 expect(sec).toContain('hand it off or release it');expect(sec).not.toContain('brief, wait');
});
it('since when comes from the task\'s own claim or handoff, and a record that cannot say is reported, not guessed',async()=>{
 const f=await standingFixture();
 // t1 was updated days after it was taken; its own events say when it was taken.
 const late=f.items.map((i:any)=>i.id==='t1'?{...i,updatedAt:'2026-10-09T00:00:00.000Z'}:i);
 const ok=f.buildStanding(f.p,late as never,f.tasks,300,[],new Map(),f.now);
 expect(ok.live.find((l)=>l.id==='t1')!.since).toBe('2026-10-04T10:02:00.000Z');
 expect(ok.partial.filter((x)=>x.startsWith('t1: '))).toEqual([]);
 // Its events are cut: the window is full and holds no claim. Nothing is made up.
 const cut=new Map(f.tasks);cut.set('t1',[{seq:50,at:'2026-10-04T10:40:00.000Z',actor:'claude-code/opus-5.5',kind:'push.observed',itemId:'t1',data:{head}}] as never);
 const s=f.buildStanding(f.p,late as never,cut as never,1,[],new Map(),f.now);
 expect(s.live.find((l)=>l.id==='t1')!.since).toBeNull();
 expect(s.partial).toContain('t1: when it was taken is not shown, because its record is longer than the last 1 events read.');
 const html=f.renderProject(f.p,late as never,[],'PAVI',s);
 expect(html).toContain('Part of this record is not shown');expect(html).toContain('when it was taken is not shown');
 expect(html.split('id="standing"')[1].split('<details class="disclosure"')[0]).not.toContain('2026-10-09');
 // A task whose record was not read at all says so.
 const unread=f.buildStanding(f.p,late as never,new Map(),300,[],new Map(),f.now);
 expect(unread.partial).toContain('t1: when it was taken is not shown, because its record was not read here.');
});
it('the last merges come from the merged items, however much newer work there is',async()=>{
 const f=await standingFixture();
 const {standingTasks}=await import('../src/ui');
 expect(standingTasks(f.items as never)).toEqual(['t1','t2','t10','t9','t8','t7','t6']);
 // Merge times are the items' own; a task with no events read still lists, from its item.
 const s=f.buildStanding(f.p,f.items,new Map([['t10',f.tasks.get('t10')!]]),300,[],new Map(),f.now);
 expect(s.merged).toHaveLength(5);
 expect(s.merged[0]).toMatchObject({id:'t10',commit:'10'.repeat(40),line:'Merged <u>summary</u>'});
 expect(s.merged[1]).toMatchObject({id:'t9',commit:null,at:'2026-10-04T10:15:00.000Z'});
 expect(s.partial.some((x)=>x.startsWith('t9: its summary may be missing'))).toBe(true);
});

it('the standing page shows the newest session with escaped reported text', async () => {
 const f = await standingFixture();
 const s = f.buildStanding(f.p, [], new Map(), 100, [], new Map(), new Date(time));
 s.session = { actor: 'codex/gpt-6-astra', at: time, data: { summary: '<script>session</script>', next: 'Continue', head, dirty: true, checks: [{ command: 'npm test', passed: false, grade: 'reported' }], checksSkipped: false } };
 const html = f.renderProject(f.p, [], [], 'PAVI', s);
 expect(html).toContain('Newest session');
 expect(html).toContain('&lt;script&gt;session&lt;/script&gt;');
 expect(html).not.toContain('<script>session');
 expect(html).toContain('Reported: npm test: failed');
});

it('the checks on the would-be merge stand beside the preview, bound to the main head they merged with, and never as the revision\'s own check',async()=>{
 const {renderMainPreview}=await import('../src/ui');
 const {mergedChecksAt}=await import('../src/rules');
 const M0='c'.repeat(40),M1='d'.repeat(40);
 const preview=(mainHead:string,ahead=2)=>({head:mainHead,ahead,aheadCapped:false,merge:{clean:true,conflicts:[],both:[],ours:1,theirs:1}});
 const merged=(over:Partial<Detail['evidence'][number]>={})=>({itemId:'t1',claim:'npm test',grade:'observed' as const,head,passed:true,by:'codex/gpt-6',at:time,changedPaths:null,merged:true,mainHead:M1,...over});
 // Beside the preview: a current run, a stale one, and the offer when none was run.
 const current=renderMainPreview(preview(M1),mergedChecksAt(project.policy,[merged()],head,M1));
 expect(current).toContain('Checks on the merge with main, at this revision');
 expect(current).toContain(`with main at <code>${M1.slice(0,8)}</code>`);
 expect(current).toContain('<span class="tag go">Passed</span><code>npm test</code>');
 expect(current).not.toContain('Stale');
 const stale=renderMainPreview(preview(M0),mergedChecksAt(project.policy,[merged({passed:false})],head,M0));
 expect(stale).toContain('<span class="tag bad">Failed</span><code>npm test</code>');
 expect(stale).toContain('<span class="tag ask">Stale</span>');
 expect(stale).toContain(`main is now at <code>${M0.slice(0,8)}</code>; run <code>atelier check --merged</code> again`);
 const offer=renderMainPreview(preview(M1),mergedChecksAt(project.policy,[],head,M1));
 expect(offer).toContain('Checks on the merge: not run. <code>atelier check --merged</code>');
 expect(renderMainPreview(preview(M1,0),mergedChecksAt(project.policy,[],head,M1))).not.toContain('Checks on the merge');
 expect(renderMainPreview(preview(M1))).not.toContain('Checks on the merge');
 // On the item page the merged run is listed beside the preview, and the revision's own check still waits.
 const d=detail();d.evidence=[merged()];d.gate={ready:false,needsAssessor:false,blockers:['`npm test` not yet observed at this head'],outOfScope:[]};
 const html=renderItem(project,d,'PAVI',{head,base:'b'.repeat(40),files:[{path:'src/a.ts',status:'modified',added:1,removed:0,hunks:[]}],truncated:false,main:preview(M1)});
 expect(html).toContain('Checks on the merge with main, at this revision');
 expect(html).toContain('<span class="tag ask">Waiting</span><code>npm test</code>');
 expect(html).toContain('The task owner must run this required check.');
 expect(html).not.toContain('Accept revision');
 // Without a preview there is nothing to mark stale against, so the merged run is not shown beside it.
 expect(renderItem(project,d,'PAVI',{head,base:'b'.repeat(40),files:[],truncated:false})).not.toContain('Checks on the merge');
});
it('a blocked task shows who blocked it and why, offers unblock and close only, and a live task offers the block form',()=>{
 const diff={head,base:'b'.repeat(40),files:[],truncated:false};
 const d=detail();d.item.state='blocked';d.item.blocked={reason:'waiting on <keys>',by:'codex/gpt-6',at:time,from:'submitted'};d.gate={ready:false,needsAssessor:false,blockers:['state is blocked, not submitted'],outOfScope:[]};
 const html=renderItem(project,d,'PAVI',diff);
 expect(html).toContain('Blocked by codex/gpt-6');expect(html).toContain('waiting on &lt;keys&gt;');expect(html).not.toContain('waiting on <keys>');
 expect(html).toContain('action="/ui/example/t1/unblock"');expect(html).toContain('returns it to in review');expect(html).toContain('example · t1 · Blocked');
 expect(html).toContain('Decide t1 at');expect(html).toContain('Clear that, then run atelier unblock t1');
 expect(html).not.toContain('Approve revision');expect(html).not.toContain('Request changes');expect(html).not.toContain('Release task');expect(html).not.toContain('Block this task');
 expect(html).toContain('Close task without merging');
 const live=renderItem(project,detail(),'PAVI',diff);
 expect(live).toContain('Block this task');expect(live).toContain('action="/ui/example/t1/block"');expect(live).toContain('<textarea name="note" required rows="2" maxlength="500">');
 const open=detail();open.item.state='open';open.item.owner=null;open.item.head=null;
 expect(renderItem(project,open,'PAVI',null)).toContain('Block this task');
 const merged=detail();merged.item.state='merged';
 expect(renderItem(project,merged,'PAVI',null)).not.toContain('Block this task');
});
it('the framing is shown when any of it is set, escaped, and left out when none is',()=>{
 const d=detail();d.item.nonGoals=['no <b>CSS</b>','no routes'];d.item.stopWhen=['a check fails twice'];d.item.nextGate='design <review>';
 const html=renderItem(project,d,'PAVI',null);
 expect(html).toContain('aria-label="How the task is framed"');
 expect(html).toContain('<dt>Non-goals</dt><dd><ul><li>no &lt;b&gt;CSS&lt;/b&gt;</li><li>no routes</li></ul></dd>');
 expect(html).toContain('<dt>Stop when</dt><dd><ul><li>a check fails twice</li></ul></dd>');expect(html).toContain('<dt>Next gate</dt><dd>design &lt;review&gt;</dd>');
 expect(html.indexOf('How the task is framed')).toBeLessThan(html.indexOf('id="changes"'));
 const gateOnly=detail();gateOnly.item.nextGate='demo';
 const one=renderItem(project,gateOnly,'PAVI',null);expect(one).toContain('<dt>Next gate</dt>');expect(one).not.toContain('<dt>Non-goals</dt>');
  expect(renderItem(project,detail(),'PAVI',null)).not.toContain('How the task is framed');
});
// ── Home as the portfolio, history as a timeline ──
it('Home draws a card per project with what waits, what runs, its two-week graph and its last merge, and what waits comes first',async()=>{
 const {renderHome}=await import('../src/ui');
 const now=new Date('2026-10-06T14:30:00Z');
 const at=(h:number)=>new Date(now.getTime()-h*3600_000).toISOString();
 const titled={...project,name:'cloudflare-git',title:'<Atelier>'};
 const items=[{...detail().item,id:'t1',state:'claimed' as const},{...detail().item,id:'t2',state:'open' as const},{...detail().item,id:'t3',state:'merged' as const}];
 const events=[
  {seq:1,itemId:'t1',at:at(30),actor:'codex/gpt-6',kind:'item.claimed',data:{}},
  {seq:2,itemId:'t1',at:at(29),actor:'codex/gpt-6',kind:'push.observed',data:{head}},
  {seq:3,itemId:'t1',at:at(28),actor:'atelier/sandbox',kind:'evidence.observed',data:{claim:'npm test',passed:true,where:'sandbox'}},
  {seq:4,itemId:'t3',at:at(2),actor:'claude-code/opus-5.5',kind:'item.claimed',data:{}},
  {seq:5,itemId:'t3',at:at(1),actor:'pavi',kind:'item.accepted',data:{head}},
 ].reverse();
 const waiting=[{project:'cloudflare-git',itemId:'t2',title:'Open <i>thing</i>',kind:'assess' as const,reason:'a review is wanted',weight:80}];
 const html=renderHome([{project:titled,items,events,waiting},{project:{...project,name:'gone'},items:[],unavailable:true}],'PAVI',now,'pavi');
 expect(html.match(/<li class="project-card/g)).toHaveLength(2);
 expect(html).toContain('<h1>Home</h1>');
 expect(html).toContain('href="/flow">the whole flow</a>');expect(html).toContain('href="/history">the timeline of merges</a>');
 expect(html).toContain('<h2>&lt;Atelier&gt;</h2>');expect(html).toContain('href="/p/cloudflare-git"');
 expect(html).toContain('<b>1</b>waiting on you');expect(html).toContain('<b>1</b>running');expect(html).toContain('<b>1</b>ready to start');expect(html).toContain('<b>1</b>merged');
 expect(html).toContain('Waiting on you');expect(html).toContain('href="/p/cloudflare-git/t2">Open &lt;i&gt;thing&lt;/i&gt;</a>');expect(html).not.toContain('<i>thing</i>');
 expect(html).toContain('Running');expect(html).toContain('href="/p/cloudflare-git/t1"');
 expect(html).toContain('Last merge: <a href="/p/cloudflare-git/t3">');
 expect(html.match(/<svg class="pulse-graph"/g)).toHaveLength(1);
 expect(html).toContain('style="fill:var(--m-openai)"');expect(html).toContain('style="fill:var(--m-anthropic)"');expect(html).toContain('style="fill:var(--m-owner)"');
 expect(html).toContain('3 moves by 2 agents and 1 decision in two weeks · last activity 1 h ago.');
 expect(html).toContain('most on 5 Oct');
 expect(html).toContain('Temporarily unavailable. Open to retry.');
 expect(html).toContain('class="legend-line"');
 // A project with something waiting is drawn before one without, whatever their names.
 expect(html.indexOf('href="/p/cloudflare-git"')).toBeLessThan(html.indexOf('href="/p/gone"'));
 const cut=renderHome([{project:titled,items,events,cut:true}],'PAVI',now,'pavi');
 expect(cut).toContain('from the most recent part of the record');
 const quiet=renderHome([{project:titled,items:[]}],'PAVI',now,'pavi');
 expect(quiet).toContain('No moves in the last two weeks.');expect(quiet).toContain('aria-label="No moves in the last two weeks"');
 expect(quiet).toContain('Nothing merged yet.');
 expect(renderHome([],'PAVI',now,'pavi')).toContain('Start with one project');
});
it('History is a timeline of merges by day, each marked with the family that held the task, and closures apart',async()=>{
 const {renderHistory}=await import('../src/ui');
 const at=(d:number,h:number)=>`2026-10-0${d}T${String(h).padStart(2,'0')}:00:00.000Z`;
 const base={...detail().item,owner:null,acceptedHead:head};
 const items=[
  {...base,id:'t1',title:'Merged <b>one</b>',state:'merged' as const,updatedAt:at(5,10)},
  {...base,id:'t2',title:'Merged two',state:'merged' as const,updatedAt:at(4,9)},
  {...base,id:'t3',title:'Dropped',state:'abandoned' as const,updatedAt:at(4,8)},
  {...base,id:'t4',title:'Still working',state:'claimed' as const,owner:'codex/gpt-6'},
 ];
 const events=[
  {seq:1,itemId:'t1',at:at(5,8),actor:'codex/gpt-5.5',kind:'item.claimed',data:{}},
  {seq:2,itemId:'t1',at:at(5,9),actor:'pavi',kind:'item.handoff',data:{from:'codex/gpt-5.5',to:'claude-code/opus-5.5'}},
  {seq:3,itemId:'t1',at:at(5,10),actor:'pavi',kind:'item.merged',data:{mergeCommit:'c'.repeat(40),head}},
  {seq:4,itemId:'t2',at:at(4,7),actor:'zcode/glm-5.3',kind:'item.claimed',data:{}},
  {seq:5,itemId:'t2',at:at(4,9),actor:'pavi',kind:'item.merged',data:{mergeCommit:'d'.repeat(40),head}},
  {seq:6,itemId:'t3',at:at(4,8),actor:'pavi',kind:'item.abandoned',data:{note:'no'}},
 ].reverse();
 const html=renderHistory([{project:{...project,title:'Example <i>x</i>'},items,events}],'PAVI','pavi');
 expect(html).toContain('2 tasks merged and 1 closed across 1 project');
 expect(html).toContain('class="merge-timeline"');
 expect(html.match(/class="timeline-day"/g)).toHaveLength(2);
 expect(html).toContain('<h2>Monday 5 Oct 2026</h2>');expect(html).toContain('<h2>Sunday 4 Oct 2026</h2>');
 expect(html.indexOf('href="/p/example/t1"')).toBeLessThan(html.indexOf('href="/p/example/t2"'));
 expect(html).toContain('Merged &lt;b&gt;one&lt;/b&gt;');expect(html).not.toContain('<b>one</b>');
 expect(html).toContain('Example &lt;i&gt;x&lt;/i&gt; · t1 · opus-5.5 · merged as cccccccc');
 expect(html).toContain('style="--c:var(--m-anthropic)" title="merged while held by claude-code/opus-5.5"');
 expect(html).toContain('style="--c:var(--m-zai)"');
 expect(html).toContain('class="merge-row closed"');expect(html).toContain('class="family-mark unknown"');
 expect(html).toContain('closed without merging');expect(html).toContain('<span class="tag ">Closed</span>');
 expect(html).toContain('href="/p/example/t1"');expect(html).not.toContain('href="/p/example/t4"');
 expect(html).toContain('<time datetime="2026-10-05T10:00:00.000Z">10:00 UTC</time>');
 expect(html).toContain('class="cap-key"');
 expect(renderHistory([{project,items:[]}],'PAVI','pavi')).not.toContain('class="legend-line"');
});

// ── Studio lanes in Flow's language, stripes by family, and sign-in over the showcase ──
it('a Studio lane is banded and threaded in each holder\'s family colour, with the marks and a breathing head',()=>{
 const base={id:'t1',title:'Lane',scope:[],state:'claimed' as const,owner:'opencode/glm-5.3-flash',fork:'example--t1',base:null,head:null,acceptedHead:null,createdAt:time,updatedAt:time,lastPushAt:null};
 const at=(m:number)=>`2026-10-03T12:${String(m).padStart(2,'0')}:00.000Z`;
 const events=[
  {seq:1,itemId:'t1',at:at(0),actor:'codex/gpt-6',kind:'item.claimed',data:{}},
  {seq:2,itemId:'t1',at:at(2),actor:'codex/gpt-6',kind:'push.observed',data:{head}},
  {seq:3,itemId:'t1',at:at(9),actor:'pavi',kind:'item.handoff',data:{from:'codex/gpt-6',to:'opencode/glm-5.3-flash'}},
  {seq:4,itemId:'t1',at:at(9),actor:'opencode/glm-5.3-flash',kind:'item.claimed',data:{}},
 ];
 const floor=buildFloor([{project,items:[base],events}],new Date(at(10)));
 const html=renderStudio(floor,'PAVI',new Date(at(10)),false,[project],'pavi');
 expect(html).toContain('class="span-past" style="--c:var(--m-openai)"');
 expect(html).toContain('class="span-now" style="--c:var(--m-zai)"');
 expect(html).toContain('class="g-thread g-lane" style="--c:var(--m-openai)"');
 expect(html).toContain('class="g-thread g-lane local" style="--c:var(--m-zai)"');
 expect(html).toContain('<circle class="g-head" cx="100%"');expect(html).toContain('<g class="g-task live">');
 expect(html).toContain('<li class="lane" id="example-t1" style="--c:var(--m-zai)">');
 for(const m of ['m-claim','m-push','m-handoff'])expect(html).toContain(`class="${m}"`);
 expect(html).toContain('class="legend-line"');expect(html).toContain('dotted: ran locally');expect(html).toContain('>GPT<');expect(html).toContain('>GLM<');
  // One row of the commonest marks under the family legend, the full table in the disclosure (finding 20).
  expect(html).toContain('aria-label="The commonest marks"');
  expect(html.match(/class="legend-line marks-legend"/g)).toHaveLength(1);
  for(const m of ['Claimed','Pushed','Check passed in Cloudflare','Check failed','Submitted','Approved'])expect(html).toContain(`>${m}</li>`);
  expect(html).toContain('What the marks mean');
 // A band that starts late is labelled to its left, so the label never runs past now.
 expect(html).toContain('dx="-8" y="22" text-anchor="end" class="span-label now"');
 expect(renderStudio({benches:[],from:at(0),to:at(10)},'PAVI',new Date(at(10)))).not.toContain('class="legend-line"');
});
it('Code and Log carry a stripe per entry and per commit in the family the commit names, with the name in words',async()=>{
 const {renderTree,renderLog,renderCommit,commitFamily}=await import('../src/browse/view');
 const c=(id:string,message:string)=>({hash:id.repeat(40),treeHash:'b'.repeat(40),message,author:{name:'<A>',email:'a@x'},parents:[],authoredAt:1759600000});
 const fable=c('1','Subject\n\nAgent: claude-code/fable-5.1'),gpt=c('2','Other\n\nCo-Authored-By: GPT-6 Astra <n@x>'),none=c('3','Plain <b>subject</b>');
 expect(commitFamily(fable)).toEqual({label:'fable-5.1',colour:'var(--m-anthropic)'});
 expect(commitFamily(gpt)).toEqual({label:'gpt-6-astra',colour:'var(--m-openai)'});
 expect(commitFamily(none)).toEqual({label:'no agent named',colour:'var(--text-dim)'});
 const w={project,item:null,at:null};
 const node={kind:'tree' as const,hash:'d'.repeat(40),entries:[{name:'src',type:'tree',mode:'40000',hash:'e'.repeat(40)},{name:'<x>.ts',type:'blob',mode:'100644',hash:'f'.repeat(40)},{name:'old.md',type:'blob',mode:'100644',hash:'0'.repeat(40)}],total:3};
 const touched={by:new Map([['src',fable],['<x>.ts',gpt]]),examined:60,complete:false};
 const tree=renderTree(w,fable,[],node,'PAVI',touched);
 expect(tree).toContain('<li class="dir striped"><i class="stripe" style="--c:var(--m-anthropic)" aria-hidden="true"></i>');
 expect(tree).toContain('fable-5.1 · <a class="mono" href="/p/example/commit/'+'1'.repeat(40)+'">11111111</a>');
 expect(tree).toContain('gpt-6-astra · <a class="mono"');
 expect(tree).toContain('<i class="stripe none" aria-hidden="true"></i><span class="entry"><a href="/p/example/code/old.md">old.md</a></span><span class="meta touch">not changed in the commits read</span>');
 expect(tree).toContain('among the last 60 commits on the first-parent line');
 expect(tree).toContain('&lt;x&gt;.ts');
 const plain=renderTree(w,fable,[],node,'PAVI');
 expect(plain).not.toContain('class="stripe');expect(plain).not.toContain(' striped"');expect(plain).toContain('<li class="dir"><span class="entry"><a href="/p/example/code/src">src/</a></span></li>');
 expect(renderTree(w,fable,[],node,'PAVI',null)).toContain('could not be read just now');
 expect(renderTree(w,fable,[],node,'PAVI',{by:new Map(),examined:0,complete:false})).toContain('too deep or too busy');
 const log=renderLog(w,fable,[fable,gpt,none],0,false,'PAVI');
 expect(log).toContain('<li><i class="stripe" style="--c:var(--m-anthropic)" aria-hidden="true"></i><a class="mono"');
 expect(log).toContain('<span class="meta">gpt-6-astra · &lt;A&gt; · ');
 expect(log).toContain('<li><i class="stripe" style="--c:var(--text-dim)" aria-hidden="true"></i>');
 expect(log).toContain('no agent named · &lt;A&gt;');expect(log).not.toContain('<b>subject</b>');
 const commit=renderCommit(w,{commit:fable,parent:null,files:[],truncated:false},'PAVI');
 expect(commit).toContain('<section class="commit-head" style="--c:var(--m-anthropic)">');
 expect(commit).toContain(' · fable-5.1 · &lt;A&gt; · ');
});
it('the sign-in page stands over the showcase\'s graph, dimmed, with nothing focusable or private in it',async()=>{
 const s=buildStory('example',[{...detail().item,id:'t1',state:'merged'}],[
  ev(1,'t1','codex/gpt-6','item.claimed'),ev(2,'t1','claude-code/opus-5.5','review.rejected',{note:'secret reviewer note'}),
  ev(3,'t1','pavi','item.accepted'),ev(4,'t1','pavi','item.merged',{mergeCommit:'c'.repeat(40)})].reverse(),'pavi',false,'Example',{redact:true,ownerLabel:'PAVI'});
 const html=renderLogin(undefined,true,{stories:[s],owner:'pavi',who:'PAVI'});
 expect(html).toContain('<section class="login over-graph"><div class="login-backdrop" aria-hidden="true"><svg class="graph"');
 expect(html).not.toContain('tabindex="0"');expect(html).not.toContain('href="/p/');expect(html).not.toContain('secret reviewer note');
 expect(html).toContain('<a href="/">See the public showcase</a>');
 expect(html).toContain('<form method="post" action="/login" class="login-form">');
 const bare=buildStory('bare',[],[],'pavi',false,'Bare',{redact:true});
 expect(renderLogin(undefined,true,{stories:[bare],owner:'pavi',who:'PAVI'})).not.toContain('class="login-backdrop"');
 expect(renderLogin()).not.toContain('class="login-backdrop"');
 expect(renderLogin('That token is not this server\'s.',false)).toContain('role="alert"');
 // The route: with a showcased project that has work, the graph is drawn; without one, it is not.
 const record={name:'backdrop',repo:'backdrop',title:'Backdrop',policy:{checks:[],protected:[]},createdAt:time};
 const L=env.LEDGER.get(env.LEDGER.idFromName('project:backdrop'));
 await L.setProject(record,'owner');
 await env.LEDGER.get(env.LEDGER.idFromName('__index')).registerProject(record);
 await L.newItem('Shown work',[],'owner');await L.claim('t1','codex/gpt-6');
 const shown=await worker.fetch(new Request('https://atelier.test/login'),{...env,ATELIER_TOKEN:'x',SHOWCASE:'backdrop'} as typeof env);
 expect(shown.status).toBe(200);
 const body=await shown.text();
 expect(body).toContain('class="login-backdrop"');expect(body).toContain('Shown work');expect(body).not.toContain('href="/p/');
 // The stories are cached for a minute, as the showcase is: work taken since does not reach the open page until then.
 await L.newItem('Later work',[],'owner');await L.claim('t2','codex/gpt-6');
 const again=await worker.fetch(new Request('https://atelier.test/login'),{...env,ATELIER_TOKEN:'x',SHOWCASE:'backdrop'} as typeof env);
 const cached=await again.text();
 expect(cached).toContain('Shown work');expect(cached).not.toContain('Later work');
 const plain=await worker.fetch(new Request('https://atelier.test/login'),{...env,ATELIER_TOKEN:'x'} as typeof env);
 expect(await plain.text()).not.toContain('class="login-backdrop"');
 const wrong=await worker.fetch(new Request('https://atelier.test/login',{method:'POST',headers:{origin:'https://atelier.test'},body:new URLSearchParams({token:'no'})}),{...env,ATELIER_TOKEN:'x',SHOWCASE:'backdrop'} as typeof env);
 expect(wrong.status).toBe(401);
  expect(await wrong.text()).toContain('class="login-backdrop"');
});

// ── the site organised by project (t185) ──
it('the navigation holds the owner\'s cross-project views in order, with Models and Usage under the account menu',()=>{
 const html=renderHome([]);
 const nav=html.split('<nav aria-label="Main navigation">')[1].split('</nav>')[0];
 const labels=[...nav.matchAll(/<span>([^<]+)<\/span>/g)].map((m)=>m[1]);
 expect(labels).toEqual(['Home','Decisions','Studio']);
 expect(nav).toContain('href="/home"');expect(nav).not.toContain('href="/"');expect(nav).toContain('href="/decisions"');expect(nav).toContain('href="/studio"');
 // Models and Usage are the account menu's, out of the work navigation.
 expect(nav).not.toContain('/models');expect(nav).not.toContain('/usage');
 const account=html.split('<details class="account">')[1].split('</details>')[0];
 expect(account).toContain('<summary>Settings</summary>');
 expect(account).toContain('href="/models"');expect(account).toContain('href="/usage"');
 // A Models page opens the menu and marks its own link current.
 const models=renderModels([],new Map(),'PAVI');
 expect(models).toContain('<details class="account" open>');
 expect(models.split('<details class="account" open>')[1]).toContain('<a href="/models" aria-current="page">Models</a>');
});

it('a project\'s area has its tabs on every page, with the page\'s own tab current',()=>{
 const tabs=(html:string,open:string)=>html.split(`<nav class="repo-tabs proj-tabs" aria-label="example">`)[1]?.split('</nav>')[0]??'';
 const names=(html:string)=>[...tabs(html,'').matchAll(/>([A-Za-z]+)<\/a>/g)].map((m)=>m[1]);
 const over=renderProject(project,[],[],'PAVI');
 expect(names(over)).toEqual(['Overview','Tasks','Flow','Plans','Code','Log','Ship','Settings']);
 expect(tabs(over,'')).toContain('href="/p/example" aria-current="page">Overview');
 expect(tabs(over,'')).toContain('href="/p/example/tasks">Tasks');
 expect(tabs(over,'')).toContain('href="/p/example/flow">Flow');
 expect(tabs(over,'')).toContain('href="/p/example/plans">Plans');
 expect(tabs(over,'')).toContain('href="/p/example/code">Code');
 expect(tabs(over,'')).toContain('href="/p/example/log">Log');
 expect(tabs(over,'')).toContain('href="/p/example/ship">Ship');
 expect(tabs(over,'')).toContain('href="/p/example/settings">Settings');
 expect(tabs(renderProjectTasks(project,[]),'')).toContain('href="/p/example/tasks" aria-current="page">Tasks');
 expect(tabs(renderProjectFlow(project,buildStory('example',[],[],'pavi'),'pavi'),'')).toContain('href="/p/example/flow" aria-current="page">Flow');
 expect(tabs(renderProjectPlans(project,[]),'')).toContain('href="/p/example/plans" aria-current="page">Plans');
 expect(tabs(renderProjectShip(project,''),'')).toContain('href="/p/example/ship" aria-current="page">Ship');
 expect(tabs(renderProjectSettings(project),'')).toContain('href="/p/example/settings" aria-current="page">Settings');
 // The area hangs from Home, and the task page sits inside it.
 expect(over.split('<aside class="rail">')[1]).toContain('href="/home" aria-current="page"');
 const task=renderItem(project,detail(),'PAVI',null);
 expect(tabs(task,'')).toContain('href="/p/example/tasks" aria-current="page">Tasks');
 expect(task).toContain('<a href="/home">Home</a>');
});

it('Tasks is one list of every task with state, holder and time; the Overview tab no longer repeats it',async()=>{
 const {renderProjectTasks}=await import('../src/ui');
 const base=detail().item;
 const items=[
  {...base,id:'t1',state:'open' as const,owner:null,updatedAt:'2026-10-06T10:00:00Z'},
  {...base,id:'t2',state:'claimed' as const,owner:'codex/gpt-6',updatedAt:'2026-10-06T11:00:00Z'},
  {...base,id:'t3',state:'submitted' as const,owner:'claude-code/opus-5.5',updatedAt:'2026-10-06T12:00:00Z'},
  {...base,id:'t4',state:'merged' as const,owner:null,updatedAt:'2026-10-06T09:00:00Z'},
 ];
 const html=renderProjectTasks(project,items);
 expect(html.match(/<ul class="task-list">/g)).toHaveLength(1);
 expect(html.match(/<li>/g)?.length).toBeGreaterThanOrEqual(4);
 const labels={t1:'Ready to start',t2:'Working',t3:'In review',t4:'Merged'};
 for(const i of items){
  expect(html).toContain(`href="/p/example/${i.id}"`);
  expect(html).toContain(`<span class="tag ${i.state==='merged'?'go':''}">${labels[i.id as keyof typeof labels]}</span>`);
  expect(html).toContain(i.owner??'No current owner');
 }
 // Live work before closed, newest first within each.
 expect(html.indexOf('href="/p/example/t3"')).toBeLessThan(html.indexOf('href="/p/example/t2"'));
 expect(html.indexOf('href="/p/example/t2"')).toBeLessThan(html.indexOf('href="/p/example/t4"'));
 expect(html).not.toContain('Completed and closed');
 // The Overview tab carries none of the old duplicate lists.
 const over=renderProject(project,items,[],'PAVI');
 for(const gone of ['Held now','<h2 class="section-title">Work</h2>','Create a task'])expect(over).not.toContain(gone);
 expect(over).toContain('Ledger events');
});

it('a task with nothing pushed shows its scope and the dispatch box, not a review shape',()=>{
 const d=detail();
 d.item={...d.item,state:'open',owner:null,head:null,base:null,fork:null,lastPushAt:null};
 const html=renderItem(project,d,'PAVI',null);
 expect(html).toContain('Send to an agent');
 expect(html).toContain('aria-label="Scope"');
 expect(html).toContain('src/**');
 expect(html).toContain('No revision pushed yet');
 expect(html).toContain('Block this task');
 for(const gone of ['id="changes"','id="checks"','id="brief"','id="thread"','required checks passed','Decision brief'])expect(html).not.toContain(gone);
 // The framing still shows, and the page keeps its history.
 d.item.nonGoals=['no CSS'];
 const framed=renderItem(project,d,'PAVI',null);
 expect(framed).toContain('How the task is framed');
 expect(framed).toContain('Task history');
});

it('the error page keeps the owner\'s name, highlights nothing, and says Go back',()=>{
 const html=renderError('Something <odd> happened.','/p/example','PAVI');
 expect(html).toContain('<strong>PAVI</strong>');
 expect(html).toContain('Something &lt;odd&gt; happened.');
 expect(html).toContain('>Go back</a>');
 // No link in the markup is current: the page does not know which page failed (finding 18).
 expect(html).not.toMatch(/<a[^>]*aria-current="page"/);
 expect(renderError('x')).not.toMatch(/<a[^>]*aria-current="page"/);
 expect(renderError('x')).toContain('Project owner');
});

it('one line about Atelier serves both the rail and the sign-in headline',()=>{
 const rail=renderProject(project,[],[],'PAVI');
 expect(rail).toContain('<p>Many agents, one owner per task.</p>');
 expect(renderLogin()).toContain('<h1>Many agents,<br>one owner per task.</h1>');
});

it('Plans draws each plan as one unit with its parts, their state and why each went to its agent',()=>{
 const when='2026-10-06T12:00:00Z';
 const route=(key:string,builder:string)=>({key,builder:{actor:builder,reasons:['Rank 1 of 3 eligible for feature work, score 0.72']},alternates:[{actor:'codex/gpt-6-astra',reasons:[]}],reviewer:{actor:'zcode/glm-5.3',reasons:[]},excluded:[],unrouted:null});
 const planItem={...detail().item,id:'t5',title:'Ship the thing',state:'submitted' as const,kind:'plan' as const,head:'c'.repeat(40)};
 const view={item:planItem,phase:'building',goal:'Ship <the> thing',scope:['src/**'],planner:'claude-code/opus-5.5',plannerReasons:['best at features'],
  blocked:null,completedAt:null,proposal:null,plan:null,
  approval:{hash:'4'.repeat(64),at:when,by:'pavi',allowPaid:false,limits:{maxParallel:3,attempts:2,maxJobs:12,deadline:when},deadline:'2026-10-08T12:00:00Z',jobsUsed:2},
  parts:[
   {id:'t6',key:'a',title:'Part <a> one',state:'submitted',owner:'claude-code/opus-5.5',head:'a'.repeat(40),acceptedHead:null,scope:['src/a/**'],dependsOn:[],dispatch:null,route:route('a','claude-code/opus-5.5'),attempts:[{actor:'codex/gpt-6-astra',outcome:'give-up' as const}],gate:{ready:true,blockers:[]},integration:null},
   {id:'t7',key:'b',title:'Part two',state:'open',owner:null,head:null,acceptedHead:null,scope:[],dependsOn:[{key:'a',id:'t6'}],dispatch:{to:'home',agent:'zcode',model:'glm-5.3',by:'atelier/orchestrator',at:when,note:''},route:route('b','zcode/glm-5.3'),attempts:[],gate:null,integration:null},
  ],
  preview:null,integration:{integrationHead:null}};
 const html=renderProjectPlans(project,[view as never],'PAVI');
 expect(html).toContain('href="/p/example/t5">t5</a>');
 expect(html).toContain('Ship &lt;the&gt; thing');
 expect(html).toContain('built by claude-code/opus-5.5: Rank 1 of 3 eligible for feature work, score 0.72');
 expect(html).toContain('reviewer zcode/glm-5.3, of another family');
 expect(html).toContain('attempts: codex/gpt-6-astra released with no commit');
 expect(html).toContain('queued for zcode/glm-5.3');
 expect(html).toContain('depends on a (t6)');
 expect(html).toContain('Approved by pavi');
 expect(html).toContain('No part is integrated yet.');
 expect(html).not.toContain('<the>');
 // With no plans the tab says how to start one.
 expect(renderProjectPlans(project,[])).toContain('No plans yet.');
});

it('a commit page marks the Log tab current and its crumb names the commit',()=>{
 const c={hash:'11a7ee68'+'0'.repeat(32),treeHash:'b'.repeat(40),message:'m',author:{name:'A',email:'a@x'},parents:[],authoredAt:1759600000};
 const commit=renderCommit({project,item:null,at:null},{commit:c,parent:null,files:[],truncated:false},'PAVI');
 expect(commit).toContain('aria-label="example">');
 expect(commit).toContain('href="/p/example/log" aria-current="page">Log');
 expect(commit).toContain('/ Commit 11a7ee68</nav>');
 expect(commit).not.toContain('href="/projects"');
});
it('each review on the task page says who recorded it (t215)',()=>{
 const diff={head,base:'b'.repeat(40),files:[],truncated:false};
 const d=detail();d.reviews=[
  {itemId:'t1',head,criteria:NO_CRITERIA,approve:true,by:'claude-code/opus-5.5',note:'own token',at:time,recordedBy:'claude-code/opus-5.5',proved:true,claimed:false},
  {itemId:'t1',head,criteria:NO_CRITERIA,approve:true,by:'antigravity/gemini-3.1-pro',note:'named by the owner',at:time,recordedBy:'pavi',proved:false,claimed:false},
  {itemId:'t1',head,criteria:NO_CRITERIA,approve:true,by:'zcode/glm-5.3',note:'served',at:time,recordedBy:'pavi',proved:false,claimed:true},
 ];
 const html=renderItem(project,d,'PAVI',diff);
 expect(html).toContain('claude-code/opus-5.5 · ');expect(html).toContain('recorded with its own token');
 expect(html).toContain('recorded by the project owner with the owner token</p>');
 expect(html).toContain('recorded by the project owner with the owner token, answering a review request it claimed');
});
