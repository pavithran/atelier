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

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

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

// The entry point with the project's Atelier name filled in. The name is
// written as a quoted shell word, so a project name can never become shell
// syntax in it.
export function fillTemplate(template, project) {
  if (!template.includes(PLACEHOLDER)) throw new Error("the entry point template has no project name to fill in");
  if (/[\u0000-\u001f\u007f]/.test(project)) throw new Error("this project's name cannot be written into a shell script");
  return template.replace(PLACEHOLDER, project.replaceAll("'", "'\\''"));
}

// The AGENTS.md section: the text `atelier guide` prints, under a heading that
// says where the project's instructions come from now, and one sentence on
// what bin/control-plane does. The guide's own heading is dropped, because the
// section heading says the same thing.
export function section(guide) {
  const body = guide.replace(/^#{1,6}[^\n]*\n+/, "").trimEnd();
  return `## This project works through Atelier\n\n${body}\n\n\`bin/control-plane\` now forwards to Atelier: it prints the Atelier command it runs and never contacts ControlPlane's central checkout.\n`;
}

// The section goes right after the file's first heading, so an agent reads how
// the project works before anything else in it.
export function insertSection(markdown, text) {
  const first = markdown.match(/^#{1,6}[^\n]*$/m);
  if (!first) throw new Error("AGENTS.md has no heading to put the Atelier section under");
  const at = first.index + first[0].length;
  const rest = markdown.slice(at).replace(/^\n+/, "\n\n");
  return `${markdown.slice(0, at)}\n\n${text.trimEnd()}\n${rest}`;
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

// A capability's command as argv. A bare name is looked up on PATH, not in the
// project, so only a path can be judged to exist or not.
function commandFile(capability) {
  const command = typeof capability === "string" ? capability : capability?.command;
  const argv = Array.isArray(command) ? command : typeof command === "string" ? command.trim().split(/\s+/) : [];
  const first = String(argv[0] ?? "");
  return first.includes("/") ? first : null;
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

// Everything the move writes into the task's workspace and everything it
// reports, computed from the checkout and the workspace clone.
export function adoption({ project, checkout, workspace, guide, template = readFileSync(TEMPLATE, "utf8") }) {
  const agents = join(workspace, "AGENTS.md");
  if (!existsSync(agents)) throw new Error("the task's workspace has no AGENTS.md to put the Atelier section in");
  const files = [
    { path: "bin/control-plane", text: fillTemplate(template, project), mode: 0o755 },
    ...(existsSync(join(workspace, "bin", "control-plane-paste")) ? [{ path: "bin/control-plane-paste", text: pasteScript(), mode: 0o755 }] : []),
    { path: "AGENTS.md", text: insertSection(readFileSync(agents, "utf8"), section(guide)), mode: null },
  ];
  const message = `Move ${project} from ControlPlane to Atelier\n\n`
    + "bin/control-plane now prints the Atelier command it runs and forwards to it,\n"
    + "never to ControlPlane's central checkout; bin/control-plane-paste points\n"
    + "handoffs at atelier handoff; AGENTS.md carries the Atelier guide.\n";
  return { files, leftovers: leftovers(checkout), message };
}
