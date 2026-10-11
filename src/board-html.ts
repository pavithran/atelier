import { projectBoard, type BoardSnapshot } from "./board.ts";

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function renderBoard(project: string, snapshot: BoardSnapshot): string {
  return `<div class="area-board">${projectBoard(snapshot).map((a, i) => `
    <section class="task-area" aria-labelledby="area-${i}">
      <h2 id="area-${i}">${escape(a.name)} <span class="meta">${a.merged}/${a.tasks.length} merged</span></h2>
      <p class="area-purpose">${escape(a.purpose)}</p>
      ${a.tasks.length ? `<ul class="task-list">${a.tasks.map((t) => `<li>
        <a class="area-task-title" href="/p/${encodeURIComponent(project)}/${encodeURIComponent(t.item.id)}"><span class="meta">${escape(t.item.id)} · ${t.kind}${t.item.plan ? ` · ${escape(t.item.plan)}` : ""}</span><span>${escape(t.item.title)}</span></a>
        <span class="area-stage" data-stage="${t.stage}">${t.stage}</span>
        <span class="area-holder">Holder: ${escape(t.holder ?? "unheld")}</span>
      </li>`).join("")}</ul>` : '<p class="empty">No tasks.</p>'}
    </section>`).join("")}</div>`;
}
