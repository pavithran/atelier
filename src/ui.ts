// Server-rendered pages. No scripts: every action is a plain form post, so the
// page works the same in any browser and the CSP can forbid script entirely.
import theme from "./theme.css";
import type { ProjectRecord, LedgerEvent } from "./ledger";
import { evidenceAt, type Evidence, type Gate, type InboxEntry, type Item, type ProjectPolicy, type Review } from "./rules";

export function escapeText(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
const e = escapeText;
const short = (sha: string | null) => (sha ? sha.slice(0, 8) : "—");
const when = (iso: string | null) => (iso ? iso.replace("T", " ").slice(0, 16) + "Z" : "—");
const href = (...p: string[]) => "/" + p.map(encodeURIComponent).join("/");

const css = `
${theme}
*{box-sizing:border-box}
body{margin:0;background:var(--shell);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 16px 64px}
a{color:var(--signal-hot);text-decoration:none} a:hover{text-decoration:underline}
h1{font-size:22px;font-weight:600;margin:0 0 4px;color:var(--text-bright)}
h2{font-size:13px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted);margin:32px 0 8px;padding-bottom:6px;border-bottom:1px solid var(--line)}
.sub{color:var(--text-muted);margin:0 0 16px}
nav{font-size:13px;color:var(--text-dim);margin-bottom:20px} nav a{color:var(--text-muted)}
ul.rows{list-style:none;margin:0;padding:0}
ul.rows li{display:grid;grid-template-columns:92px 1fr auto;gap:12px;align-items:baseline;padding:10px 0;border-bottom:1px solid var(--line)}
.tag{font:600 11px/1 ui-monospace,"SF Mono",monospace;letter-spacing:.05em;text-transform:uppercase;padding:4px 6px;border:1px solid var(--line-bright);border-radius:3px;color:var(--text-muted);justify-self:start}
.tag.go{color:var(--observed);border-color:var(--observed-line)}
.tag.ask{color:var(--caution);border-color:var(--caution-line)}
.tag.bad{color:var(--fault);border-color:var(--fault)}
.tag.signal{color:var(--signal-hot);border-color:var(--wire)}
.meta{color:var(--text-dim);font-size:13px}
code,.mono{font:13px ui-monospace,"SF Mono",monospace}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font-weight:500;color:var(--text-muted);font-size:12px;padding:6px 8px 6px 0;border-bottom:1px solid var(--line)}
td{padding:8px 8px 8px 0;border-bottom:1px solid var(--line);vertical-align:top}
dl{display:grid;grid-template-columns:120px 1fr;gap:6px 16px;margin:0} dt{color:var(--text-muted)} dd{margin:0}
.blockers{margin:0;padding-left:18px;color:var(--caution)}
.ready{color:var(--observed)}
pre{background:var(--inset);border:1px solid var(--line);padding:8px;overflow:auto;max-height:200px;font-size:12px;margin:6px 0 0}
form.act{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0}
input[type=text],input[type=password]{background:var(--inset);color:var(--text);border:1px solid var(--line-bright);border-radius:4px;padding:6px 8px;font:inherit;min-width:220px}
button{font:inherit;padding:6px 12px;border-radius:4px;border:1px solid var(--line-bright);background:var(--surface-raised);color:var(--text);cursor:pointer}
button.primary{background:var(--signal);border-color:var(--signal);color:var(--on-accent);font-weight:600}
button.danger{color:var(--fault)}
.empty{color:var(--text-muted);padding:16px 0}
@media (max-width:600px){ul.rows li{grid-template-columns:1fr}dl{grid-template-columns:1fr}}
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(title)}</title><style>${css}</style></head><body><main>${body}</main></body></html>`;
}

const KIND: Record<InboxEntry["kind"], [string, string]> = {
  accept: ["Accept", "go"],
  merge: ["Merge", "signal"],
  assess: ["Assess", "ask"],
  scope: ["Scope", "ask"],
  stale: ["Stale", "ask"],
  overlap: ["Overlap", "ask"],
  failing: ["Failing", "bad"],
};

export function renderLogin(error?: string): string {
  return page("Atelier", `<h1>Atelier</h1><p class="sub">Paste the server token (Keychain: <code>atelier.API_TOKEN</code>).</p>
${error ? `<p class="tag bad">${e(error)}</p>` : ""}
<form class="act" method="post" action="/login"><input type="password" name="token" autocomplete="current-password" required><button class="primary">Sign in</button></form>`);
}

