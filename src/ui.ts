import theme from "./theme.css";
import layout from "./layout.css";
import type { ProjectRecord, LedgerEvent } from "./ledger";
import type { FileChange, ItemDiff } from "./diff";
import { decisionFor, evidenceAt, latestReviews, stateLabel, type Evidence, type Gate, type InboxEntry, type Item, type ProjectPolicy, type Review } from "./rules";

export function escapeText(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
const e = escapeText;
const short = (sha: string | null) => sha ? sha.slice(0, 8) : "—";
const when = (iso: string | null) => iso ? iso.replace("T", " ").slice(0, 16) + " UTC" : "—";
const href = (...p: string[]) => "/" + p.map(encodeURIComponent).join("/");
const selectedHref = (project: string, task: string) => `/?project=${encodeURIComponent(project)}&task=${encodeURIComponent(task)}#review`;
const icon = (name: string) => `<svg aria-hidden="true" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${({decisions:'<path d="M7 3h8l4 4v14H5V3h2Zm7 0v5h5M9 12h6m-6 4h6"/>',projects:'<path d="M3 6h7l2 3h9v11H3V6Z"/>',history:'<circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/>',arrow:'<path d="m9 6 6 6-6 6"/>',check:'<path d="m5 12 4 4L19 6"/>'} as Record<string,string>)[name] ?? ''}</svg>`;

function page(title: string, body: string, active = "Decisions", ownerName: string | null = null): string {
  const nav = [["Decisions", "/", "decisions"], ["Projects", "/projects", "projects"], ["History", "/history", "history"]];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${e(title)} · Atelier</title><style>${theme}\n${layout}</style></head><body><!--
THESIS: Put the next human decision beside its evidence.
OWN-WORLD: Warm ivory, charcoal and copper; a quiet studio for Git-backed work.
STORY: Choose a task, inspect its changes, decide, then complete the local merge.
FIRST VIEWPORT: A narrow navigation rail, decision queue and generous review canvas; task title and revision context precede action.
FORM: User-pinned decision-centered direction, no random seed. One generated composition is a working reference; specific image approval is not recorded.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md
-->
<a class="skip" href="#main">Skip to content</a><aside class="rail"><a class="brand" href="/">Atelier</a><nav aria-label="Main navigation">${nav.map(([label,url,glyph])=>`<a href="${url}"${label === active ? ' aria-current="page"' : ''}>${icon(glyph)}<span>${label}</span></a>`).join("")}</nav><div class="rail-foot"><span class="avatar">${e((ownerName || "P").slice(0,1))}</span><strong>${e(ownerName || "Project owner")}</strong><p>Git-backed work.<br>Decisions with evidence.</p></div></aside>
<main id="main">${body}</main></body></html>`;
}

export interface Detail { ownerActor?: string; item: Item; policy: ProjectPolicy; evidence: Evidence[]; reviews: Review[]; gate: Gate; events: LedgerEvent[] }
export interface ReviewContext { project: ProjectRecord; detail: Detail; diff: ItemDiff | "unavailable" | null }
export interface ProjectView { project: ProjectRecord; items: Item[]; unavailable?: boolean }
const KIND: Record<InboxEntry["kind"], [string,string]> = { accept:["Ready to accept","go"],merge:["Ready to merge","go"],assess:["Review required","ask"],scope:["Scope changed","ask"],stale:["Needs a handoff","ask"],overlap:["Overlapping work","ask"],failing:["Checks failed","bad"] };
const tag = (label: string, tone = "") => `<span class="tag ${tone}">${e(label)}</span>`;

export function renderLogin(error?: string): string {
  return page("Sign in", `<section class="login"><h1>Your work,<br>ready for a decision.</h1><p class="lead">Atelier brings agent work, checks, and approvals into one place.</p><form method="post" action="/login" class="login-form"><h2>Sign in to Atelier</h2>${error?`<p role="alert" class="error">${e(error)}</p>`:''}<label for="token">Server token</label><input id="token" type="password" name="token" autocomplete="current-password" required><p class="meta">Use the token stored in your Keychain as <code>atelier.API_TOKEN</code>.</p><button class="primary">Sign in</button></form></section>`, "");
}

export function renderInbox(entries: InboxEntry[], projects: ProjectRecord[], ownerName: string | null = null, selected?: ReviewContext, projectViews: ProjectView[] = []): string {
  const groups = new Map<string, InboxEntry[]>();
  for (const x of entries) { const key=`${x.project}/${x.itemId}`; groups.set(key,[...(groups.get(key)??[]),x]); }
  const rows = [...groups.values()].map(([lead,...more]) => {
    const [label,tone]=KIND[lead.kind]; const current=selected?.project.name===lead.project && selected.detail.item.id===lead.itemId;
    return `<li><a class="decision-row${current?' selected':''}" href="${selectedHref(lead.project,lead.itemId)}"${current?' aria-current="true"':''}>${icon('decisions')}<span><strong>${e(lead.title)}</strong><span class="meta">${e(lead.project)} · ${e(lead.itemId)}</span>${more.length?`<span class="meta">${more.map(m=>e(KIND[m.kind][0])).join(' · ')}</span>`:''}</span>${tag(label,tone)}${icon('arrow')}</a></li>`;
  }).join('');
  const needs = new Set(entries.map(x=>`${x.project}/${x.itemId}`));
  const working=projectViews.flatMap(({project,items})=>items.filter(i=>i.state==='claimed'&&!needs.has(`${project.name}/${i.id}`)).map(item=>({project,item})));
  return page("Decisions", `<div class="desk"><section class="queue"><header><h1>Decisions</h1><p class="lead">${groups.size?`${groups.size} decision${groups.size===1?' needs':'s need'} your attention.`:'Nothing is waiting on you.'}</p></header><h2 class="section-title">Needs your attention</h2>${rows?`<ul class="decision-list">${rows}</ul>`:`<div class="empty"><h3>You’re clear.</h3><p>New reviews and blockers will appear here. <a href="/projects">See project work</a>.</p></div>`}
${working.length?`<h2 class="section-title">Working</h2><ul class="decision-list">${working.map(({project,item})=>`<li><a class="decision-row" href="${href('p',project.name,item.id)}">${icon('decisions')}<span><strong>${e(item.title)}</strong><span class="meta">${e(project.name)} · ${e(item.owner??'Unassigned')}</span></span>${icon('arrow')}</a></li>`).join('')}</ul>`:''}
${projectViews.some(p=>p.unavailable)?'<p role="status" class="error">Some projects could not be read. Refresh to try again; this list may be incomplete.</p>':''}
${!projects.length?'<div class="empty"><h3>Bring your first project.</h3><p>In its checkout, run <code>atelier init</code> to register it.</p></div>':''}</section>
${selected?`<section class="review-sheet" id="review" aria-label="Selected task">${reviewBody(selected,ownerName)}</section>`:`<section class="review-sheet resting"><div>${icon('check')}<h2>Space to focus.</h2><p>Select a decision to see the changes, the evidence, and your next action.</p><a href="/projects">Explore projects</a></div></section>`}</div>`,"Decisions",ownerName);
}

export function renderProjects(views: ProjectView[], ownerName: string | null = null): string {
  return page("Projects",`<div class="page-width"><header><h1>Projects</h1><p class="lead">Work in motion, with a clear owner for every task.</p></header><ul class="project-list">${views.map(({project,items,unavailable})=>`<li><a href="${href('p',project.name)}"><h2>${e(project.name)}</h2><p>${unavailable?'Temporarily unavailable. Open to retry.':`${items.filter(i=>['claimed','submitted','accepted'].includes(i.state)).length} active · ${items.filter(i=>i.state==='open').length} ready to start · ${items.filter(i=>i.state==='merged').length} merged`}</p>${icon('arrow')}</a></li>`).join('')}</ul>${!views.length?'<div class="empty"><h2>Start with one project.</h2><p>Run <code>atelier init</code> in its local checkout. It will appear here.</p></div>':''}</div>`,"Projects",ownerName);
}

function taskRows(p: ProjectRecord, items: Item[]): string {
 return `<ul class="task-list">${items.map(i=>`<li><a href="${href('p',p.name,i.id)}"><span><strong>${e(i.title)}</strong><span class="meta">${e(i.id)} · ${e(i.owner??'No current owner')}</span></span>${tag(stateLabel[i.state],i.state==='merged'?'go':'')}<time class="meta">${when(i.updatedAt)}</time>${icon('arrow')}</a></li>`).join('')}</ul>`;
}
export function renderProject(p: ProjectRecord, items: Item[], events: LedgerEvent[], ownerName: string | null = null): string {
  const live=items.filter(i=>!['merged','abandoned'].includes(i.state));const done=items.filter(i=>['merged','abandoned'].includes(i.state));
  return page(p.name,`<div class="page-width"><nav class="breadcrumbs"><a href="/projects">Projects</a> / ${e(p.name)}</nav><header><h1>${e(p.name)}</h1><p class="lead">${live.length} active or planned task${live.length===1?'':'s'}.</p></header><details class="new-task"><summary>Create a task</summary><form method="post" action="${href('ui',p.name,'new')}" class="stack"><label>What should change?<input name="title" type="text" required maxlength="300" placeholder="Describe the outcome"></label><label>Files in scope<input name="scope" type="text" placeholder="src/**, test/**"></label><p class="meta">Separate patterns with commas. Leave empty for unrestricted scope.</p><button class="primary">Create task</button></form></details><h2 class="section-title">Work</h2>${live.length?taskRows(p,live):'<p class="empty">No active tasks. Create one above.</p>'}${done.length?`<details class="disclosure"><summary>Completed and closed · ${done.length}</summary>${taskRows(p,done)}</details>`:''}<details class="disclosure"><summary>Project policy</summary><dl><dt>Required checks</dt><dd>${p.policy.checks.map(c=>`<code>${e(c)}</code>`).join('<br>')||'None configured'}</dd><dt>Protected files</dt><dd>${p.policy.protected.map(e).join(', ')||'None configured'}</dd><dt>Check execution</dt><dd>${p.policy.sandboxOnly?'Cloudflare sandbox required':'Local or Cloudflare sandbox'}</dd><dt>Eligible agents</dt><dd>${p.policy.eligible?.map(e).join(', ')||'Any agent'}</dd><dt>Overlap</dt><dd>${p.policy.refuseOverlap?'Refused':'Flagged for review'}</dd><dt>Baseline</dt><dd><code>${e(p.repo)}</code></dd></dl></details><details class="disclosure"><summary>Activity</summary>${eventTable(events,true)}</details></div>`,"Projects",ownerName);
}

export function renderHistory(views: ProjectView[], ownerName: string | null = null): string {
  const completed=views.flatMap(({project,items})=>items.filter(i=>['merged','abandoned'].includes(i.state)).map(item=>({project,item}))).sort((a,b)=>b.item.updatedAt.localeCompare(a.item.updatedAt));
  return page('History',`<div class="page-width"><header><h1>History</h1><p class="lead">Finished work, with its evidence intact.</p></header>${views.some(v=>v.unavailable)?'<p class="error">Some project history is unavailable. Refresh to retry.</p>':''}<ul class="task-list">${completed.map(({project,item})=>`<li><a href="${href('p',project.name,item.id)}"><span><strong>${e(item.title)}</strong><span class="meta">${e(project.name)} · ${e(item.id)}</span></span>${tag(stateLabel[item.state],item.state==='merged'?'go':'')}<time class="meta">${when(item.updatedAt)}</time>${icon('arrow')}</a></li>`).join('')}</ul>${!completed.length?'<p class="empty">Completed tasks will appear here after they merge or close.</p>':''}</div>`,"History",ownerName);
}

function eventTable(events: LedgerEvent[], withItem=false): string {
  if(!events.length)return '<p class="empty">No activity recorded yet.</p>';
  return `<ol class="timeline">${events.map(v=>`<li><span class="timeline-dot"></span><div><strong>${e(v.kind.replaceAll('.',' ').replaceAll('_',' '))}</strong>${withItem&&v.itemId?` · ${e(v.itemId)}`:''}<p class="meta">${e(v.actor)} · ${when(v.at)}</p><details><summary>Details</summary><pre>${e(JSON.stringify(v.data,null,2))}</pre></details></div></li>`).join('')}</ol>`;
}

export function renderItem(p: ProjectRecord,d: Detail,ownerName: string|null=null,diff: ItemDiff|"unavailable"|null=null): string {
  return page(d.item.title,`<div class="page-width"><nav class="breadcrumbs"><a href="/">Decisions</a> / <a href="${href('p',p.name)}">${e(p.name)}</a> / ${e(d.item.id)}</nav><article class="review-sheet standalone" id="review">${reviewBody({project:p,detail:d,diff},ownerName)}</article></div>`,d.item.state==='merged'||d.item.state==='abandoned'?'History':'Decisions',ownerName);
}

function reviewBody({project:p,detail:d,diff}:ReviewContext,ownerName:string|null):string {
 const {item,gate}=d,view=evidenceAt(d.policy,d.evidence,item.head),decision=decisionFor(item,d.policy,d.evidence,d.reviews,d.ownerActor);
 const live=['claimed','submitted'].includes(item.state), action=(verb:string)=>href('ui',p.name,item.id,verb);
 const revision=`<input type="hidden" name="head" value="${e(item.head??'')}">`;
 const reject=live&&item.head?`<details class="request-changes"><summary>Request changes</summary><form class="stack" method="post" action="${action('reject')}">${revision}<label>What needs to change?<textarea name="note" required rows="3" maxlength="2000"></textarea></label><button>Send review</button></form></details>`:'';
 const evidenceVisible=!!diff&&diff!=="unavailable"&&diff.head===item.head;
 const evidenceNotice=live&&item.head&&!evidenceVisible?`<div class="notice" role="status"><h3>${diff&&diff!=="unavailable"?"The displayed revision has changed":"Changes are unavailable"}</h3><p>Approval and acceptance are unavailable until the displayed changes match this task’s recorded revision. <a href="${href('p',p.name,item.id)}">Reload this task</a>. If the revision changed, the task owner should run <code>atelier push</code> and rerun checks.</p></div>`:'';
 const approve=evidenceVisible&&live&&item.head&&(decision.action==='review'||latestReviews(d.reviews,item.head).some(r=>!r.approve))?`<form method="post" action="${action('approve')}">${revision}<button class="primary">Approve revision</button></form>`:'';
 const accept=evidenceVisible&&decision.action==='accept'?`<form method="post" action="${action('accept')}">${revision}<button class="primary">Accept revision</button></form>`:'';
 const shell=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
 const merge=decision.action==='merge'?`<div class="merge-command"><p>In the registered checkout, run:</p><pre tabindex="0">${e(`atelier land ${item.id} --project ${shell(p.name)} --head ${item.acceptedHead}`)}</pre><p class="meta">This merges the approved revision and records the result. It does not deploy.</p></div>`:'';
 const allChecks=view.checks.length>0&&view.checks.every(c=>c.grade==='observed'&&c.passed);
 return `<header class="review-header"><h2>${e(item.title)}</h2><p class="context">${e(p.name)} · ${e(item.id)} · ${e(stateLabel[item.state])}</p><p class="review-description">${e(decision.detail)}</p><p class="decision-status ${decision.tone}">${allChecks?`${icon('check')}<span>Checks passed</span><span aria-hidden="true">·</span>`:''}<strong>${e(decision.title)}</strong></p>${evidenceNotice}<div class="actions">${approve}${accept}${reject}</div>${merge}<p class="meta revision">Revision <code>${short(item.head)}</code>${item.owner?` · ${e(item.owner)}`:''}</p></header>
<nav class="review-nav" aria-label="In this review"><a href="#changes">Changes</a><a href="#checks">Checks</a><a href="#history">History</a></nav>
<section id="changes" class="review-section"><h3>Changes</h3>${renderDiff(diff,item.head)}${gate.outOfScope.length?`<details class="notice"><summary>Scope changed · ${gate.outOfScope.length} file${gate.outOfScope.length===1?'':'s'}</summary><p>These changes extend beyond the original task scope. Include them in your review.</p><ul>${gate.outOfScope.map(f=>`<li><code>${e(f)}</code></li>`).join('')}</ul></details>`:''}${gate.needsAssessor?'<div class="notice"><h3>Protected change</h3><p>These files affect protected behavior. Approval from you or an independent reviewer is required.</p></div>':''}</section>
<section id="checks" class="review-section"><h3>Checks and reviews</h3><p class="meta">${decision.passed} of ${view.checks.length} required checks passed at this revision.</p>${view.checks.map(c=>{const last=d.evidence.filter(x=>x.head===item.head&&x.claim===c.claim&&x.grade==='observed'&&(!d.policy.sandboxOnly||x.where==='sandbox')).sort((a,b)=>a.at.localeCompare(b.at)).pop();return `<details class="check-row"${c.passed===false?' open':''}><summary>${tag(c.grade==='pending'?'Waiting':c.passed?'Passed':'Failed',c.grade==='pending'?'ask':c.passed?'go':'bad')}<code>${e(c.claim)}</code></summary><p class="meta">${last?`${e(last.by)} · ${last.where==='sandbox'?'Cloudflare sandbox':'Local check runner'} · ${when(last.at)}`:'The task owner must run this required check.'}</p>${last?.outputTail?`<pre tabindex="0">${e(last.outputTail)}</pre>`:''}</details>`;}).join('')}${!view.checks.length?'<p class="meta">No required checks are configured.</p>':''}${view.reports.length?`<details class="disclosure"><summary>Agent reports · ${view.reports.length}</summary><p class="meta">Reported by an agent; these do not satisfy required checks.</p>${view.reports.map(r=>`<p>${e(r.claim)}</p>`).join('')}</details>`:''}${latestReviews(d.reviews,item.head).map(r=>`<div class="review-note">${tag(r.approve?'Approved':'Changes requested',r.approve?'go':'ask')}<p>${e(r.note||'No note provided.')}</p><p class="meta">${e(r.by)} · ${when(r.at)}</p></div>`).join('')}${live&&!gate.ready?`<details class="disclosure"><summary>Readiness details</summary><ul>${gate.blockers.map(b=>`<li>${e(b)}</li>`).join('')}</ul></details>`:''}</section>
<details class="disclosure" id="history"><summary>Task history</summary>${eventTable(d.events)}</details>
<details class="disclosure"><summary>Technical details${live?' and ownership':''}</summary><dl><dt>Workspace</dt><dd><code>${e(item.fork??'Not created')}</code></dd><dt>Forked at</dt><dd><code>${short(item.base)}</code></dd><dt>Scope</dt><dd>${item.scope.map(e).join(', ')||'Unrestricted'}</dd><dt>Last push</dt><dd>${when(item.lastPushAt)}</dd></dl>${live?`<form class="stack" method="post" action="${action('handoff')}">${revision}<label>New owner<input type="text" name="to" required placeholder="harness/model"></label><label>Handoff note<input type="text" name="note"></label><button>Hand off task</button></form><form method="post" action="${action('release')}">${revision}<button>Release task</button></form>`:''}${!['merged','abandoned'].includes(item.state)?`<form class="stack" method="post" action="${action('abandon')}">${revision}<label>Reason for closing<input type="text" name="note" required></label><button class="danger">Close task without merging</button></form>`:''}</details>`;
}

export function renderError(message:string,back='/'):string {
 return page('Action needs attention',`<section class="page-width error-page"><h1>Let’s resolve this.</h1><p class="lead" role="alert">${e(message)}</p><p>Return to the current task, refresh its evidence, and try the available action again.</p><a class="button" href="${e(back)}">Return to work</a></section>`);
}
const STATUS: Record<FileChange["status"], [string, string]> = {
  added: ["Added", "go"],
  deleted: ["Deleted", "bad"],
  modified: ["Modified", "signal"],
  mode: ["Mode", ""],
  binary: ["Binary", ""],
  "too-large": ["Too large", "ask"],
};

// Each line keeps its +, - or space, so the diff reads without colour.
function renderFile(f: FileChange, open: boolean): string {
  const [label, tone] = STATUS[f.status];
  const counts = f.added || f.removed ? `<span class="counts">+${f.added} −${f.removed}</span>` : "";
  const note = f.status === "binary" ? "Binary file; not shown." : f.status === "too-large" ? "Too large to diff here; use <code>atelier diff</code>." : f.status === "mode" ? "Only the file mode changed." : "";
  const body = f.hunks.length
    ? `<pre class="diff" tabindex="0">${f.hunks.map((h) =>
        `<span class="hunk">@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@</span>` +
        h.lines.map((l) => `<span class="${l.op === "+" ? "add" : l.op === "-" ? "del" : ""}">${l.op}${e(l.text)}</span>`).join("")).join("")}</pre>`
    : note ? `<p class="meta" style="padding:0 10px 8px;margin:0">${note}</p>` : "";
  return `<details class="file"${open ? " open" : ""}><summary><span class="tag ${tone}">${label}</span><code>${e(f.path)}</code>${counts}</summary>${body}</details>`;
}

function renderDiff(diff: ItemDiff | "unavailable" | null, recordedHead: string | null): string {
  if (diff === "unavailable") return `<p class="empty">The diff could not be read from Artifacts just now. <code>atelier diff</code> shows it from a clean clone.</p>`;
  if (!diff) return `<p class="empty">No workspace yet, so nothing to compare.</p>`;
  if (!diff.files.length) return `<p class="empty">No changes: the workspace is at <span class="mono">${short(diff.head)}</span>, the same as the baseline.</p>`;
  const added = diff.files.reduce((n, f) => n + f.added, 0), removed = diff.files.reduce((n, f) => n + f.removed, 0);
  const moved = recordedHead && recordedHead !== diff.head
    ? `<p><span class="tag ask">Unrecorded</span> Artifacts holds <span class="mono">${short(diff.head)}</span>, newer than the recorded head <span class="mono">${short(recordedHead)}</span>; the owner has pushed without running <code>atelier push</code>.</p>`
    : "";
  return `${moved}<p class="meta">${diff.files.length}${diff.truncated ? "+" : ""} file${diff.files.length === 1 ? "" : "s"} changed, +${added} −${removed}, from <span class="mono">${short(diff.base)}</span> to <span class="mono">${short(diff.head)}</span>.${diff.truncated ? " Only the first files are listed; <code>atelier diff</code> shows the rest." : ""}</p>
${diff.files.map((f) => renderFile(f, diff.files.length <= 8)).join("")}`;
}
