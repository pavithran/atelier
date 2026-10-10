// atelier unwrap. Its forms, flags and help are declared in src/usage/commands/unwrap.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UNWRAP_RELAY, fileExcerpt, handoffNotes, sessionNoteText } from "../../src/sessions.ts";
import { OWNER, OWNER_NAME, P, actor, at, call, checkoutStatusLine, formatStanding, git, project, remoteStatusLines, server, sessionCheckout, sessionFiles, sessionTree } from "../atelier.mjs";

export default async function unwrapCommand() {
  const name = project(), as = await actor(OWNER), cwd = sessionCheckout(name);
  const standing = await call("GET", `${P(name)}/standing`, undefined, as);
  console.log(formatStanding(standing, OWNER_NAME, server()));
  console.log(await checkoutStatusLine(name, as));
  if (cwd) for (const line of remoteStatusLines(name, cwd)) console.log(line);
  if (cwd) {
    console.log(`Current branch: ${git(["branch", "--show-current"], { cwd }) || "detached HEAD"}`);
    console.log(`Uncommitted files:\n${sessionTree(cwd) || "none"}`);
  }
  const [note] = await call("GET", `${P(name)}/sessions`, undefined, as);
  console.log(sessionNoteText(note));
  if (cwd) {
    const files = sessionFiles(cwd);
    if (files.state) console.log(fileExcerpt(files.state, files.contents));
    else console.log("State file: none (looked for docs/STATE.md, STATE.md and PROJECT.md).");
    for (const path of handoffNotes(files.contents, files.paths, note?.at, files.modified)) console.log(fileExcerpt(path, readFileSync(join(cwd, path), "utf8")));
  }
  console.log(UNWRAP_RELAY);
}
