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
export function pushHistory(git, cwd, { remote, token, branch, say, step = PUSH_STEP, head: pinned = null }) {
  // Pushed by the id of the commit the guard scanned, when given (t645).
  const whole = ["push", "--quiet", "--recurse-submodules=no", remote, pinned ? `${pinned}:refs/heads/${branch}` : `${branch}:${branch}`];
  const first = git(whole, { cwd, token, allowFail: true });
  if (first.status === 0) return;
  const refusal = said(first, token);
  const failed = new Error(`git ${whole.join(" ")} failed:\n${refusal}`);
  if (!refusedForSize(refusal)) throw failed;

  const read = baselineTip(git, cwd, remote, token, branch);
  if (read.error) throw new Error(`${failed.message}\nThe baseline's ${branch} could not be read afterwards, so the steps cannot start from what it holds. git said:\n${indent(read.error)}`);
  const held = read.tip;
  const head = pinned ?? git(["rev-parse", "--verify", `${branch}^{commit}`], { cwd });
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

// A task's push answered 413 (t577). The runner route, like any HTTP remote
// with a body limit in front of it, refuses a pack over that limit with
// "RPC failed; HTTP 413", and a runner's finish then stranded the build: t544
// on home:studio-3 pushed ~96 regenerated PNGs in one pack, the claim was
// preserved, and nothing was submitted for seven hours. Pushing the
// first-parent commits one at a time got all but one through.
export const refused413 = (text) => /(?:HTTP|returned error:)\s*413\b/i.test(String(text ?? ""));

const SHORT = (sha) => String(sha).slice(0, 8);
const mb = (bytes) => bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

// What a commit brings that `prev` lacks: the object count and the sum of
// their sizes as Git stores them (git cat-file's objectsize:disk), which is
// about the size of the pack a push of that commit sends.
export function commitWeight(git, cwd, commit, prev) {
  const listed = git(["rev-list", "--objects", commit, ...(prev ? [`^${prev}`] : [])], { cwd, allowFail: true });
  const names = listed.status === 0 ? String(listed.stdout).split("\n").map((l) => l.split(" ")[0]).filter(Boolean) : [];
  if (!names.length) return { objects: 0, bytes: 0 };
  const sized = git(["cat-file", "--batch-check=%(objectsize:disk)"], { cwd, allowFail: true, input: `${names.join("\n")}\n` });
  const bytes = sized.status === 0 ? String(sized.stdout).split("\n").map(Number).filter(Number.isFinite).reduce((a, b) => a + b, 0) : 0;
  return { objects: names.length, bytes };
}

// Pushes HEAD to `remote`'s `branch` one first-parent commit at a time,
// oldest first, after a push of the whole answered 413. Each step moves the
// branch to a commit whose first parent the remote already holds, so every
// step is a fast-forward. A step that answers 413 itself is a commit too
// large on its own: it is pushed once to `fallback` (the fork's own URL, for
// a workspace on the runner route) when one is given, and otherwise the
// push stops with the commit, its size and `ownerHint`. `git` is the CLI's
// helper; each call passes `opts` (token, env) through. Returns the commits
// pushed; throws with a message for the caller to print.
export function pushCommitsInTurn(git, cwd, { remote, branch, head: pinned = null, opts = {}, say = () => {}, fallback = null, ownerHint = "", refusal = "" }) {
  const run = (args, extra = {}) => git(args, { cwd, ...opts, ...extra, allowFail: true });
  const out = (r) => String(r.stdout ?? "").trim();
  const told = (r) => { let t = String(r.stderr || r.stdout || r.error?.message || "").trim(); if (opts.token) t = t.split(opts.token).join("[redacted]"); return t; };
  const tipOf = () => {
    const r = run(["ls-remote", remote, `refs/heads/${branch}`]);
    if (r.status !== 0) return { error: told(r) || `git ls-remote exited with status ${r.status}` };
    return { tip: /^([0-9a-f]{40,64})\s/.exec(String(r.stdout ?? ""))?.[1] ?? null };
  };
  const ancestor = (older, newer) => run(["merge-base", "--is-ancestor", older, newer]).status === 0;
  // The commit the guarded push scanned, when given, never HEAD as it may
  // be by now (t645).
  const head = pinned ?? out(run(["rev-parse", "--verify", "HEAD^{commit}"]));
  const read = tipOf();
  if (read.error) throw new Error(`the push answered 413, and ${branch} could not be read from the remote afterwards, so the commits cannot be pushed one at a time:\n${indent(read.error)}`);
  const held = read.tip;
  if (held === head) return [];
  if (held && !ancestor(held, head)) throw new Error(`the push answered 413, and the remote's ${branch} (${SHORT(held)}) is not an ancestor of HEAD, so the commits cannot be pushed one at a time as fast-forwards.`);
  const line = out(run(["rev-list", "--first-parent", "--reverse", head, ...(held ? [`^${held}`] : [])])).split("\n").filter(Boolean);
  const steps = held ? line.filter((c) => ancestor(held, c)) : line;
  if (!steps.length || steps.at(-1) !== head) steps.push(head);
  say(`The push of ${branch} answered 413 (too large for one request)${refusal ? `:\n${indent(refusal)}` : "."}\nPushing the ${steps.length} unpushed first-parent commit${steps.length === 1 ? "" : "s"} one at a time, oldest first.`);

  let prev = held;
  const pushed = [];
  for (const [i, commit] of steps.entries()) {
    const spec = `${commit}:refs/heads/${branch}`;
    const r = run(["push", "--quiet", "--recurse-submodules=no", remote, spec]);
    const now = r.status !== 0 ? tipOf() : null;
    if (now && now.tip !== commit) {
      const why = told(r);
      // What a read or an upload said is never dropped from the error: a
      // refused token (401/403) in it is what the caller renews on (t705).
      const afterwards = now.error ? `\nReading ${branch} from the remote afterwards failed too, so it may hold more than this says. git said:\n${indent(now.error)}` : "";
      if (!refused413(why)) throw new Error(`the push of commit ${i + 1} of ${steps.length} (${SHORT(commit)}) failed; the remote holds ${branch} at ${prev ? SHORT(prev) : "nothing yet"}.\ngit said:\n${indent(why)}${afterwards}`);
      const { objects, bytes } = commitWeight(git, cwd, commit, prev);
      const subject = out(run(["log", "-1", "--format=%s", commit]));
      const weight = `${objects} object${objects === 1 ? "" : "s"}, about ${mb(bytes)} as git stores them`;
      let viaFork = false, forkSaid = "";
      if (fallback) {
        say(`Commit ${SHORT(commit)} ("${subject}") answered 413 on its own (${weight}); pushing it once to the fork's own URL.`);
        const f = run(["push", "--quiet", "--recurse-submodules=no", fallback, spec]);
        const check = f.status === 0 ? null : tipOf();
        viaFork = f.status === 0 || check.tip === commit;
        if (!viaFork) {
          forkSaid = `\nThe push to the fork's own URL failed too. git said:\n${indent(told(f))}${check.error ? `\nReading ${branch} from the remote afterwards failed too. git said:\n${indent(check.error)}` : ""}`;
          say(forkSaid.trim());
        }
      }
      if (!viaFork) {
        throw new Error([
          `commit ${SHORT(commit)} ("${subject}") is too large to push on its own: ${weight}. The push answered 413 even for this one commit.`,
          `${i} of ${steps.length} unpushed commit${steps.length === 1 ? "" : "s"} went through; the remote holds ${branch} at ${prev ? SHORT(prev) : "nothing yet"}.`,
          ...(ownerHint ? [ownerHint] : []),
          `git said:\n${indent(why)}${afterwards}${forkSaid}`,
        ].join("\n"));
      }
    }
    prev = commit;
    pushed.push(commit);
    say(`Pushed commit ${i + 1} of ${steps.length} (${SHORT(commit)}).`);
  }
  return pushed;
}
