// atelier baseline-token. Its forms, flags and help are declared in src/usage/commands/baseline-token.ts.
import { P, actor, call, project, readGrant } from "../atelier.mjs";

// A read grant for the project's branch (POST git-token, kind read), with
// the project's regenerate command beside it, so a build's runner can merge
// current main into the workspace before it submits and regenerate what the
// merge made stale (prepareBuildSubmission in cli/runner.mjs). A runner
// token may ask for one for any project it serves.
export default async function baselineTokenCommand() {
  const name = project(), as = await actor();
  const [base, { project: record }] = await Promise.all([
    readGrant(name, null, as),
    call("GET", P(name), undefined, as),
  ]);
  const regenerate = typeof record?.policy?.regenerate === "string" && record.policy.regenerate.trim() ? record.policy.regenerate : null;
  console.log(JSON.stringify({ remote: base.remote, token: base.token, defaultBranch: base.defaultBranch, regenerate }));
}
