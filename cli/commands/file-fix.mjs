// atelier file-fix. Its forms, flags and help are declared in src/usage/commands/file-fix.ts.
import { I, OWNER, args, call, die, itemArg, project } from "../atelier.mjs";

// A task filed from one of the goal's notes (G6): the server files none by
// itself. Filing a note already filed answers its task and changes nothing.
export default async function fileFixCommand() {
  const name = project(), id = itemArg();
  const raw = args["from-note"];
  if (typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw)) die(`--from-note names the note by its number, as atelier show ${id} lists them: atelier file-fix ${id} --from-note N`);
  const r = await call("POST", `${I(name, id)}/file-fix`, { note: Number(raw) }, OWNER);
  console.log(r.already
    ? `Note ${r.note} on ${id} was already filed as ${r.item.id}; nothing changed.`
    : `${r.item.id}: filed from note ${r.note} on ${id}: ${r.item.title}. Dispatch it with atelier dispatch ${r.item.id} --agent H --model M.`);
}
