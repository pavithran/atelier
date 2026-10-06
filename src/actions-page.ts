// The protected-actions section of a project's page: a form to approve one
// action at the main line's head as the page read it, each approval with its
// status and a Withdraw button while it stands, and the latest steps a ship
// ran. The forms post to /ui/PROJECT/actions/VERB (actionForm in
// src/actions-api.ts), with the Origin check every owner form has.

import { ACTION_KINDS, DEFAULT_EXPIRY, type ActionRun, type ApprovalView } from "./actions.ts";
import { stamp } from "./time.ts";
import { escapeText as e } from "./ui.ts";

const href = (...p: string[]) => "/" + p.map(encodeURIComponent).join("/");
const short = (sha: string) => sha.slice(0, 8);

const STATUS: Record<ApprovalView["status"], string> = {
  active: "Approved",
  consumed: "Used",
  withdrawn: "Withdrawn",
  expired: "Expired",
};

const EXPIRIES: [string, string][] = [["1h", "1 hour"], ["24h", "24 hours"], ["7d", "7 days"]];

// `head` is the baseline's head when the page was drawn, or null when it could
// not be read; the form is offered only with a head to bind the approval to.
export function renderActions(project: string, approvals: ApprovalView[], runs: (ActionRun & { at: string })[], head: string | null): string {
  const form = head
    ? `<details class="new-task"><summary>Approve an action at ${e(short(head))}</summary>
    <form method="post" action="${href("ui", project, "actions", "approve")}" class="stack">
      <input type="hidden" name="head" value="${e(head)}">
      <label>Action<input name="kind" type="text" required list="action-kinds" pattern="[a-z][a-z0-9\\-]{0,62}" maxlength="63" placeholder="deploy"></label>
      <datalist id="action-kinds">${ACTION_KINDS.map((k) => `<option value="${k}">`).join("")}</datalist>
      <label>Stands for<select name="expires">${EXPIRIES.map(([v, label]) => `<option value="${v}"${v === DEFAULT_EXPIRY ? " selected" : ""}>${label}</option>`).join("")}</select></label>
      <label>Note <span class="meta">optional</span><input name="note" type="text" maxlength="500"></label>
      <p class="meta">This approves one run of the action at <code>${e(head)}</code>, the main line's head as this page read it, and no other revision. <code>atelier ship</code> uses it once.</p>
      <button class="primary">Approve at ${e(short(head))}</button>
    </form></details>`
    : `<p class="meta">The main line's head could not be read, so no approval can be bound to it now. Reload to try again, or run <code>atelier approve KIND --head SHA --project ${e(project)}</code>.</p>`;
  const rows = approvals.slice(0, 20).map((a) => {
    const withdraw = a.status === "active"
      ? `<form method="post" action="${href("ui", project, "actions", "withdraw")}"><input type="hidden" name="id" value="${e(a.id)}"><button>Withdraw</button></form>`
      : "";
    const until = a.status === "active" ? ` · until ${e(stamp(a.expiresAt))}` : a.status === "expired" ? ` · expired ${e(stamp(a.expiresAt))}` : a.consumed ? ` · used ${e(stamp(a.consumed.at))}` : a.withdrawn ? ` · withdrawn ${e(stamp(a.withdrawn.at))}` : "";
    return `<li><code>${e(a.id)}</code><strong>${e(a.kind)} at <code>${e(short(a.commit))}</code></strong><span class="tag${a.status === "active" ? " go" : ""}">${STATUS[a.status]}</span>
      <div class="meta">approved ${e(stamp(a.at))}${until}${a.note ? ` · ${e(a.note)}` : ""}${withdraw}</div></li>`;
  }).join("");
  // Each row's first cell is the approval the step used, if it needed one.
  const ran = runs.slice(0, 10).map((r) => `<li><code>${e(r.approval ?? "")}</code><strong>${e(r.step)}</strong>${r.passed ? '<span class="tag go">Passed</span>' : '<span class="tag bad">Failed</span>'}
    <div class="meta">${r.command ? `<code>${e(r.command)}</code> · ` : ""}at <code>${e(short(r.commit))}</code> · ${(r.durationMs / 1000).toFixed(1)}s · ${e(stamp(r.at))}${r.note ? ` · ${e(r.note)}` : ""}</div></li>`).join("");
  return `<section class="standing" id="actions" aria-label="Protected actions">
  <h2 class="section-title">Protected actions</h2>
  <p class="meta">A deploy, a device install, a push to the project's own remotes, a paid model run or a Photos writeback runs only with your approval for one exact revision of the main line. Each approval is used by one run.</p>
  ${form}
  ${rows ? `<h3>Approvals</h3><ul class="standing-list">${rows}</ul>` : '<p class="empty">No action has been approved yet.</p>'}
  ${ran ? `<h3>Latest steps run</h3><ul class="standing-list">${ran}</ul>` : ""}
</section>`;
}
