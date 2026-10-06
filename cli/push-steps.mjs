// A project's history pushed to its new baseline, in steps when one push is
// too much. Artifacts refuses a push over its size or time limits, and a long
// history can be over them as one pack. The push is tried whole first; when
// it is refused for size or time, the first-parent line is pushed oldest
// first, about PUSH_STEP commits at a time. Each step moves the baseline's
// branch itself to a commit that has the branch's previous tip as an
// ancestor, so every step is a fast-forward and the branch always names a
// commit whose history the baseline holds in full.
//
// What the baseline holds is its branch tip, read from the baseline itself, so
// a run that stopped partway is resumed by running again: the steps begin
// after that tip.

export const PUSH_STEP = 700;

// How a push refused for size or time reads in Git's output: an HTTP status
// from Artifacts or a proxy in front of it (request too large, request
// timeout, gateway errors and gateway timeouts), a hook or server message
// about a limit, and a connection the server dropped partway through the
// pack. Nothing else (a rejected token, a branch that is not a fast-forward)
// is pushed again in steps: those fail the same way at every step.
const REFUSALS = [
  /(?:HTTP|returned error:)\s+(?:408|413|502|504|522|524)\b/i,
  /too (?:large|big)/i,
  /exceed(?:s|ed)?\b/i,
  /size limit|storage limit|over the limit|quota/i,
  /time[ds]? ?out|timeout/i,
  /hung up unexpectedly|unexpected disconnect/i,
];
export const refusedForSize = (text) => REFUSALS.some((re) => re.test(text));

// Git's own account of a failed command, with the token cut out of it.
const said = (result, token) => {
  const text = (result.stderr || result.stdout || "").trim();
  return token ? text.split(token).join("[redacted]") : text;
};
const indent = (text) => text.split("\n").map((line) => `  ${line}`).join("\n");

// The commit the baseline's branch names as { tip }, with a tip of null when
// the baseline has no such branch, or { error } with Git's account when the
// baseline cannot be read.
function baselineTip(git, cwd, remote, token, branch) {
  const r = git(["ls-remote", remote, `refs/heads/${branch}`], { cwd, token, allowFail: true });
  if (r.status !== 0) return { error: said(r, token) || `git ls-remote exited with status ${r.status}` };
  return { tip: /^([0-9a-f]{40,64})\s/.exec(r.stdout)?.[1] ?? null };
}

// Pushes `branch` to the baseline's branch of the same name. A push refused
// for size or time is repeated in steps; any other failure, and a refusal the
// steps cannot help (the history is no longer than one step, or the
// baseline's branch is not an ancestor of the checkout's), throws with Git's
// message. A step that fails throws with the commit the baseline then holds.
// A push reported as failed after the baseline took it (a timeout that came
// after the last byte) counts as pushed. `git` is the CLI's helper; `say`
// prints a line of progress. Every push, the steps too, runs the checkout's
// pre-push hook: a refusal by that hook can read like one for size or time,
// and the steps must not carry the history past it.
export function pushHistory(git, cwd, { remote, token, branch, say, step = PUSH_STEP }) {
  const whole = ["push", "--quiet", "--recurse-submodules=no", remote, `${branch}:${branch}`];
  const first = git(whole, { cwd, token, allowFail: true });
  if (first.status === 0) return;
  const refusal = said(first, token);
  const failed = new Error(`git ${whole.join(" ")} failed:\n${refusal}`);
  if (!refusedForSize(refusal)) throw failed;

  const read = baselineTip(git, cwd, remote, token, branch);
  if (read.error) throw new Error(`${failed.message}\nThe baseline's ${branch} could not be read afterwards, so the steps cannot start from what it holds. git said:\n${indent(read.error)}`);
  const held = read.tip;
  const head = git(["rev-parse", "--verify", `${branch}^{commit}`], { cwd });
  if (held === head) {
    say(`The push was reported as failed, but the baseline holds ${branch} at ${head.slice(0, 8)}: nothing is left to push.`);
    return;
  }
  const ancestor = (older, newer) => git(["merge-base", "--is-ancestor", older, newer], { cwd, allowFail: true }).status === 0;
  if (held && !ancestor(held, head)) throw failed;

  // The first-parent commits the baseline lacks, oldest first, and from them
  // one commit per step. A commit on the line that does not descend from the
  // baseline's tip (the tip came in through a merge's second parent) cannot
  // be a step; the first step that does carries it. The last step is the head.
  const line = git(["rev-list", "--first-parent", "--reverse", head, ...(held ? [`^${held}`] : [])], { cwd }).split("\n").filter(Boolean);
  const picks = [];
  for (let i = step - 1; i < line.length - 1; i += step) picks.push(line[i]);
  picks.push(head);
  const steps = held ? picks.filter((commit) => ancestor(held, commit)) : picks;
  if (steps.length < 2) throw failed;

  const count = (commit) => Number(git(["rev-list", "--first-parent", "--count", commit], { cwd }));
  const total = count(head);
  say(`The push of ${branch}'s history in one piece was refused:\n${indent(refusal)}`);
  say(held
    ? `The baseline already holds ${branch} up to commit ${count(held)} of ${total} (${held.slice(0, 8)}). Pushing the rest of the first-parent history in ${steps.length} steps of about ${step} commits, oldest first.`
    : `Pushing the first-parent history of ${branch}, ${total} commits, in ${steps.length} steps of about ${step} commits, oldest first.`);

  let reached = held;
  for (const [i, commit] of steps.entries()) {
    const r = git(["push", "--quiet", "--recurse-submodules=no", remote, `${commit}:refs/heads/${branch}`], { cwd, token, allowFail: true });
    const position = count(commit);
    if (r.status !== 0) {
      const now = baselineTip(git, cwd, remote, token, branch);
      if (now.tip !== commit) {
        throw new Error([
          `the push for step ${i + 1} of ${steps.length} (commit ${position} of ${total} on ${branch}'s first-parent line) failed.`,
          reached
            ? `The baseline holds ${branch} up to commit ${count(reached)} of ${total}: ${reached}.\nRun atelier init again, with the same options, to resume from there.`
            : `The baseline holds none of ${branch}'s history yet.\nRun atelier init again, with the same options, to try from the first step.`,
          ...(now.error ? [`Reading the baseline's ${branch} afterwards failed too, so this may be less than it holds. git said:\n${indent(now.error)}`] : []),
          `git said:\n${indent(said(r, token))}`,
        ].join("\n"));
      }
    }
    reached = commit;
    say(`Step ${i + 1} of ${steps.length}: the baseline holds ${branch} up to commit ${position} of ${total} (${commit.slice(0, 8)}).`);
  }
}
