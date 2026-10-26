// A blocking finding on a file the task's scope lacks (t270). The builder
// cannot edit a file outside its scope, so a rework round sent back for such a
// finding fails the same way; t264 went to round 2 on 2026-10-25 with its
// blocker in cli/land-queue.mjs and was rejected again. The gap is named
// where the item is read (show, status and the rework brief) with the edit
// that closes it, before another round is dispatched. Pure.

import { matchesAny, type Finding, type Review } from "../rules.ts";

export interface ScopeGap {
  files: string[];      // blocking findings' files outside the scope, first seen first
  edit: string;         // atelier edit, keeping the existing scope globs
}

const clean = (file: string) => file.trim().replace(/^\.\//, "");
const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

// The blocking findings among `findings` (a follow-up or labelled finding does
// not block) whose file the scope does not cover. An item with no scope covers
// every file, so it has no gap.
export function findingScopeGap(item: { id: string; scope: readonly string[] }, findings: readonly Finding[]): ScopeGap | null {
  if (!item.scope.length) return null;
  const files: string[] = [];
  for (const f of findings) {
    if (f.severity !== "blocking" || f.label !== undefined) continue;
    const file = clean(f.file);
    if (file && !matchesAny(file, [...item.scope]) && !files.includes(file)) files.push(file);
  }
  if (!files.length) return null;
  const globs = [...item.scope, ...files];
  return { files, edit: `atelier edit ${item.id} ${globs.map((g) => `--scope ${quote(g)}`).join(" ")}` };
}

// The gap of the rejections at the item's head, which are the findings a
// builder is sent back with.
export function reviewScopeGap(item: { id: string; scope: readonly string[]; head?: string | null }, reviews: readonly Review[]): ScopeGap | null {
  return findingScopeGap(item, reviews.filter((r) => !r.approve && r.head === item.head).flatMap((r) => r.findings ?? []));
}

// One sentence for show, status and the brief.
export function scopeGapText(item: { id: string }, gap: ScopeGap): string {
  const list = gap.files.join(", ");
  return `The scope lacks ${gap.files.length === 1 ? "a file" : "files"} a blocking finding names (${list}), so the builder cannot fix ${gap.files.length === 1 ? "it" : "them"}. The developer adds ${gap.files.length === 1 ? "it" : "them"} before another round: ${gap.edit}`;
}