export function renderInbox(entries: InboxEntry[], projects: ProjectRecord[]): string {
  // One row per item: the most urgent reason leads, the others follow it.
  const groups = new Map<string, InboxEntry[]>();
  for (const x of entries) {
    const key = `${x.project}/${x.itemId}`;
    groups.set(key, [...(groups.get(key) ?? []), x]);
  }
  const rows = [...groups.values()].map(([lead, ...more]) => {
    const [label, tone] = KIND[lead.kind];
    const extra = more.map((m) => `<br><span class="tag ${KIND[m.kind][1]}">${KIND[m.kind][0]}</span> <span class="meta">${e(m.reason)}</span>`).join("");
    return `<li><span class="tag ${tone}">${label}</span>
<span><a href="${href("p", lead.project, lead.itemId)}">${e(lead.title)}</a><br><span class="meta">${e(lead.project)} · ${e(lead.itemId)} · ${e(lead.reason)}</span>${extra}</span><span></span></li>`;
  }).join("");
  const list = projects.map((p) => `<li><span class="tag">Project</span><span><a href="${href("p", p.name)}">${e(p.name)}</a><br>
<span class="meta">checks: ${p.policy.checks.map((c) => `<code>${e(c)}</code>`).join(", ") || "none"} · protected: ${p.policy.protected.map((c) => `<code>${e(c)}</code>`).join(", ") || "none"}</span></span><span></span></li>`).join("");
  return page("Atelier", `<h1>What needs PAVI now?</h1>
<p class="sub">${groups.size ? `${groups.size} item${groups.size === 1 ? "" : "s"}, most urgent first.` : "Nothing. Agents are working or idle; nothing is waiting on you."}</p>
${groups.size ? `<ul class="rows">${rows}</ul>` : ""}
<h2>Projects</h2>
${projects.length ? `<ul class="rows">${list}</ul>` : `<p class="empty">No projects yet. In a project checkout, run <code>atelier init</code>.</p>`}`);
}

const STATE_TONE: Record<string, string> = { open: "", claimed: "signal", submitted: "ask", accepted: "go", merged: "go", abandoned: "bad" };

export function renderProject(p: ProjectRecord, items: Item[], events: LedgerEvent[]): string {
  const rows = items.map((i) => `<li><span class="tag ${STATE_TONE[i.state]}">${i.state}</span>
<span><a href="${href("p", p.name, i.id)}">${e(i.title)}</a><br><span class="meta">${e(i.id)} · ${i.owner ? `owner ${e(i.owner)}` : "unowned"} · head <span class="mono">${short(i.head)}</span>${i.scope.length ? ` · scope ${i.scope.map((s) => `<code>${e(s)}</code>`).join(" ")}` : ""}</span></span>
<span class="meta">${when(i.updatedAt)}</span></li>`).join("");
  return page(`${p.name} · Atelier`, `<nav><a href="/">Inbox</a> / ${e(p.name)}</nav>
<h1>${e(p.name)}</h1><p class="sub">Baseline repo <code>${e(p.repo)}</code></p>
<dl>
<dt>Checks</dt><dd>${p.policy.checks.map((c) => `<code>${e(c)}</code>`).join("<br>") || "none"}</dd>
<dt>Protected</dt><dd>${p.policy.protected.map((c) => `<code>${e(c)}</code>`).join(" ") || "none"}</dd>
<dt>Eligible</dt><dd>${p.policy.eligible?.length ? p.policy.eligible.map((c) => e(c)).join(", ") : "any agent"}</dd>
<dt>Overlap</dt><dd>${p.policy.refuseOverlap ? "overlapping claims are refused" : "overlapping claims are flagged"}</dd>
${p.policy.approval ? `<dt>Approval</dt><dd>${e(p.policy.approval)}</dd>` : ""}
</dl>
<h2>Items</h2>${items.length ? `<ul class="rows">${rows}</ul>` : `<p class="empty">No items. Create one with <code>atelier new "title" --scope 'src/**'</code>.</p>`}
<h2>Ledger</h2>${eventTable(events, true)}`);
}

function eventTable(events: LedgerEvent[], withItem = false): string {
  if (!events.length) return `<p class="empty">No events yet.</p>`;
  return `<table><tr><th>When</th>${withItem ? "<th>Item</th>" : ""}<th>Who</th><th>What</th><th>Detail</th></tr>${events.map((v) => `<tr>
<td class="meta">${when(v.at)}</td>${withItem ? `<td>${e(v.itemId ?? "")}</td>` : ""}<td>${e(v.actor)}</td><td><code>${e(v.kind)}</code></td>
<td class="meta">${e(summarise(v.data))}</td></tr>`).join("")}</table>`;
}

function summarise(d: Record<string, unknown>): string {
  return Object.entries(d)
    .map(([k, v]) => `${k}: ${typeof v === "string" && /^[0-9a-f]{40}$/.test(v) ? v.slice(0, 8) : JSON.stringify(v)}`)
    .join(" · ")
    .slice(0, 240);
}

