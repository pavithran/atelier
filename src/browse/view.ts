// The browsing pages: a directory, a file, the log, a commit and a path's
// history, for a project's baseline or one task's fork. Server-rendered, no
// script, every value escaped. `Where` names the repository being read and
// builds every link, so a link never leaves the repository it came from.

import { escapeText as e, page, projectTabs, renderFile, titleOf } from "../ui.ts";
import type { ProjectRecord } from "../ledger.ts";
import { stamp } from "../time.ts";
import { agentsIn, NO_AGENT, normaliseAgentName } from "../import/history.ts";
import { laneColour } from "../import/draw.ts";
import { HISTORY_CAP, READABLE, type Commit, type FileChange, type FileView, type Node, type Touched } from "./repo.ts";

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
const day = (seconds: number) => stamp(seconds * 1000);
const firstLine = (m: string) => m.split("\n")[0];

// The family a commit's message names: the first Agent or Co-Authored-By
// line that names a model, in that family's colour, as the imported history
// reads them. A commit naming none is labelled so and drawn dim. The label
// says it in words beside every stripe, so colour never carries it alone.
export function commitFamily(c: Commit): { label: string; colour: string } {
  const names = agentsIn(c.message);
  const label = names.length ? normaliseAgentName(names[0]) : NO_AGENT;
  return { label: label === NO_AGENT ? "no agent named" : label, colour: laneColour(label, "") };
}
const stripe = (c: Commit) => `<i class="stripe" style="--c:${commitFamily(c).colour}" aria-hidden="true"></i>`;

// The frame of a browsing page inside its project's area: the project's tab
// bar, with the tab the page belongs to current. A commit and a path's
// history belong to Log (finding 24). `crumb` is the page's own name at the
// end of the breadcrumb, which for a commit says "Commit" before its hash so
// the crumb never ends in a bare eight characters.
function frame(w: Where, title: string, crumb: string, tab: "code" | "log" | "commit", head: Commit | null, body: string, ownerName: string | null): string {
  const name = titleOf(w.project);
  const active = tab === "commit" ? "Log" : tab === "code" ? "Code" : "Log";
  const crumbs = `<nav class="breadcrumbs"><a href="/home">Home</a> / <a href="/p/${enc(w.project.name)}">${e(name)}</a>${
    w.item ? ` / <a href="/p/${enc(w.project.name)}/${enc(w.item)}">${e(w.item)}</a>` : ""} / ${e(crumb)}</nav>`;
  const what = w.item ? `${e(w.item)}'s fork` : "the baseline";
  const at = head ? `<p class="meta repo-at">${w.at ? "At" : "Head of"} ${what}: <a class="mono" href="${commitHref(w, head.hash)}">${short(head.hash)}</a> · ${e(firstLine(head.message))} · ${e(head.author.name)} · ${day(head.authoredAt)}${w.at ? ` · <a href="${root(w)}/code">back to the head</a>` : ""}</p>` : "";
  return page(`${title} · ${name}`, `<div class="page-width repo">${crumbs}<header class="proj-head"><h1>${e(name)}${w.item ? ` <span class="repo-sub">${e(w.item)}</span>` : ""}</h1>${projectTabs(w.project, active)}${at}</header>${body}</div>`, "Home", ownerName);
}

function pathCrumbs(w: Where, path: string[]): string {
  const parts = [`<a href="${codeHref(w, [])}">${e(w.item ?? titleOf(w.project))}</a>`];
  path.forEach((p, i) => parts.push(i === path.length - 1 ? `<strong>${e(p)}</strong>` : `<a href="${codeHref(w, path.slice(0, i + 1))}">${e(p)}</a>`));
  return `<p class="repo-path mono">${parts.join(" / ")}</p>`;
}

// `touched` is the commit that last changed each entry (repo.ts lastChanges):
// each row then carries a stripe in the family that commit names, with the
// name and the commit beside it. Null when that could not be read; absent
// when it was not asked for.
export function renderTree(w: Where, head: Commit, path: string[], node: Extract<Node, { kind: "tree" }>, ownerName: string | null = null, touched?: Touched | null): string {
  const rows = node.entries.map((x) => {
    const dir = x.type === "tree";
    const link = x.type === "tree" || READABLE.has(x.type)
      ? `<a href="${codeHref(w, [...path, x.name])}">${e(x.name)}${dir ? "/" : ""}</a>${x.type === "exec" ? ' <span class="meta">executable</span>' : x.type === "symlink" ? ' <span class="meta">link</span>' : ""}`
      : `<span>${e(x.name)}</span> <span class="meta">${x.type === "gitlink" ? "submodule" : e(x.type)}</span>`;
    const c = touched?.by.get(x.name);
    const last = !touched ? ""
      : c ? `${stripe(c)}<span class="entry">${link}</span><span class="meta touch">${e(commitFamily(c).label)} · <a class="mono" href="${commitHref(w, c.hash)}">${short(c.hash)}</a></span>`
      : `<i class="stripe none" aria-hidden="true"></i><span class="entry">${link}</span><span class="meta touch">not changed in the commits read</span>`;
    return `<li class="${dir ? "dir" : "file"}${touched ? " striped" : ""}">${last || `<span class="entry">${link}</span>`}</li>`;
  }).join("");
  const more = node.total > node.entries.length ? `<p class="meta">The first ${node.entries.length} of ${node.total} entries; clone the repository for the rest.</p>` : "";
  const stripes = touched === undefined ? ""
    : touched === null ? '<p class="meta">Which commit last changed each entry could not be read just now.</p>'
    : touched.complete ? '<p class="meta">Each stripe is the family of the agent named by the commit that last changed the entry, with its name beside it.</p>'
    : touched.examined ? `<p class="meta">Each stripe is the family of the agent named by the commit that last changed the entry, among the last ${touched.examined} commits on the first-parent line.</p>`
    : '<p class="meta">Which commit last changed each entry was not read: the directory is too deep or too busy for this page\'s read budget.</p>';
  const body = `${pathCrumbs(w, path)}${node.entries.length ? `<ul class="repo-tree">${rows}</ul>${stripes}${more}` : '<p class="empty">This directory is empty.</p>'}`;
  const title = path.length ? path.join("/") : "Code";
  return frame(w, title, title, "code", head, body, ownerName);
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
  return frame(w, path.join("/"), path.join("/"), "code", head, `${pathCrumbs(w, path)}${tools}${body}`, ownerName);
}

