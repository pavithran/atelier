// Read-only visual fixtures; no Artifacts, tokens or live project actions.
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
const out = join(mkdtempSync(join(tmpdir(),'atelier-preview-')),'ui.mjs');
await build({entryPoints:['src/ui.ts'],bundle:true,platform:'node',format:'esm',loader:{'.css':'text'},outfile:out});
const ui = await import(pathToFileURL(out));
const head='a'.repeat(40), at='2026-10-03T23:02:00Z';
const policy={checks:['npm test','npm run typecheck'],protected:['src/rules.ts']};
const project={name:'cloudflare-git',repo:'cloudflare-git',policy,createdAt:at};
const make=(id,title,state='submitted')=>({id,title,state,scope:['src/**'],owner:'codex/gpt-6',fork:`cloudflare-git--${id}`,base:'b'.repeat(40),head,acceptedHead:state==='accepted'||state==='merged'?head:null,lastPushAt:at,updatedAt:at,createdAt:at});
const items=[make('t1','Run checks in the cloud'),make('t4','Verify the task ledger'),make('t2','Record pushes automatically','claimed')];
const evidence=policy.checks.map(claim=>({itemId:'t1',claim,grade:'observed',head,passed:true,by:'atelier/sandbox',where:'sandbox',at,changedPaths:['src/rules.ts'],outputTail:'Illustrative fixture output: all checks passed.'}));
const detail={item:items[0],policy,evidence,reviews:[],gate:{ready:false,blockers:['A protected change requires approval.'],outOfScope:[],needsAssessor:true},events:[],ownerActor:'pavi'};
const diff={base:'b'.repeat(40),head,files:[{path:'src/sandbox/runner.ts',status:'modified',added:4,removed:2,hunks:[{oldStart:1,oldLines:3,newStart:1,newLines:5,lines:[{op:' ',text:'export async function runChecks(revision: string) {'},{op:'+',text:'  const result = await executeChecks(revision);'},{op:'+',text:'  await recordEvidence(revision, result);'},{op:'-',text:'  return report;'},{op:'+',text:'  return result;'},{op:' ',text:'}'}]}]}],truncated:false};
const entries=[{project:project.name,itemId:'t1',title:items[0].title,kind:'assess',reason:'Review required',weight:80},{project:project.name,itemId:'t4',title:items[1].title,kind:'accept',reason:'Ready to accept',weight:100}];
const server=createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');let html;
  const state=url.searchParams.get('state');const d=structuredClone(detail);
  if(url.searchParams.get('task')==='t4'){d.item=items[1];d.evidence.forEach(e=>e.changedPaths=['src/ui.ts']);d.gate={...d.gate,ready:true,needsAssessor:false,blockers:[]};}
  if(state==='failed'){d.evidence[0].passed=false;d.gate.needsAssessor=false;}
  if(state==='ready'){d.gate={...d.gate,ready:true,needsAssessor:false,blockers:[]};d.evidence.forEach(e=>e.changedPaths=['src/ui.ts']);}
  if(state==='accepted'||state==='merged'){d.item.state=state;d.item.acceptedHead=head;d.gate.needsAssessor=false;}
  if(state==='long') d.item.title='Review a project with a very long title, extensive agent output, and deeply nested files that must remain readable on a phone';
  if(url.pathname==='/login') html=ui.renderLogin();
  else if(url.pathname==='/projects') html=ui.renderProjects([{project,items}],'PAVI');
  else if(url.pathname==='/history') html=ui.renderHistory([{project,items:[make('t5','Add guarded cache cleanup','merged')]}],'PAVI');
  else if(url.pathname==='/p/cloudflare-git') html=ui.renderProject(project,items,[],'PAVI');
  else if(url.pathname.startsWith('/p/')) html=ui.renderItem(project,d,'PAVI',state==='unavailable'?'unavailable':diff);
  else if(url.pathname==='/error') html=ui.renderError('This task changed since you opened it. Refresh and review the new revision.');
  else html=ui.renderInbox(state==='empty'?[]:entries,[project],'PAVI',state==='empty'?undefined:{project,detail:d,diff},[{project,items}]);
  if(url.searchParams.get('theme')==='dark') html=html.replace('@media (prefers-color-scheme: light)', '@media (width:0px)').replace('@media(prefers-color-scheme:dark)', '@media all');
  html=html.replace('</main>','<p class="meta" style="margin:32px 0 0;text-align:right">Design preview · illustrative task states · no live actions</p></main>');
  res.writeHead(req.method==='GET'?200:405,{'content-type':'text/html'});res.end(req.method==='GET'?html:'Read-only preview; no live action was taken.');
});
server.listen(Number(process.env.PORT||0),'127.0.0.1',()=>console.log(`http://127.0.0.1:${server.address().port}`));
