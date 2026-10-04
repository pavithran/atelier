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
