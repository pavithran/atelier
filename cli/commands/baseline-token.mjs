// atelier baseline-token. Its forms, flags and help are declared in src/usage/commands/baseline-token.ts.
import { P, actor, call, project } from "../atelier.mjs";

// A read token for the project's baseline (POST projects/NAME/baseline-token,
// scope read), with the project's regenerate command beside it, so a build's
// runner can merge current main into the workspace before it submits and
// regenerate what the merge made stale (prepareBuildSubmission in
// cli/runner.mjs). The project-level route is the one a runner token may
// call for any project it serves: base-token answers a runner only for the
// job it holds, so a part's runner cannot read main through its plan's.
export default async function baselineTokenCommand() {
  const name = project(), as = await actor();
  const [base, { project: record }] = await Promise.all([
    call("POST", `${P(name)}/baseline-token`, { scope: "read" }, as),
    call("GET", P(name), undefined, as),
  ]);
  const regenerate = typeof record?.policy?.regenerate === "string" && record.policy.regenerate.trim() ? record.policy.regenerate : null;
  console.log(JSON.stringify({ remote: base.remote, token: base.token, defaultBranch: base.defaultBranch, regenerate }));
}
