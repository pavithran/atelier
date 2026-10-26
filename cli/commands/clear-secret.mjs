// atelier clear-secret. Its forms, flags and help are declared in src/usage/commands/clear-secret.ts.
import { COMMAND_USAGE } from "../help.mjs";
import { directionText } from "../../src/rules.ts";
import { I, OWNER, actingHeaders, actor, args, call, die, directionArg, flat, itemArg, project, tokenActor } from "../atelier.mjs";

// The owner clears a task's standing secret flags with a reason (t571), the
// route the web page's form posts to (clear-secret in src/index.ts,
// Ledger.clearSecret). The server checks the reason (secretClearReason) and
// refuses a scan still pending (secret_pending) or a task with nothing
// flagged (no_secret); this only asks for the note before calling it. The
// answer is the item: every flag at its head is now marked cleared, and
// secretClearances holds the reason against each line's file and fingerprint.
export default async function clearSecretCommand() {
  const note = typeof args.note === "string" ? args.note : "";
  if (!note.trim()) die(`a clearance needs the reason the flagged lines are safe: ${COMMAND_USAGE["clear-secret"]}`);
  const name = project(), id = itemArg();
  // --quote carries the developer's words (t178), recorded with the clearance
  // and the model (--as) that relayed them; a model acting on the developer
  // token without them is stopped by the server, which names the command to
  // run on the developer's yes.
  const direction = directionArg(`clear-secret ${id} --note "why"`);
  await actor(OWNER);
  if (direction.quote !== undefined && tokenActor) die("an agent's own token cannot carry the developer's words: --quote goes with the developer token");
  const item = await call("POST", `${I(name, id)}/clear-secret`, { reason: note, ...direction }, OWNER, actingHeaders());
  const head = (item.head ?? "").slice(0, 8);
  const flags = (item.secret ?? []).filter((f) => f.cleared && (!item.head || f.head === item.head));
  const clearances = item.secretClearances ?? [];
  console.log(`${id}: cleared ${flags.length} secret flag${flags.length === 1 ? "" : "s"} at ${head}.`);
  for (const f of flags) {
    const c = clearances.find((x) => x.file === f.file && x.fingerprint === f.fingerprint);
    const where = f.unscanned ? `${flat(f.file)} (not read in full)` : `${flat(f.file)}:${f.line}`;
    console.log(`  ${where}${c ? `, cleared at ${(c.head ?? "").slice(0, 8)} by ${c.by}: ${flat(c.reason)}${c.quote ? `, on ${directionText(c)}` : ""}` : ""}`);
  }
}
