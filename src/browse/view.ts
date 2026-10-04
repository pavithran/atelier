// The browsing pages: a directory, a file, the log, a commit and a path's
// history, for a project's baseline or one task's fork. Server-rendered, no
// script, every value escaped. `Where` names the repository being read and
// builds every link, so a link never leaves the repository it came from.

import { escapeText as e, page, renderFile, titleOf } from "../ui.ts";
import type { ProjectRecord } from "../ledger.ts";
import { HISTORY_CAP, READABLE, type Commit, type FileChange, type FileView, type Node } from "./repo.ts";

export interface Where {
  project: ProjectRecord;
  item: string | null;        // a task id, or null for the baseline
  at: string | null;          // a commit hash from ?at=, or null for the head
}

const enc = (s: string) => encodeURIComponent(s);
const root = (w: Where) => `/p/${enc(w.project.name)}${w.item ? `/${enc(w.item)}` : ""}`;
const atQuery = (w: Where) => (w.at ? `?at=${enc(w.at)}` : "");
export const codeHref = (w: Where, path: string[]) => `${root(w)}/code${path.map((p) => "/" + enc(p)).join("")}${atQuery(w)}`;
export const logHref = (w: Where, page = 0) => `${root(w)}/log${w.at || page ? `?${[w.at ? `at=${enc(w.at)}` : "", page ? `page=${page}` : ""].filter(Boolean).join("&")}` : ""}`;
export const commitHref = (w: Where, hash: string) => `${root(w)}/commit/${enc(hash)}`;
export const historyHref = (w: Where, path: string[]) => `${root(w)}/history${path.map((p) => "/" + enc(p)).join("")}${atQuery(w)}`;

const short = (h: string) => h.slice(0, 8);
const day = (seconds: number) => new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
const firstLine = (m: string) => m.split("\n")[0];

function frame(w: Where, title: string, tab: "code" | "log" | "commit", head: Commit | null, body: string, ownerName: string | null): string {
  const name = titleOf(w.project);
  const crumbs = `<nav class="breadcrumbs"><a href="/projects">Projects</a> / <a href="/p/${enc(w.project.name)}">${e(name)}</a>${
    w.item ? ` / <a href="/p/${enc(w.project.name)}/${enc(w.item)}">${e(w.item)}</a>` : ""} / ${e(title)}</nav>`;
  const what = w.item ? `${e(w.item)}'s fork` : "the baseline";
  const tabs = `<nav class="repo-tabs" aria-label="Repository"><a href="${codeHref(w, [])}"${tab === "code" ? ' aria-current="page"' : ""}>Code</a><a href="${logHref(w)}"${tab === "log" ? ' aria-current="page"' : ""}>Log</a></nav>`;
  const at = head ? `<p class="meta repo-at">${w.at ? "At" : "Head of"} ${what}: <a class="mono" href="${commitHref(w, head.hash)}">${short(head.hash)}</a> · ${e(firstLine(head.message))} · ${e(head.author.name)} · ${day(head.authoredAt)}${w.at ? ` · <a href="${root(w)}/code">back to the head</a>` : ""}</p>` : "";
  return page(`${title} · ${name}`, `<div class="page-width repo">${crumbs}<header><h1>${e(name)}${w.item ? ` <span class="repo-sub">${e(w.item)}</span>` : ""}</h1>${tabs}${at}</header>${body}</div>`, "Projects", ownerName);
}

function pathCrumbs(w: Where, path: string[]): string {
  const parts = [`<a href="${codeHref(w, [])}">${e(w.item ?? titleOf(w.project))}</a>`];
  path.forEach((p, i) => parts.push(i === path.length - 1 ? `<strong>${e(p)}</strong>` : `<a href="${codeHref(w, path.slice(0, i + 1))}">${e(p)}</a>`));
  return `<p class="repo-path mono">${parts.join(" / ")}</p>`;
}

export function renderTree(w: Where, head: Commit, path: string[], node: Extract<Node, { kind: "tree" }>, ownerName: string | null = null): string {
  const rows = node.entries.map((x) => {
    const dir = x.type === "tree";
    const link = x.type === "tree" || READABLE.has(x.type)
      ? `<a href="${codeHref(w, [...path, x.name])}">${e(x.name)}${dir ? "/" : ""}</a>${x.type === "exec" ? ' <span class="meta">executable</span>' : x.type === "symlink" ? ' <span class="meta">link</span>' : ""}`
      : `<span>${e(x.name)}</span> <span class="meta">${x.type === "gitlink" ? "submodule" : e(x.type)}</span>`;
    return `<li class="${dir ? "dir" : "file"}">${link}</li>`;
  }).join("");
  const more = node.total > node.entries.length ? `<p class="meta">The first ${node.entries.length} of ${node.total} entries; clone the repository for the rest.</p>` : "";
  const body = `${pathCrumbs(w, path)}${node.entries.length ? `<ul class="repo-tree">${rows}</ul>${more}` : '<p class="empty">This directory is empty.</p>'}`;
  return frame(w, path.length ? path.join("/") : "Code", "code", head, body, ownerName);
}

