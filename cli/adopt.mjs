// `atelier adopt`: move one project from ControlPlane to Atelier.
//
// The move is an ordinary Atelier task. adopt creates it, claims it, and
// writes into its workspace the files that make the project work through
// Atelier: bin/control-plane forwards each ControlPlane command to the Atelier
// command it became, bin/control-plane-paste points handoffs at
// `atelier handoff`, and AGENTS.md carries the text `atelier guide` prints.
// What the move cannot settle by itself is read from the project's checkout
// and reported on the task: state ControlPlane still holds, capabilities that
// name files the project no longer has, a vendored copy of ControlPlane's
// tools, and the lines in the agent files that still send work through
// ControlPlane. Nothing here writes to the checkout.
//
// The move is applied to the task's workspace and nothing outside it: a path
// the move writes that is a symbolic link is replaced — unlinked, then written
// as a regular file — never written through, and a symbolic link among a
// written path's directories refuses the move. Every check that can refuse the
// move is run against the checkout before the task exists, so a refusal leaves
// nothing behind.

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

// What the new task may touch: the files the move writes and the files the
// leftovers live in, which the agent finishing the task settles.
export const SCOPE = [
  "bin/control-plane",
  "bin/control-plane-paste",
  "AGENTS.md",
  "CLAUDE.md",
  "GLM.md",
  "docs/control-plane/work-item.v1.json",
  "docs/control-plane/project-adapter.v1.json",
  "tools/control-plane/**",
];

export const TEMPLATE = new URL("../templates/control-plane-entry.sh", import.meta.url);

const PLACEHOLDER = "__ATELIER_PROJECT__";

// The entry point with the project's Atelier name filled in. The name goes in
// as one single-quoted shell word, with embedded single quotes closed, escaped
// and reopened, so no name can become shell syntax. The replacement is written
// by a callback: with a plain string, `$` sequences in the name (`$$`, `$&`,
// `` $` ``) would be read as replacement syntax and corrupt it.
export function fillTemplate(template, project) {
  if (!template.includes(PLACEHOLDER)) throw new Error("the entry point template has no project name to fill in");
  if (/[\u0000-\u001f\u007f]/.test(project)) throw new Error("this project's name cannot be written into a shell script");
  const word = `'${project.replaceAll("'", "'\\''")}'`;
  return template.replace(PLACEHOLDER, () => word);
}

