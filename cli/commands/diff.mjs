// atelier diff. Its forms, flags and help are declared in src/usage/commands/diff.ts.
import { OWNER, actor, cleanClone, git, itemArg, project, removeClone, taskReadGrant } from "../atelier.mjs";

// Reviewers: read another agent's work without being able to change it.
export default async function diffCommand() {
  const name = project(), id = itemArg(), as = await actor(OWNER);
  const ws = await taskReadGrant(name, id, as);
  const { dir } = cleanClone(ws.remote, ws.token, ws.head, null, name, ws.branch);
  try {
    git(["fetch", "--quiet", ws.remote, ws.into], { cwd: dir, token: ws.token });
    const mb = git(["merge-base", "FETCH_HEAD", "HEAD"], { cwd: dir });
    process.stdout.write(git(["log", "--format=%h %s", `${mb}..HEAD`], { cwd: dir }) + "\n\n");
    process.stdout.write(git(["diff", "--stat", mb, "HEAD"], { cwd: dir }) + "\n\n");
    process.stdout.write(git(["diff", mb, "HEAD"], { cwd: dir }) + "\n");
  } finally {
    removeClone(dir);
  }
}