// Each commit carries a stripe in the family its message names, and the name in its line.
function commitRows(w: Where, commits: Commit[]): string {
  return `<ol class="repo-log">${commits.map((c) => `<li>${stripe(c)}<a class="mono" href="${commitHref(w, c.hash)}">${short(c.hash)}</a><span class="msg">${e(firstLine(c.message))}</span><span class="meta">${e(commitFamily(c).label)} · ${e(c.author.name)} · ${day(c.authoredAt)}</span></li>`).join("")}</ol>`;
}

export const LOG_PAGES = 1000;

export function renderLog(w: Where, head: Commit | null, commits: Commit[], page: number, more: boolean, ownerName: string | null = null): string {
  const older = more && page + 1 < LOG_PAGES;
  const pager = `<nav class="pager" aria-label="Pages">${page > 0 ? `<a href="${logHref(w, page - 1)}">Newer</a>` : ""}${older ? `<a href="${logHref(w, page + 1)}">Older</a>` : ""}</nav>${more && !older ? '<p class="meta">Older commits are not paged here; clone the repository to read them.</p>' : ""}`;
  const body = commits.length ? `<p class="meta">The first-parent line, newest first.</p>${commitRows(w, commits)}${pager}` : '<p class="empty">No commits.</p>';
  return frame(w, "Log", "Log", "log", head, body, ownerName);
}

export function renderHistory(w: Where, head: Commit, path: string[], commits: Commit[], complete: boolean, ownerName: string | null = null, examined = HISTORY_CAP): string {
  const note = complete ? "Every commit on the first-parent line that changed it." : `Commits that changed it among the most recent ${examined} on the first-parent line.`;
  const none = complete ? "No commit on this line changed it."
    : examined === 0 ? "This path is too deep, or changed in too many places, to trace here; clone the repository to follow it."
    : `No commit among the most recent ${examined} changed it.`;
  const body = `${pathCrumbs(w, path)}<p class="meta">${note}</p>${commits.length ? commitRows(w, commits) : `<p class="empty">${none}</p>`}`;
  const historyTitle = `History of ${path.join("/")}`;
  return frame(w, historyTitle, historyTitle, "log", head, body, ownerName);
}

export function renderCommit(w: Where, c: { commit: Commit; parent: string | null; files: FileChange[]; truncated: boolean; parentMissing?: boolean }, ownerName: string | null = null): string {
  const { commit, parent, files, truncated } = c;
  const added = files.reduce((n, f) => n + f.added, 0), removed = files.reduce((n, f) => n + f.removed, 0);
  const at: Where = { ...w, at: commit.hash };
  const family = commitFamily(commit);
  const body = `<section class="commit-head" style="--c:${family.colour}"><h2>${e(firstLine(commit.message))}</h2>
${commit.message.includes("\n") ? `<pre class="commit-body">${e(commit.message.split("\n").slice(1).join("\n").trim())}</pre>` : ""}
<p class="meta"><span class="mono">${commit.hash}</span> · ${e(family.label)} · ${e(commit.author.name)} · ${day(commit.authoredAt)}${
    commit.parents.length ? ` · parent${commit.parents.length > 1 ? "s" : ""} ${commit.parents.map((p) => `<a class="mono" href="${commitHref(w, p)}">${short(p)}</a>`).join(", ")}` : " · the first commit"} · <a href="${codeHref(at, [])}">Browse files at this commit</a></p></section>
${c.parentMissing ? `<p class="empty">Its parent, <span class="mono">${short(parent!)}</span>, could not be read from this repository, so its changes are not shown.</p>` : `<p class="meta">${files.length}${truncated ? "+" : ""} file${files.length === 1 ? "" : "s"} changed, +${added} −${removed}${parent ? `, against <span class="mono">${short(parent)}</span>` : ""}.</p>`}
${files.map((f) => renderFile(f, files.length <= 8)).join("")}`;
  // The crumb names a commit as a commit, never a bare hash (finding 24).
  return frame(w, `Commit ${short(commit.hash)}`, `Commit ${short(commit.hash)}`, "commit", null, body, ownerName);
}