export function renderItem(
  p: ProjectRecord,
  d: { item: Item; policy: ProjectPolicy; evidence: Evidence[]; reviews: Review[]; gate: Gate; events: LedgerEvent[] },
): string {
  const { item, gate } = d;
  const view = evidenceAt(d.policy, d.evidence, item.head);
  const action = (verb: string) => href("ui", p.name, item.id, verb);
  const checks = view.checks.map((c) => {
    const [label, tone] = c.grade === "pending" ? ["Pending", "ask"] : c.passed ? ["Observed ✓", "go"] : ["Observed ✗", "bad"];
    const last = d.evidence.filter((x) => x.claim === c.claim && x.head === item.head && x.grade === "observed").pop();
    return `<tr><td><span class="tag ${tone}">${label}</span></td><td><code>${e(c.claim)}</code>${last?.outputTail ? `<pre>${e(last.outputTail.slice(-1500))}</pre>` : ""}</td><td class="meta">${last ? `${e(last.by)}<br>${when(last.at)}` : ""}</td></tr>`;
  }).join("");
  const reports = view.reports.map((r) => `<tr><td><span class="tag">Reported</span></td><td>${e(r.claim)}</td><td class="meta">${e(r.by)}<br>${when(r.at)}</td></tr>`).join("");
  const reviews = d.reviews.filter((r) => r.head === item.head).map((r) => `<tr><td><span class="tag ${r.approve ? "go" : "bad"}">${r.approve ? "Approved" : "Rejected"}</span></td><td>${e(r.note || "—")}</td><td class="meta">${e(r.by)}<br>${when(r.at)}</td></tr>`).join("");
  const live = item.state === "claimed" || item.state === "submitted";
  return page(`${item.id} · ${p.name}`, `<nav><a href="/">Inbox</a> / <a href="${href("p", p.name)}">${e(p.name)}</a> / ${e(item.id)}</nav>
<h1>${e(item.title)}</h1>
<p class="sub"><span class="tag ${STATE_TONE[item.state]}">${item.state}</span> ${item.owner ? `owned by <strong>${e(item.owner)}</strong>` : "unowned"}</p>
<dl>
<dt>Workspace</dt><dd><code>${e(item.fork ?? "not forked yet")}</code></dd>
<dt>Forked at</dt><dd class="mono">${short(item.base)}</dd>
<dt>Head</dt><dd class="mono">${short(item.head)} <span class="meta">(read from Artifacts, ${item.lastPushAt ? `last push ${when(item.lastPushAt)}` : "no push yet"})</span></dd>
<dt>Scope</dt><dd>${item.scope.length ? item.scope.map((s) => `<code>${e(s)}</code>`).join(" ") : "unscoped"}</dd>
<dt>Changes</dt><dd>${view.changedPaths ? (view.changedPaths.length ? view.changedPaths.slice(0, 30).map((s) => `<code>${e(s)}</code>`).join(" ") : "none") : `<span class="meta">not yet observed</span>`}${gate.outOfScope.length ? `<br><span class="tag ask">Out of scope</span> ${gate.outOfScope.map((s) => `<code>${e(s)}</code>`).join(" ")}` : ""}</dd>
</dl>

<h2>Gate</h2>
${gate.ready ? `<p class="ready">Ready to accept: every required check observed passing at this head.</p>` : `<ul class="blockers">${gate.blockers.map((b) => `<li>${e(b)}</li>`).join("")}</ul>`}
${item.state === "submitted" ? `<form class="act" method="post" action="${action("accept")}"><button class="primary"${gate.ready ? "" : " disabled"}>Accept ${short(item.head)}</button></form>` : ""}
${item.state === "accepted" ? `<p>Accepted at <span class="mono">${short(item.acceptedHead)}</span>. In the project checkout, run <code>atelier merge ${e(item.id)}</code>.</p>` : ""}

<h2>Evidence at this head</h2>
${checks || reports ? `<table><tr><th>Grade</th><th>Claim</th><th>By</th></tr>${checks}${reports}</table>` : `<p class="empty">No required checks for this project and nothing reported.</p>`}

<h2>Reviews at this head</h2>
${reviews ? `<table><tr><th>Verdict</th><th>Note</th><th>By</th></tr>${reviews}</table>` : `<p class="empty">No reviews of this head.</p>`}
${live && item.head ? `<form class="act" method="post" action="${action("approve")}"><input type="text" name="note" placeholder="Note (optional)"><button>Approve as PAVI</button><button formaction="${action("reject")}" class="danger">Reject</button></form>` : ""}

${live ? `<h2>Ownership</h2>
<form class="act" method="post" action="${action("handoff")}"><input type="text" name="to" placeholder="harness/model, e.g. codex/gpt-5.5" required><input type="text" name="note" placeholder="Why"><button>Hand off</button></form>
<form class="act" method="post" action="${action("release")}"><input type="text" name="note" placeholder="Why"><button>Release to unowned</button></form>` : ""}
${item.state !== "merged" && item.state !== "abandoned" ? `<form class="act" method="post" action="${action("abandon")}"><input type="text" name="note" placeholder="Why abandon"><button class="danger">Abandon</button></form>` : ""}

<h2>Provenance</h2>${eventTable(d.events)}`);
}