// The AGENTS.md section: the text `atelier guide` prints, under a heading that
// says where the project's instructions come from now, and one sentence on
// what bin/control-plane does. The guide's own heading is dropped, because the
// section heading says the same thing.
export function section(guide) {
  const body = guide.replace(/^#{1,6}[^\n]*\n+/, "").trimEnd();
  return `## This project works through Atelier\n\n${body}\n\n\`bin/control-plane\` now forwards to Atelier: it prints the Atelier command it runs and never contacts ControlPlane's central checkout.\n`;
}

// Where the Atelier section starts in an AGENTS.md that already has one.
const SECTION_HEADING = /^## This project works through Atelier[ \t]*$/m;

// The section goes right after the file's first heading, so an agent reads how
// the project works before anything else in it. A file with no heading at all
// gets it at the top. A file that already carries the section has it replaced
// where it stands, so adopting a project twice cannot stack two of them: the
// section runs to its own last line — the sentence about bin/control-plane the
// move writes — and in a file where that line is gone (hand-edited since) to
// the next heading that is not part of it.
export function insertSection(markdown, text) {
  const block = text.trimEnd();
  const existing = markdown.match(SECTION_HEADING);
  if (existing) {
    const head = existing.index + existing[0].length;
    const tail = block.slice(block.lastIndexOf("\n") + 1);
    const next = markdown.slice(head).match(/^#{1,2}[^\n]*$/m);
    const limit = next ? head + next.index : markdown.length;
    const found = markdown.slice(head, limit).indexOf(`\n${tail}`);
    const end = found === -1 ? limit : head + found + 1 + tail.length;
    const before = markdown.slice(0, existing.index).replace(/\s+$/, "");
    const after = markdown.slice(end).replace(/^\s+/, "");
    return `${before ? `${before}\n\n` : ""}${block}\n${after ? `\n${after}` : ""}`;
  }
  const first = markdown.match(/^#{1,6}[^\n]*$/m);
  const before = first ? markdown.slice(0, first.index + first[0].length) : "";
  const after = markdown.slice(before.length).replace(/^\s+/, "");
  return `${before ? `${before}\n\n` : ""}${block}\n${after ? `\n${after}` : ""}`;
}

// bin/control-plane-paste, when the project has one, becomes a two-line script:
// a handoff carries a session's work on in Atelier, so there is nothing to paste.
export function pasteScript() {
  return `#!/bin/sh\necho 'Handoffs go through: atelier handoff ID --to HARNESS/MODEL --note "why"' >&2\n`;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

// ControlPlane's own states for a work item that is not finished and not
// reconciled.
const UNRECONCILED = ["active", "completed-unreconciled", "blocked"];

// What an agent file says that still sends work through ControlPlane.
const CALLS = ["pickup-card", "control-plane-paste", "session-receipt", "audit record"];

// A capability's command as shell words, so a quoted path with spaces stays
// one word. The parser is deliberately small: quotes and backslashes, which is
// everything a capability's command needs.
function shellWords(command) {
  const words = [];
  let word = "", started = false, quote = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") { if (c === "'") quote = null; else word += c; continue; }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && i + 1 < command.length && '"\\$`'.includes(command[i + 1])) word += command[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
    if (c === "\\" && i + 1 < command.length) { word += command[++i]; started = true; continue; }
    if (/\s/.test(c)) { if (started) { words.push(word); word = ""; started = false; } continue; }
    word += c; started = true;
  }
  if (started) words.push(word);
  return words;
}

// A word naming an interpreter, by itself or with a version (`python3`,
// `/usr/bin/env`, `node`): the script it runs is the file to judge, not the
// interpreter.
const INTERPRETER = /^(?:sh|bash|zsh|dash|ksh|fish|pwsh|powershell|env)$|^(?:python|node|nodejs|deno|bun|ruby|perl|php)\d*(?:\.\d+)*$/;

// A leading `NAME=value` puts a variable in the interpreter's environment; the
// command is what follows it.
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// What looks like a file in the project: a path, or a name with a file
// extension. A bare word like `git` is looked up on PATH, not in the project,
// so it cannot be judged to exist or not.
const PATHLIKE = /\/|\.[A-Za-z0-9]+$/;

// The file a capability's command runs, or null when it runs none. A leading
// interpreter or `NAME=value` assignment, and any option, is skipped; the
// first word left is judged, and only when it looks like a file.
function commandFile(capability) {
  const command = typeof capability === "string" ? capability : capability?.command;
  const argv = Array.isArray(command) ? command.map(String) : typeof command === "string" ? shellWords(command) : [];
  for (const word of argv) {
    if (!word || ASSIGNMENT.test(word) || word.startsWith("-") || INTERPRETER.test(basename(word))) continue;
    return PATHLIKE.test(word) ? word : null;
  }
  return null;
}

// The adapter lists its capabilities as an array, or as an object from name to
// capability. Both are read; the file is Atelier's to read, never to write.
function capabilities(adapter) {
  const list = adapter?.capabilities;
  if (Array.isArray(list)) return list;
  if (!list || typeof list !== "object") return [];
  return Object.entries(list).map(([name, c]) => (typeof c === "object" && c !== null ? { name, ...c } : { name, command: c }));
}

// What the agent finishing the task must settle, read from the project's
// checkout. Each line names the file it comes from, so the list can be settled
// one line at a time.
export function leftovers(checkout) {
  const out = [];
  const work = readJson(join(checkout, "docs", "control-plane", "work-item.v1.json"));
  if (UNRECONCILED.includes(work?.state)) {
    const plan = work.plan_id ?? work.planId ?? null;
    const owner = work.owner ?? null;
    out.push(`docs/control-plane/work-item.v1.json: plan ${plan ?? "with no plan id recorded"} is ${work.state}, owned by ${owner ?? "nobody recorded"}`);
  }
  for (const capability of capabilities(readJson(join(checkout, "docs", "control-plane", "project-adapter.v1.json")))) {
    const file = commandFile(capability);
    if (file && !existsSync(resolve(checkout, file))) {
      out.push(`docs/control-plane/project-adapter.v1.json: capability "${capability?.name ?? file}" runs ${file}, which does not exist`);
    }
  }
  if (existsSync(join(checkout, "tools", "control-plane"))) {
    out.push("tools/control-plane/: a vendored copy of ControlPlane's tools, which Atelier does not run");
  }
  for (const file of ["AGENTS.md", "CLAUDE.md", "GLM.md"]) {
    let text;
    try { text = readFileSync(join(checkout, file), "utf8"); } catch { continue; }
    text.split("\n").forEach((line, i) => {
      const named = CALLS.filter((call) => line.includes(call));
      if (named.length) out.push(`${file}:${i + 1} still names ${named.join(", ")}`);
    });
  }
  return out;
}

// Whether the path itself is a symbolic link.
export function isLink(path) {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

// The directory in `path`, below `root`, that is a symbolic link, or null. A
// path the move writes must stay inside the workspace throughout, and a
// symlinked directory would carry the write out of it.
export function linkedPart(root, path) {
  let at = root;
  for (const part of path.split("/").slice(0, -1)) {
    at = join(at, part);
    let stat;
    try { stat = lstatSync(at); } catch { return null; }
    if (stat.isSymbolicLink()) return relative(root, at);
  }
  return null;
}

// Everything the move writes and everything it reports, computed from the
// checkout and from the directory the move is applied to. Called with the
// checkout before the task exists — the workspace is a clone of it, so the
// same checks hold there — and again with the task's workspace, which is what
// the agent finishing the task works in.
export function adoption({ project, checkout, workspace, guide, template = readFileSync(TEMPLATE, "utf8") }) {
  // Any entry counts, a dangling link included: it may resolve again once the
  // move is merged back, and would then still run ControlPlane's paste.
  const pastePath = join(workspace, "bin", "control-plane-paste");
  const paste = existsSync(pastePath) || isLink(pastePath);
  const paths = ["bin/control-plane", ...(paste ? ["bin/control-plane-paste"] : []), "AGENTS.md"];
  // A symlinked directory above a written path refuses the move; a symlinked
  // file is the move's to replace (writeMove unlinks it), except AGENTS.md,
  // whose text the section is built from: the move does not read through a
  // link either.
  for (const path of paths) {
    const part = linkedPart(workspace, path);
    if (part) throw new Error(`${part} is a symbolic link; the move will not write through it`);
  }
  const agents = join(workspace, "AGENTS.md");
  if (isLink(agents)) throw new Error("AGENTS.md is a symbolic link; replace it with a regular file before the move");
  let held;
  try { held = readFileSync(agents, "utf8"); }
  catch (error) { throw new Error(`AGENTS.md cannot be read: ${error.message}`); }
  const files = [
    { path: "bin/control-plane", text: fillTemplate(template, project), mode: 0o755 },
    ...(paste ? [{ path: "bin/control-plane-paste", text: pasteScript(), mode: 0o755 }] : []),
    { path: "AGENTS.md", text: insertSection(held, section(guide)), mode: null },
  ];
  const message = `Move ${project} from ControlPlane to Atelier\n\n`
    + "bin/control-plane now prints the Atelier command it runs and forwards to it,\n"
    + "never to ControlPlane's central checkout; bin/control-plane-paste points\n"
    + "handoffs at atelier handoff; AGENTS.md carries the Atelier guide.\n";
  return { files, leftovers: leftovers(checkout), message };
}

// Write the move into the workspace. Nothing outside the workspace is touched:
// a path that is a symbolic link is unlinked and written afresh as a regular
// file, never written through, and a symlinked directory above it refuses the
// move.
export function writeMove(workspace, files) {
  for (const file of files) {
    const part = linkedPart(workspace, file.path);
    if (part) throw new Error(`${part} is a symbolic link; the move will not write through it`);
    const path = join(workspace, file.path);
    if (isLink(path)) unlinkSync(path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.text, file.mode ? { mode: file.mode } : {});
    if (file.mode) chmodSync(path, file.mode);
  }
}
