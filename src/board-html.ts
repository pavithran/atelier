import { projectBoard, type BoardSnapshot } from "./board.ts";

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function renderBoard(project: string, snapshot: BoardSnapshot): string {
  const board = projectBoard(snapshot);
  return `<div class="task-board">
    <section class="board-tasks" aria-labelledby="board-h">
      <h2 id="board-h">Tasks <span class="meta">${board.merged}/${board.tasks.length} merged</span></h2>
      ${board.tasks.length ? `<ul class="task-list">${board.tasks.map((t) => `<li>
        <a class="board-task-title" href="/p/${encodeURIComponent(project)}/${encodeURIComponent(t.item.id)}"><span class="meta">${escape(t.item.id)} · ${t.kind}${t.item.plan ? ` · ${escape(t.item.plan)}` : ""}</span><span>${escape(t.item.title)}</span></a>
        <span class="board-stage" data-stage="${t.stage}">${t.stage}</span>
        <span class="board-holder">Holder: ${escape(t.holder ?? "unheld")}</span>
      </li>`).join("")}</ul>` : '<p class="empty">No tasks.</p>'}
    </section></div>`;
}
