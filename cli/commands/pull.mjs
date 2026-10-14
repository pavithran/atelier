// atelier pull. Its forms, flags and help are declared in src/usage/commands/pull.ts.
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { adoptOldLanding, describeTouched, executablePaths, landingJournalFile, landingLock, touchedExecutables, treeEntries } from "../landing.mjs";
import { foldPath, pathCollisions } from "../../src/rules.ts";
import { carryBaseline, loadPairs, savePairs, useRealHistory } from "../fresh.mjs";
import { historyOverride } from "../pull.mjs";
import { COMMAND_USAGE } from "../help.mjs";
import { OWNER, P, args, call, cfg, die, gitEnv, landingGit, landingHome, project, short } from "../atelier.mjs";

// The developer, on one of the Macs that share a project's baseline (t644):
// another Mac has carried commits to the baseline (atelier sync, merge or
// publish there), and this checkout's main is brought up to it, with the
// receipts on refs/notes/atelier. As atelier clone does (t643), it keeps no
// token: it mints a read token, as sync mints its own, and passes it only to
// the fetches, which read by URL and check nothing out. Every Git command
// runs with every hook off (landingGit).
//
// The notes are fetched to FETCH_HEAD and merged into this checkout's own, so
// a receipt made here and not yet pushed is kept; a forced refspec onto
// refs/notes/atelier would drop it. Where both sides hold a different note
// for one commit, the two are kept together (git notes merge -s union).
//
// Main is fast-forwarded when it holds nothing the baseline lacks. With local
// commits, the merge is made with git merge-tree, which writes no file: a
// conflict stops the pull with main, the index and the work tree as they
// were, and names the paths. A baseline holding part of the history
// (cli/fresh.mjs) has its new commits carried into this checkout through the
// baseline map first, and the merge takes the baseline's side as its first
// parent, since atelier sync carries only a first-parent line that continues
// from the commit the baseline matches.
export default async function pullCommand() {
  // Every Git command here, and the commit rebuilds in cli/fresh.mjs, reads
  // the objects themselves, never a replacement or a graft of them
  // (REAL_HISTORY_ENV in cli/fresh.mjs): one that gave main the baseline's
  // head as a parent would make pull report it held what it lacks (Astra's
  // reviews of t644).
  useRealHistory(process.env);
  const git = landingGit;
  if (args._.length > 1) die(COMMAND_USAGE.pull);
  const name = project();
  const p = cfg.projects?.[name] ?? die(`${name} is not registered on this Mac; make its checkout with atelier clone ${name}`), cwd = p.path;
  if (git(["status", "--porcelain"], { cwd })) die("the registered checkout has uncommitted changes; commit or set them aside first, then pull");
  // The branch by its full name: a tag of the same name is not main.
  if (git(["symbolic-ref", "-q", "HEAD"], { cwd, allowFail: true }).stdout?.trim() !== `refs/heads/${p.branch}`) die(`check out ${p.branch} in ${cwd} first`);
  // A grafts file or a shallow boundary changes the history Git shows and
  // cannot be turned off for one command, so pull reads none.
  const override = historyOverride(git, cwd);
  if (override) die(`${override}. Nothing was pulled.`);
  const gitDir = git(["rev-parse", "--absolute-git-dir"], { cwd }), landing = landingHome(gitDir);
  let unlock;
  try { unlock = landingLock(landing); } catch (error) { die(error.message); }
  try {
    try { adoptOldLanding(gitDir, landing); } catch (error) { die(error.message); }
    if (existsSync(landingJournalFile(landing))) die("a merge is in progress; finish it or cancel it first");
    const base = await call("POST", `${P(name)}/baseline-token`, { scope: "read" }, OWNER);
    git(["fetch", "--quiet", "--no-tags", base.remote, p.branch], { cwd, token: base.token });
    const baselineHead = git(["rev-parse", "FETCH_HEAD"], { cwd });
    const listed = git(["ls-remote", base.remote, "refs/notes/atelier"], { cwd, token: base.token });
    let notesTip = null;
    if (listed) {
      git(["fetch", "--quiet", "--no-tags", base.remote, "refs/notes/atelier"], { cwd, token: base.token });
      notesTip = git(["rev-parse", "FETCH_HEAD"], { cwd });
    }
    // Nothing below reaches the baseline.
    const receipts = notesTip ? mergeNotes(git, cwd, notesTip) : null;
    const receiptsLine = receipts === null ? "The baseline holds no receipts." : `Receipts: ${receipts} new on refs/notes/atelier, merged with this checkout's own.`;

    let target = baselineHead, pair = () => {};
    const fresh = p.fresh === true;
    if (fresh) {
      const pairs = loadPairs(gitDir, name);
      let carried;
      try { carried = carryBaseline(git, cwd, baselineHead, pairs); } catch (error) { die(error.message); }
      target = carried.head;
      // The new pairs are saved once main holds them, never before: after a
      // pull that conflicts, main does not hold the baseline's head, and
      // sync must still find it unpaired and name atelier pull (review of
      // t644, finding 3). A later pull carries the same commits again.
      if (Object.keys(carried.pairs).length) pair = () => savePairs(gitDir, name, { ...pairs, ...carried.pairs });
    }
    const head = git(["rev-parse", "--verify", `refs/heads/${p.branch}^{commit}`], { cwd });
    const holds = (older, newer) => git(["merge-base", "--is-ancestor", older, newer], { cwd, allowFail: true }).status === 0;
    if (holds(target, head)) {
      pair();
      console.log(`${name}: ${p.branch} @ ${short(head)} already holds the baseline's ${p.branch} @ ${short(baselineHead)}; no commits to bring.`);
      return console.log(receiptsLine);
    }
    const count = (range) => Number(git(["rev-list", "--count", range], { cwd }));
    const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
    const brought = count(`${head}..${target}`), local = count(`${target}..${head}`);
    const subjects = git(["log", "--format=  %h %s", "-n", "20", `${head}..${target}`], { cwd });
    // The tree main would hold is checked before the work tree changes, as
    // atelier merge checks a landing's (Astra's third review of t644), with
    // the same checks: paths a Mac stores as one file, which Git would write
    // one over the other, and files this checkout's Git configuration runs
    // (hooks, filter and merge driver commands, included configuration
    // files), which the checkout would run, during it or at the next Git
    // command, as the baseline changed them.
    const unchanged = `Nothing was pulled: ${p.branch} is still at ${short(head)}, and the work tree is as it was.`;
    const checkTree = (tree) => {
      const clashes = pathCollisions(treeEntries(git(["ls-tree", "-r", "-z", "--full-tree", tree], { cwd, raw: true })).map((e) => e.path));
      if (clashes.length) die(`${p.branch} with the baseline's ${p.branch} would hold paths that a Mac stores as one file, since they differ only by letter case or Unicode form: ${clashes.map((g) => g.join(" and ")).join("; ")}. Git would write one over the other in this checkout. ${unchanged} Rename or remove all but one of each, on the baseline or here, then run atelier pull --project ${name} again.`);
      let runs;
      try { runs = touchedExecutables(git(["diff", "--name-only", "--no-renames", "-z", head, tree], { cwd, raw: true }).split("\0").filter(Boolean), executablePaths(cwd, gitEnv())); } catch (error) { die(error.message); }
      if (runs.length) die(`the baseline's ${p.branch} changes files that this checkout's Git configuration runs: ${describeTouched(runs)}. Pulling it would run them, during the checkout or at your next Git command. ${unchanged} Review those files in ${target}, the baseline's ${p.branch} as fetched, and bring it in by hand (git merge ${target}) once you trust them.`);
      // A path the pull adds that this checkout already holds as a file Git
      // does not track, an ignored one such as private notes (PROJECT.md,
      // t645), would be written over: Git's checkout replaces ignored files
      // without a word (Astra's fourth review of t644). The clean check above
      // sees only untracked files that are not ignored. A path counts when
      // it, or a part of it that must be a folder, is on disk and no tracked
      // path is there, compared as a Mac's disk finds them.
      const tracked = new Set(git(["ls-files", "-z"], { cwd, raw: true }).split("\0").filter(Boolean).flatMap((path) => path.split("/").map((_, i, parts) => foldPath(parts.slice(0, i + 1).join("/")))));
      const added = git(["diff", "--name-only", "--no-renames", "-z", "--diff-filter=A", head, tree], { cwd, raw: true }).split("\0").filter(Boolean);
      const held = added.filter((path) => {
        const parts = path.split("/");
        for (let i = 1; i <= parts.length; i++) {
          const part = parts.slice(0, i).join("/");
          if (tracked.has(foldPath(part))) continue;
          const stat = lstatSync(join(cwd, part), { throwIfNoEntry: false });
          if (!stat) return false;
          if (i === parts.length || !stat.isDirectory()) return true;
        }
        return false;
      });
      if (held.length) die(`the baseline's ${p.branch} adds ${held.join(", ")}, which this checkout holds as ${held.length === 1 ? "a file" : "files"} Git does not track (ignored, as private notes are). Pulling would write over ${held.length === 1 ? "it" : "them"}. ${unchanged} Move ${held.length === 1 ? "it" : "them"} aside or rename ${held.length === 1 ? "it" : "them"}, then run atelier pull --project ${name} again.`);
    };
    if (local === 0) {
      checkTree(target);
      // --no-overwrite-ignore: should an ignored file appear after the
      // check, Git stops rather than write over it.
      git(["merge", "--ff-only", "--no-overwrite-ignore", "--quiet", target], { cwd });
      pair();
      console.log(`${name}: brought ${plural(brought, "commit")} from the baseline's ${p.branch}; ${p.branch} moved from ${short(head)} to ${short(target)}.`);
      console.log(subjects);
      return console.log(receiptsLine);
    }
    const merged = git(["merge-tree", "--write-tree", "--name-only", "--no-messages", head, target], { cwd, allowFail: true });
    if (merged.status === 1) {
      const paths = [...new Set(merged.stdout.split("\n").slice(1).filter(Boolean))];
      console.log(receiptsLine);
      const byHand = fresh
        ? `git checkout -B ${p.branch} ${target}, then git merge ${head}, resolve the conflicts and commit (the baseline's side comes first, as atelier sync needs)`
        : `git merge ${target}, resolve the conflicts and commit`;
      die(`${p.branch} and the baseline's ${p.branch} both change ${paths.join(", ")}, and the changes conflict. Nothing was merged: ${p.branch} is still at ${short(head)} with its ${plural(local, "local commit")}, and the work tree is as it was. The baseline's ${p.branch} brings ${plural(brought, "commit")}, fetched as ${target}. Merge it by hand: ${byHand}; then run atelier pull --project ${name} again.`);
    }
    if (merged.status !== 0) die(`git merge-tree could not merge the baseline's ${p.branch} (${short(target)}) into ${p.branch}; nothing was merged:\n${(merged.stderr || merged.stdout).trim()}`);
    const tree = merged.stdout.split("\n")[0];
    checkTree(tree);
    const parents = fresh ? [target, head] : [head, target];
    const commit = git(["commit-tree", tree, "-p", parents[0], "-p", parents[1], "-m", `Merge the baseline's ${p.branch} into ${p.branch} (atelier pull)`], { cwd });
    git(["merge", "--ff-only", "--no-overwrite-ignore", "--quiet", commit], { cwd });
    pair();
    console.log(`${name}: brought ${plural(brought, "commit")} from the baseline's ${p.branch} and merged them with ${plural(local, "local commit")}; ${p.branch} is at ${short(commit)}.`);
    console.log(subjects);
    console.log(receiptsLine);
    console.log(fresh ? `atelier sync --project ${name} carries the local commits to the baseline.` : `The local commits reach the baseline with atelier publish --project ${name} or the next atelier merge.`);
  } finally { unlock(); }
}

// The baseline's receipts merged into this checkout's: copied when this
// checkout has none, fast-forwarded or merged otherwise. Returns how many
// commits carry a note now that carried none before.
function mergeNotes(git, cwd, tip) {
  const annotated = () => new Set(git(["notes", "--ref=atelier", "list"], { cwd }).split("\n").filter(Boolean).map((line) => line.split(" ")[1]));
  const had = git(["rev-parse", "--verify", "-q", "refs/notes/atelier"], { cwd, allowFail: true }).stdout.trim();
  const before = had ? annotated() : new Set();
  if (!had) git(["update-ref", "refs/notes/atelier", tip, ""], { cwd });
  else git(["notes", "--ref=atelier", "merge", "--quiet", "--strategy=union", tip], { cwd });
  return [...annotated()].filter((object) => !before.has(object)).length;
}
