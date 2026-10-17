// Neutral labels for a task: its kind of work, read from the words of its
// title, so a story built anonymised (src/graph.ts) never carries the title.
// A pure function, so the server can label a story before it reaches a page.

// What kind of work a task was, from the words of its title. An anonymised
// story titles a task with only this, so the words of the title itself stay
// private.
export function workKind(title: string): string {
  const t = title.toLowerCase();
  if (/\b(fix|fixes|fixed|repair|bug|crash|regression|broken|failure|fails|wrong)\b/.test(t)) return "a fix";
  if (/\b(test|tests|spec|specs|coverage)\b/.test(t)) return "tests";
  if (/\b(doc|docs|documentation|readme|guide|changelog|comment|comments)\b/.test(t)) return "documentation";
  if (/\b(refactor|refactoring|renam(e|es|ing)|reorganis(e|es|ing)|clean(s|ed|ing)? up|tidy|simplify)\b/.test(t)) return "a refactor";
  if (/\b(add|adds|added|support|supports|create|creates|build|builds|implement|implements|introduce|allow|allows|enable|enables|make|makes|write|writes|improve|improves|new)\b/.test(t)) return "a feature";
  return "a change";
}
