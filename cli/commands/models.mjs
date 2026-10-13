// atelier models. Its forms, flags and help are declared in src/usage/commands/models.ts.
import { join } from "node:path";
import { COMMAND_USAGE } from "../help.mjs";
import { OWNER, args, at, call, die, project } from "../atelier.mjs";
import { assignCommand, rolesCommand } from "../model-roles.mjs";

// The model pool. With no subcommand, lists it. `models add ID --harness H
// --where home|cloud [--provider P] [--endpoint URL] [--keychain NAME]
// [--alias A]... [--note TEXT]` adds or replaces an entry; `models remove ID`
// removes one; `models note ID 'text' [--item tN]` keeps a dated note under
// it, and `models show ID` prints it with its notes. Keys stay in the
// Keychain; only the entry's name is sent.
export default async function modelsCommand() {
  const [sub, id, text] = args._.slice(1);
  const modelLine = (m) => {
    const s = m.status ? `${m.status.state} ${m.status.at.slice(0, 16)}Z${m.status.served && m.status.served !== m.id ? ` as ${m.status.served}` : ""}` : "not checked";
    const held = m.state && m.state !== "available" ? `  ${m.state} since ${(m.stateAt ?? m.addedAt).slice(0, 16)}Z` : "";
    const roles = m.roles?.length ? `  roles: ${m.roles.join(",")}` : "";
    const tier = m.tier ? `  tier: ${m.tier}` : "";
    return `${m.where.padEnd(5)} ${m.harness}/${m.id}  ${m.family}  ${s}${m.keychain ? `  key: ${m.keychain}` : ""}${held}${roles}${tier}`;
  };
  const taskOf = (n) => (n.project ? `${n.projectName ?? n.project}/${n.item}` : n.item);
  const noteLines = (m) => (m.notes ?? []).map((n) => `  ${n.at.slice(0, 10)} by ${n.by}${n.item ? ` on ${taskOf(n)}` : ""}: ${n.text}`);
  // Role assignments (t622): cli/model-roles.mjs.
  if (sub === "assign") return assignCommand();
  if (sub === "roles") return rolesCommand();
  if (sub === "admit" || sub === "withdraw") {
    if (!id || !args.reason) die(`atelier models ${sub} ID --project NAME --reason TEXT`);
    const name = project();
    const record = await call(sub === "admit" ? "PUT" : "DELETE", `/projects/${encodeURIComponent(name)}/reviewers/${encodeURIComponent(id)}`, { reason: args.reason }, OWNER);
    return console.log(`${record.id}: reviewer ${record.active ? "admitted" : "withdrawn"} in ${name} by ${record.by} at ${record.at}: ${record.reason}`);
  }
  if (sub === "reviewers") {
    const name = project();
    const records = await call("GET", `/projects/${encodeURIComponent(name)}/reviewers`, undefined, OWNER);
    for (const record of records) console.log(`${record.id}: ${record.active ? "admitted" : "withdrawn"} by ${record.by} at ${record.at}: ${record.reason}`);
    if (!records.length) console.log(`No reviewer admissions in ${name}.`);
    return;
  }
  if (sub === "add") {
    if (!id) die("atelier models add ID --harness H --where home|cloud");
    for (const k of ["key", "api-key", "token"]) if (args[k] !== undefined) die("Atelier never stores keys; put the key in your Keychain and give its entry's name with --keychain");
    const entry = await call("PUT", `/models/${encodeURIComponent(id)}`, {
      harness: args.harness, where: args.where, provider: args.provider, endpoint: args.endpoint,
      keychain: args.keychain, aliases: args.multi.alias ?? [], note: args.note,
      state: args.state, roles: args.roles, tier: args.tier,
    }, OWNER);
    const unreached = entry.unreached?.length ? `\nWarning: could not reach projects ${entry.unreached.join(", ")}` : "";
    return console.log(`${entry.id} is in the pool: ${entry.harness}, ${entry.where}, ${entry.provider}${entry.keychain ? `, key in Keychain ${entry.keychain}` : ""}; family ${entry.family}.${unreached}`);
  }
  if (sub === "set") {
    if (!id) die("atelier models set ID --state paused|reserved|available [--note TEXT] [--roles build,review,plan] [--tier frontier|execution|budget]");
    if (args.state === undefined && args.note === undefined && args.roles === undefined && args.tier === undefined) {
      die("atelier models set ID changes one of --state, --note, --roles or --tier; name at least one");
    }
    const entry = await call("POST", `/models/${encodeURIComponent(id)}/set`, {
      state: args.state, note: args.note, roles: args.roles, tier: args.tier,
    }, OWNER);
    const state = entry.state && entry.state !== "available" ? ` ${entry.state}${entry.stateAt ? ` since ${entry.stateAt.slice(0, 16)}Z` : ""}` : "";
    const roles = entry.roles?.length ? ` roles ${entry.roles.join(",")}` : "";
    const tier = entry.tier ? ` tier ${entry.tier}` : "";
    const unreached = entry.unreached?.length ? `\nWarning: could not reach projects ${entry.unreached.join(", ")}` : "";
    return console.log(`${entry.id}:${state}${roles}${tier}${entry.note ? ` (${entry.note})` : ""}.${unreached}`);
  }
  if (sub === "remove") {
    if (!id) die("atelier models remove ID");
    const { removed, unreached: ur } = await call("DELETE", `/models/${encodeURIComponent(id)}`, undefined, OWNER);
    const unreached = ur?.length ? `\nWarning: could not reach projects ${ur.join(", ")}` : "";
    return console.log((removed ? `${id} is no longer in the pool.` : `${id} was not in the pool.`) + unreached);
  }
  if (sub === "note") {
    if (!id || args._.length !== 4) die("atelier models note ID 'text' [--item tN]");
    const body = args.item === undefined ? { text } : { text, item: args.item, project: project() };
    const note = await call("POST", `/models/${encodeURIComponent(id)}/notes`, body, OWNER);
    return console.log(`${id} has a new note, ${note.at.slice(0, 10)} by ${note.by}${note.item ? ` on ${taskOf(note)}` : ""}: ${note.text}`);
  }
  if (sub === "show") {
    if (!id) die("atelier models show ID");
    const m = (await call("GET", "/models", undefined, OWNER)).find((entry) => entry.id === id);
    if (!m) die(`${id} is not in the pool`);
    console.log(modelLine(m));
    const lines = noteLines(m);
    if (!lines.length) return console.log("  No notes yet. Add one: atelier models note ID 'text'");
    for (const line of lines) console.log(line);
    return;
  }
  if (sub) die(`${COMMAND_USAGE.models}
unknown models command "${sub}"; use add, set, remove, note, show, admit, withdraw, reviewers, assign, roles, or nothing to list`);
  const pool = await call("GET", "/models", undefined, OWNER);
  if (args.json) return console.log(JSON.stringify(pool, null, 2));
  if (!pool.length) return console.log("The pool is empty. Add a model: atelier models add ID --harness H --where home|cloud");
  for (const m of pool) console.log([modelLine(m), ...noteLines(m)].join("\n"));
}
