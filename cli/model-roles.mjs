// atelier models assign and atelier models roles (t622), which
// cli/commands/models.mjs hands to: the developer's dated judgements of which
// model does what, with evidence, which routing reads
// (src/models/assignments.ts). Their forms, flags and help are declared
// in src/usage/commands/models.ts with the rest of `models`.
import { OWNER, actingHeaders, args, call, die } from "./atelier.mjs";

const scopeText = (scope, names) => (scope === "*" ? "every project" : names[scope] ?? scope);
const evidenceText = (ref, names) => { const slash = ref.indexOf("/"); return `${names[ref.slice(0, slash)] ?? ref.slice(0, slash)}${ref.slice(slash)}`; };

// One assignment as `models roles` prints it: id, date, role, scope, the
// choices in order, its status, then why, the evidence, the developer's words
// and who recorded it, acting for whom.
export function assignmentLines(v, names = {}) {
  const status = v.status === "superseded" ? `  superseded by ${v.supersededBy.id} on ${v.supersededBy.at.slice(0, 10)}`
    : v.status === "withdrawn" ? `  withdrawn ${v.withdrawal.at.slice(0, 10)} by ${v.withdrawal.by}${v.withdrawal.acting ? ` (acting ${v.withdrawal.acting})` : ""}: ${v.withdrawal.note}` : "";
  return [
    `${v.id}  ${v.at.slice(0, 10)}  ${v.role} in ${scopeText(v.scope, names)}: ${v.choices.map((c) => c.actor).join(", then ")}${status}`,
    `    why: ${v.reason}`,
    `    evidence: ${v.evidence.map((e) => evidenceText(e, names)).join(", ")}`,
    `    the developer's words: “${v.quote}”`,
    `    recorded by ${v.by}${v.acting ? ` (acting ${v.acting})` : ""}${v.supersedes ? `, superseding ${v.supersedes}` : ""}`,
  ];
}

// What `models roles` prints: the assignments standing, then the history,
// then the fallback each role without one returns to.
export function rolesReport({ assignments, names = {}, fallback = {} }) {
  const current = assignments.filter((v) => v.status === "current");
  const past = assignments.filter((v) => v.status !== "current");
  const lines = ["Standing role assignments:"];
  if (!current.length) lines.push("  None. Every role goes by its fallback below.");
  for (const v of current) lines.push(...assignmentLines(v, names).map((l) => `  ${l}`));
  if (past.length) {
    lines.push("", "History (superseded and withdrawn, kept with their evidence):");
    for (const v of past) lines.push(...assignmentLines(v, names).map((l) => `  ${l}`));
  }
  const held = new Set(current.filter((v) => v.scope === "*").map((v) => v.role));
  const open = Object.entries(fallback).filter(([role]) => !held.has(role));
  if (open.length) {
    lines.push("", "Roles without a standing assignment in every project go by their fallback:");
    for (const [role, text] of open) lines.push(`  ${role}: ${text}`);
  }
  return lines;
}

const unreachedLine = (u) => (u?.length ? `\nWarning: could not send it to projects ${u.join(", ")}; they read it with the next change to the pool or the roles` : "");

export async function assignCommand() {
  const [, , role, ...choices] = args._;
  const usage = 'atelier models assign ROLE H/M [H/M]... --reason TEXT --quote TEXT --evidence PROJECT/tN [--evidence ...] [--scope PROJECT] [--replaces aN] [--as H/M]';
  if (!role || !choices.length) die(usage);
  for (const flag of ["reason", "quote"]) if (typeof args[flag] !== "string" || !args[flag].trim()) die(`an assignment needs --${flag}: ${usage}`);
  const evidence = args.multi.evidence ?? [];
  if (!evidence.length) die(`an assignment rests on evidence: --evidence PROJECT/tN, once per task or event (${usage})`);
  const body = { role, choices: choices.flatMap((c) => c.split(",")).map((c) => c.trim()).filter(Boolean), reason: args.reason, quote: args.quote, evidence, scope: args.scope, replaces: args.replaces };
  const a = await call("POST", "/model-roles", body, OWNER, actingHeaders());
  const where = a.scope === "*" ? "every project" : args.scope;
  if (a.retried) return console.log(`${a.id} already records that assignment (${a.at.slice(0, 10)}); nothing new was recorded.${unreachedLine(a.unreached)}`);
  console.log(`${a.id}: ${a.role} in ${where} goes to ${a.choices.map((c) => c.actor).join(", then ")}, recorded ${a.at.slice(0, 10)}${a.supersedes ? `, superseding ${a.supersedes}` : ""}. Routing reads it from now on. To withdraw it: atelier models roles withdraw ${a.id} --note "why"${unreachedLine(a.unreached)}`);
}

export async function rolesCommand() {
  const [, , sub, id] = args._;
  if (sub === "withdraw") {
    if (!id || args._.length !== 4) die('atelier models roles withdraw aN --note "why"');
    if (typeof args.note !== "string" || !args.note.trim()) die('withdrawing an assignment needs a note saying why: atelier models roles withdraw aN --note "why"');
    const w = await call("POST", `/model-roles/${encodeURIComponent(id)}/withdraw`, { note: args.note }, OWNER, actingHeaders());
    if (w.retried) return console.log(`${id} was already withdrawn (${w.id}, ${w.at.slice(0, 10)}).${unreachedLine(w.unreached)}`);
    return console.log(`${id} is withdrawn (${w.id}, ${w.at.slice(0, 10)}): ${w.role} goes by its fallback again, not by an assignment ${id} superseded.${unreachedLine(w.unreached)}`);
  }
  if (sub !== undefined) die('atelier models roles [--json], or atelier models roles withdraw aN --note "why"');
  const report = await call("GET", "/model-roles", undefined, OWNER);
  if (args.json) return console.log(JSON.stringify(report, null, 2));
  for (const line of rolesReport(report)) console.log(line);
}
