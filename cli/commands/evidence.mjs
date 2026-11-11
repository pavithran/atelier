// atelier evidence. Its forms, flags and help are declared in src/usage/commands/evidence.ts.
import { readFileSync } from "node:fs";
import { COMMAND_USAGE } from "../help.mjs";
import { CLAIM_MAX, OUTPUT_MAX } from "../../src/text.ts";
import { I, OWNER, actingHeaders, actor, args, call, die, itemArg, project, tokenActor } from "../atelier.mjs";

// The file's last OUTPUT_MAX characters, never starting inside a surrogate pair.
export function keptTail(text) {
  const kept = text.length > OUTPUT_MAX ? text.slice(-OUTPUT_MAX) : text;
  return /^[\udc00-\udfff]/.test(kept) ? kept.slice(1) : kept;
}

// The orchestrator records text evidence at a task's head for the developer
// (src/relayed-evidence.ts). Everything that can be refused here is refused
// before a request: a note over CLAIM_MAX, a file that cannot be read. The
// server checks the head, the token and the task's state, and says when the
// same evidence is already recorded.
export default async function evidenceCommand() {
  const id = itemArg();
  const head = typeof args.head === "string" ? args.head.trim() : "";
  const note = typeof args.note === "string" ? args.note.trim() : "";
  if (!head || !note) die(COMMAND_USAGE.evidence);
  if (note.length > CLAIM_MAX) die(`the note is ${note.length} characters; the limit is ${CLAIM_MAX}. Shorten it; it is not cut. Put the long part in a file with --file`);
  if (args.quote !== undefined && (typeof args.quote !== "string" || !args.quote.trim())) die("--quote needs the developer's words");
  let file = {};
  if (args.file !== undefined) {
    let text;
    try { text = readFileSync(String(args.file), "utf8"); }
    catch (error) { die(`cannot read --file ${args.file}: ${error.code ?? error.message}; nothing was sent`); }
    const outputTail = keptTail(text.replace(/\r\n/g, "\n"));
    file = { outputTail, outputLength: text.replace(/\r\n/g, "\n").length };
  }
  const quote = typeof args.quote === "string" ? { quote: args.quote.trim() } : {};
  const name = project();
  await actor(OWNER);
  if (tokenActor) die("an agent's own token cannot record this evidence; it takes the developer token, with the acting model named by --as H/M or ATELIER_ACTING");
  if (!actingHeaders()["x-atelier-acting"]) die("evidence names the model acting for the developer: add --as H/M or set ATELIER_ACTING, such as claude-code/opus-5.5");
  const d = await call("POST", `${I(name, id)}/evidence-note`, { head, note, ...file, ...quote }, OWNER, actingHeaders());
  const cut = file.outputTail !== undefined && file.outputLength > file.outputTail.length ? ` Its file was cut to the last ${file.outputTail.length} of ${file.outputLength} characters.` : "";
  console.log(d.alreadyRecorded
    ? `${id}: this evidence is already recorded at ${head.slice(0, 8)}; nothing new was recorded.`
    : `${id}: recorded at ${head.slice(0, 8)} for review, apart from reports. It counts toward a criterion that names the run or result; it is no required check.${cut}`);
}
