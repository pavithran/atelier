import { gitCommand } from "./command.mjs";
// Rules 5 and 6 of the pre-receive hook (Atelier 2.0, design section 4.4):
// the secret scan and the private-file guard over the commits a push adds,
// before the ref moves. The hook imports this after src/runtime/loader.mjs,
// so the scans are the ones the rest of Atelier runs, not copies:
// scanHistory and the allowance list from src/secret-scan.ts, privateCommits
// from cli/private-guard.mjs.
//
// The commits a push adds: for the project's branch, those NEW reaches and
// OLD does not; for any other branch (t/N, plan/N, dev/*), those NEW reaches
// and the project's branch does not, every push, so the scan of a task's
// head covers the whole task as the scan of a recorded head always has and
// a later push cannot drop a finding an earlier one recorded.
import { execFileSync } from "node:child_process";
import { privateCommits, privateCommitsText } from "../../cli/private-guard.mjs";
import { TASK_COMMITS, readAllowanceList, scanHistory, withEmptyTree } from "../secret-scan.ts";
import { readPolicy, writeReport } from "./policy.mjs";
import { openReader } from "./reader.mjs";
import { repoReader } from "../diff.ts";

const ZERO = /^0+$/;
const LISTED = 20;

// Git as the scans read history: no replacement refs rewrite a commit.
const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" };
const git = (...args) => execFileSync(gitCommand(), args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 }).trim();

// The commits `base` excludes for a push of `sha` to `ref`.
function baseOf({ old, ref, branch }) {
  // The project's branch and the provenance notes ref move by fast-forward:
  // the commits a push adds are those past the old tip.
  if (ref === `refs/heads/${branch}` || ref === "refs/notes/atelier") return ZERO.test(old) ? [] : [old];
  try { return [git("rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`)].filter(Boolean); } catch { return []; }
}

// { hash, treeHash, parents } of each commit, and the tree of each.
function commitsOf(sha, base) {
  const out = git("rev-list", `--max-count=${TASK_COMMITS + 1}`, "--no-commit-header", "--format=%H %T %P", sha, ...(base.length ? ["--not", ...base] : []));
  const lines = out.split("\n").filter(Boolean);
  if (lines.length > TASK_COMMITS) throw new Error(`the push adds more than ${TASK_COMMITS} commits, more than the scan reads`);
  const commits = lines.map((line) => {
    const [hash, treeHash, ...parents] = line.split(" ");
    return { hash, treeHash, parents };
  });
  const trees = new Map(commits.map((c) => [c.hash, c.treeHash]));
  const outside = [...new Set(commits.flatMap((c) => c.parents).filter((p) => !trees.has(p)))];
  if (outside.length) {
    for (const line of git("log", "--no-walk=unsorted", "--format=%H %T", ...outside).split("\n").filter(Boolean)) {
      const [hash, tree] = line.split(" ");
      trees.set(hash, tree);
    }
  }
  return { commits, trees };
}

const where = (f) => `${f.file}:${f.line} in ${f.commit.slice(0, 12)}`;
const more = (list) => (list.length > LISTED ? `, and ${list.length - LISTED} more` : "");

// Runs both rules for one ref update. Returns the refusal, or null when the
// push may go on. Writes the secret scan's report to `reportPath` whenever
// the scan completed. Throws nothing: a scan that cannot read the push
// refuses it.
export async function checkPush({ old, sha, ref, branch, task, policyPath, reportPath }) {
  let policy, base, commits, trees;
  try {
    policy = readPolicy(policyPath);
    base = baseOf({ old, ref, branch });
    ({ commits, trees } = commitsOf(sha, base));
  } catch (error) {
    return `the push could not be read for the secret scan (${error.message.split("\n")[0]}); nothing was pushed`;
  }
  if (!commits.length) return null;
  const refusals = [];
  // Rule 5: every key-shaped line the commits add, less those the
  // allowance list at the head permits; a hit the owner cleared on the task
  // (same file, same fingerprint) is reported and does not refuse.
  const repo = openReader(process.cwd(), { env });
  try {
    const r = withEmptyTree(repoReader(repo));
    const head = commits.find((c) => c.hash === sha);
    const scan = await scanHistory(r, commits, trees, () => readAllowanceList(r, head.treeHash));
    const cleared = (h) => policy.clearances.some((c) => c.file === h.file && c.fingerprint === h.fingerprint);
    const standing = scan.hits.filter((h) => !cleared(h));
    // A push to a task's or a plan's branch records an unscanned file on its
    // item. The project's branch and dev/* have no item, so an unscanned
    // file there refuses the push, unless the owner cleared it on the grant's
    // task (a landing grant carries one).
    const recorded = /^refs\/heads\/(t|plan)\/\d+$/.test(ref);
    const unread = recorded ? [] : scan.unscanned.filter((u) => !cleared(u));
    writeReport(reportPath, { ref, head: sha, hits: scan.hits, unscanned: scan.unscanned, refused: standing.length > 0 });
    if (unread.length) {
      refusals.push(`the secret scan could not read ${unread.slice(0, LISTED).map((u) => `${u.file} in ${u.commit.slice(0, 12)} (${u.reason})`).join(", ")}${more(unread)}, and this branch has no task to record that on`);
    }
    if (standing.length) {
      refusals.push(`the secret scan found a key-shaped line: ${standing.slice(0, LISTED).map(where).join(", ")}${more(standing)}. Take it out of the commit that adds it (rewrite the commits), or ask the owner to clear it${task ? ` (atelier clear-secret ${task})` : ""}, then push again`);
    }
  } catch (error) {
    refusals.push(`the secret scan could not read this push (${error.message.split("\n")[0]})`);
  } finally {
    repo[Symbol.dispose]();
  }
  // Rule 6: no commit adds, changes or retypes a private path.
  if (policy.private.length) {
    try {
      const found = privateCommits(process.cwd(), policy.private, sha, base);
      if (found.length) refusals.push(`the push would carry private files: ${privateCommitsText(found)}. They never leave the developer's Macs; take them out of those commits and push again`);
    } catch (error) {
      refusals.push(error.message);
    }
  }
  return refusals.length ? `${refusals.join("; ")}. Nothing was pushed.` : null;
}
