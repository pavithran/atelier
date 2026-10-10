// atelier models. Its forms, flags and help are declared in src/usage/commands/models.ts.
import { join } from "node:path";
import { COMMAND_USAGE } from "../help.mjs";
import { OWNER, args, at, call, die, project } from "../atelier.mjs";

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
    return `${m.where.padEnd(5)} ${m.harness}/${m.id}  ${m.family}  ${s}${m.keychain ? `  key: ${m.keychain}` : ""}`;
  };
  const taskOf = (n) => (n.project ? `${n.projectName ?? n.project}/${n.item}` : n.item);
  const noteLines = (m) => (m.notes ?? []).map((n) => `  ${n.at.slice(0, 10)} by ${n.by}${n.item ? ` on ${taskOf(n)}` : ""}: ${n.text}`);
  if (sub === "add") {
    if (!id) die("atelier models add ID --harness H --where home|cloud");
    for (const k of ["key", "api-key", "token"]) if (args[k] !== undefined) die("Atelier never stores keys; put the key in your Keychain and give its entry's name with --keychain");
    const entry = await call("PUT", `/models/${encodeURIComponent(id)}`, {
      harness: args.harness, where: args.where, provider: args.provider, endpoint: args.endpoint,
      keychain: args.keychain, aliases: args.multi.alias ?? [], note: args.note,
    }, OWNER);
    return console.log(`${entry.id} is in the pool: ${entry.harness}, ${entry.where}, ${entry.provider}${entry.keychain ? `, key in Keychain ${entry.keychain}` : ""}; family ${entry.family}.`);
  }
  if (sub === "remove") {
    if (!id) die("atelier models remove ID");
    const { removed } = await call("DELETE", `/models/${encodeURIComponent(id)}`, undefined, OWNER);
    return console.log(removed ? `${id} is no longer in the pool.` : `${id} was not in the pool.`);
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
  if (sub) die(`${COMMAND_USAGE.models}\nunknown models command "${sub}"; use add, remove, note, show, or nothing to list`);
  const pool = await call("GET", "/models", undefined, OWNER);
  if (!pool.length) return console.log("The pool is empty. Add a model: atelier models add ID --harness H --where home|cloud");
  for (const m of pool) console.log([modelLine(m), ...noteLines(m)].join("\n"));
}