export function renderBlob(w: Where, head: Commit, path: string[], view: FileView, ownerName: string | null = null, symlink = false): string {
  const size = Number.isFinite(view.bytes) ? `${view.bytes.toLocaleString("en")} bytes` : "Very large";
  const tools = `<p class="meta">${size} · <a href="${historyHref(w, path)}">History of this file</a></p>`;
  const body = symlink && view.kind === "text"
    ? `<p>A symbolic link to <code>${e(view.lines.join("\n"))}</code>.</p>`
    : view.kind === "text"
    ? `<ol class="code-lines" tabindex="0">${view.lines.map((l) => `<li><code>${e(l) || " "}</code></li>`).join("")}</ol>`
    : view.kind === "binary" ? '<p class="empty">A binary file; not shown.</p>'
    : '<p class="empty">Too large to show here; clone the repository to read it.</p>';
  return frame(w, path.join("/"), "code", head, `${pathCrumbs(w, path)}${tools}${body}`, ownerName);
}

function commitRows(w: Where, commits: Commit[]): string {
  return `<ol class="repo-log">${commits.map((c) => `<li><a class="mono" href="${commitHref(w, c.hash)}">${short(c.hash)}</a><span class="msg">${e(firstLine(c.message))}</span><span class="meta">${e(c.author.name)} · ${day(c.authoredAt)}</span></li>`).join("")}</ol>`;
}

export const LOG_PAGES = 1000;

export function renderLog(w: Where, head: Commit | null, commits: Commit[], page: number, more: boolean, ownerName: string | null = null): string {
  const older = more && page + 1 < LOG_PAGES;
  const pager = `<nav class="pager" aria-label="Pages">${page > 0 ? `<a href="${logHref(w, page - 1)}">Newer</a>` : ""}${older ? `<a href="${logHref(w, page + 1)}">Older</a>` : ""}</nav>${more && !older ? '<p class="meta">Older commits are not paged here; clone the repository to read them.</p>' : ""}`;
  const body = commits.length ? `<p class="meta">The first-parent line, newest first.</p>${commitRows(w, commits)}${pager}` : '<p class="empty">No commits.</p>';
  return frame(w, "Log", "log", head, body, ownerName);
}

export function renderHistory(w: Where, head: Commit, path: string[], commits: Commit[], complete: boolean, ownerName: string | null = null): string {
  const note = complete ? "Every commit on the first-parent line that changed it." : `Commits that changed it among the most recent ${HISTORY_CAP} on the first-parent line.`;
  const none = complete ? "No commit on this line changed it." : `No commit among the most recent ${HISTORY_CAP} changed it.`;
  const body = `${pathCrumbs(w, path)}<p class="meta">${note}</p>${commits.length ? commitRows(w, commits) : `<p class="empty">${none}</p>`}`;
  return frame(w, `History of ${path.join("/")}`, "log", head, body, ownerName);
}

export function renderCommit(w: Where, c: { commit: Commit; parent: string | null; files: FileChange[]; truncated: boolean; parentMissing?: boolean }, ownerName: string | null = null): string {
  const { commit, parent, files, truncated } = c;
  const added = files.reduce((n, f) => n + f.added, 0), removed = files.reduce((n, f) => n + f.removed, 0);
  const at: Where = { ...w, at: commit.hash };
  const body = `<section class="commit-head"><h2>${e(firstLine(commit.message))}</h2>
${commit.message.includes("\n") ? `<pre class="commit-body">${e(commit.message.split("\n").slice(1).join("\n").trim())}</pre>` : ""}
<p class="meta"><span class="mono">${commit.hash}</span> · ${e(commit.author.name)} · ${day(commit.authoredAt)}${
    commit.parents.length ? ` · parent${commit.parents.length > 1 ? "s" : ""} ${commit.parents.map((p) => `<a class="mono" href="${commitHref(w, p)}">${short(p)}</a>`).join(", ")}` : " · the first commit"} · <a href="${codeHref(at, [])}">Browse files at this commit</a></p></section>
${c.parentMissing ? `<p class="empty">Its parent, <span class="mono">${short(parent!)}</span>, could not be read from this repository, so its changes are not shown.</p>` : `<p class="meta">${files.length}${truncated ? "+" : ""} file${files.length === 1 ? "" : "s"} changed, +${added} −${removed}${parent ? `, against <span class="mono">${short(parent)}</span>` : ""}.</p>`}
${files.map((f) => renderFile(f, files.length <= 8)).join("")}`;
  return frame(w, short(commit.hash), "commit", null, body, ownerName);
}
