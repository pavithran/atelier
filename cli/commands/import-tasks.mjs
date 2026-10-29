// atelier import-tasks. Its forms, flags and help are declared in src/usage/commands/import-tasks.ts.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { COMMAND_USAGE } from "../help.mjs";
import { OWNER, P, actor, args, call, die, project, server } from "../atelier.mjs";

// The format of a project's own task and decision files, as a project kept
// off Atelier writes docs/TASKS.md and docs/DECISIONS.md (G14), one entry a
// line, the same in both:
//
//   - [ ] TITLE        an open task, filed with that title
//   - [x] TITLE        a finished task, not filed
//   - TEXT             a standing decision, recorded with that text
//     MORE TEXT        indented two or more spaces under an entry: a task's
//                      brief, or more of a decision's text
//   # HEADING          headings, blank lines and <!-- comments --> are skipped;
//                      a heading ends the entry above it
//
// Any other line is refused, naming it, and nothing is sent.
export function parseTaskFile(text, source = "the file") {
  const entries = [];
  let done = 0, last = null;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (const [i, raw] of lines.entries()) {
    const n = i + 1;
    // A heading ends the entry above it; a blank line or a comment does not.
    if (/^#{1,6}\s/.test(raw)) { last = null; continue; }
    if (!raw.trim() || /^\s*<!--.*-->\s*$/.test(raw)) continue;
    const task = /^[-*] \[( |x|X)\] (.+)$/.exec(raw);
    if (task) {
      if (task[1] === " ") { last = { line: n, kind: "task", title: task[2].trim(), brief: null }; entries.push(last); }
      else { done++; last = { kind: "done" }; }
      continue;
    }
    const decision = /^[-*] (?!\[)(.+)$/.exec(raw);
    if (decision) { last = { line: n, kind: "decision", text: decision[1].trim() }; entries.push(last); continue; }
    const more = /^ {2,}\S/.test(raw) || /^\t+\S/.test(raw);
    if (more && last) {
      if (last.kind === "task") last.brief = last.brief ? `${last.brief} ${raw.trim()}` : raw.trim();
      else if (last.kind === "decision") last.text = `${last.text} ${raw.trim()}`;
      continue;
    }
    throw new Error(`${source} line ${n} is not an entry: ${JSON.stringify(raw.slice(0, 80))}. A line is "- [ ] TITLE" (a task), "- [x] TITLE" (a finished one), "- TEXT" (a decision), indented text under an entry, a heading or a blank line`);
  }
  return { entries, done };
}

export default async function importTasksCommand() {
  const files = args._.slice(1);
  if (!files.length) die(COMMAND_USAGE["import-tasks"]);
  const name = project(), as = await actor(OWNER);
  const at = new URL(server()).host;
  // Every file is read and parsed before anything is sent.
  const parsed = files.map((file) => {
    let text;
    try { text = readFileSync(file, "utf8"); } catch (error) { die(`${file}: ${error.message}; nothing was imported`); }
    try { return { file, ...parseTaskFile(text, basename(file)) }; } catch (error) { die(`${error.message}; nothing was imported.\nnext: fix that line, then run atelier import-tasks ${files.join(" ")} --project ${name} again`); }
  });
  for (const { file, entries, done } of parsed) {
    const r = await call("POST", `${P(name)}/import-tasks`, { source: basename(file), entries }, as);
    const list = (xs) => xs.map((x) => `${x.id} (line ${x.line})`).join(", ");
    console.log([
      `${name} on ${at}, from ${file}: ${r.filed.length} task${r.filed.length === 1 ? "" : "s"} filed${r.filed.length ? `: ${list(r.filed)}` : ""}; ${r.decided.length} decision${r.decided.length === 1 ? "" : "s"} recorded${r.decided.length ? `: ${list(r.decided)}` : ""}.`,
      ...(r.kept.length ? [`${r.kept.length} entr${r.kept.length === 1 ? "y was" : "ies were"} imported before and left as they are: ${list(r.kept)}.`] : []),
      ...(done ? [`${done} finished task${done === 1 ? " was" : "s were"} not filed.`] : []),
    ].join("\n"));
  }
}
