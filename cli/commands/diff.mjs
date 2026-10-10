// atelier diff. Its forms, flags and help are declared in src/usage/commands/diff.ts.
import { I, OWNER, actor, call, cleanClone, git, itemArg, project, removeClone } from "../atelier.mjs";

// Reviewers: read another agent's work without being able to change it.
export default async function diffCommand() {
  const name = project(), id = itemArg(), as = await actor(OWNER);
  const ws = await call("POST", `${I(name, id)}/read-token`, {}, as);
  const base = await call("POST", `${I(name, id)}/base-token`, { scope: "read" }, as);
  const { dir } = cleanClone(ws.remote, ws.token, ws.head, null, name);
  try {
    git(["fetch", "--quiet", base.remote, base.defaultBranch], { cwd: dir, token: base.token });
    const mb = git(["merge-base", "FETCH_HEAD", "HEAD"], { cwd: dir });
    process.stdout.write(git(["log", "--format=%h %s", `${mb}..HEAD`], { cwd: dir }) + "\n\n");
    process.stdout.write(git(["diff", "--stat", mb, "HEAD"], { cwd: dir }) + "\n\n");
    process.stdout.write(git(["diff", mb, "HEAD"], { cwd: dir }) + "\n");
  } finally {
    removeClone(dir);
  }
}
