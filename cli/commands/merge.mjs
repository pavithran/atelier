// atelier merge. Its forms, flags and help are declared in src/usage/commands/merge.ts.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { acceptancePolicy, mergeContext, mergePolicyDecision } from "../../src/control-plane.ts";
import { pathCollisions } from "../../src/rules.ts";
import { adoptOldLanding, executablePaths, landingJournal, landingLeft, landingLock, landingSymlinks, touchedExecutables, treeEntries } from "../landing.mjs";
import { carryTask, loadPairs, rebuild, savePairs } from "../fresh.mjs";
import { provenanceNote } from "../provenance.mjs";
import { COMMAND_USAGE } from "../help.mjs";
import { I, OWNER, P, actor, args, at, call, cfg, die, git, gitEnv, itemArg, landingGit, landingHome, overrideArg, project, refreshControlPlane, request, server, short, writeReceipt } from "../atelier.mjs";

// The project owner merges an exact revision. With --head, a submitted item
// is first approved (with --approve) and accepted at that revision only.
export default async function mergeCommand() {
  const git = landingGit;
  // A plan's branch is updated only by its integrator, which merges
  // recorded parts, so an accepted plan that conflicts with main would stay
  // accepted with no one able to update it. Its merge, already aborted,
  // puts it back to building through plan refresh instead: the acceptance
  // is withdrawn and main's head is merged into the branch, or, when that
  // conflicts, a merge-main part is added for a model to resolve.
  const planConflicted = async (name, id, item) => {
    let view;
    try { view = await request("POST", `${I(name, id)}/plan/refresh`, {}, OWNER); }
    catch (error) { die(`merge conflicts: ${id}'s branch does not merge with main, so nothing was merged, and ${id} stays accepted at ${short(item.acceptedHead)}: putting it back to building was refused: ${error.message}. Once that is cleared, take main into the branch with atelier plan refresh ${id}`); }
    const main = view.refresh?.last?.mainHead ?? view.refresh?.main ?? "";
    die(`merge conflicts: ${id}'s branch does not merge with main, so nothing was merged. Its acceptance at ${short(item.acceptedHead)} is withdrawn and the plan is building again: a refresh from main at ${short(main)} is queued for atelier/integrator, and if it conflicts the plan adds a merge-main part whose builder resolves it. The integrator submits the plan again once every part is integrated; then merge it with atelier merge ${id} --head H, H being the integration head atelier plan show ${id} prints`);
  };
  // An override is recorded only while accepting, which needs the revision.
  if (args["override-review"] !== undefined && args.head === undefined) die("--override-review is recorded while accepting a submitted revision: atelier merge ID --head FULL_REVISION --override-review REASON");
  const name = project(), id = itemArg();
  const p = cfg.projects?.[name] ?? die(`${name} is not registered on this Mac`), cwd = p.path;
  // Ends a landing. It holds the landing lock throughout, as merge does, so
  // it never runs beside a merge of this checkout that may be publishing.
  // The journal is matched by project and item alone, so a landing whose
  // acceptance was withdrawn or moved after it began, and which can no
  // longer be finished, can still be cancelled. What the landing left in
  // the checkout, a merge commit or an unfinished Git merge (landingLeft),
  // is kept unless the owner asks for it to go with --discard-local; then
  // the checkout returns to where the merge began. The landing lease is
  // cancelled on the server while the item is accepted at the revision the
  // journal names, or when there is no journal: a lease is taken for the
  // accepted revision alone, and no push or review moves the acceptance
  // while one is held, so with another acceptance this landing has none,
  // and a lease on the new revision is not this landing's to end.
  if (args.cancel === true) {
    const gitDir = git(["rev-parse", "--absolute-git-dir"], { cwd }), landing = landingHome(gitDir);
    let unlock;
    try { unlock = landingLock(landing); } catch (error) { die(error.message); }
    try {
      let journal;
      try { adoptOldLanding(gitDir, landing); journal = landingJournal(landing, { project: name, item: id }); } catch (error) { die(error.message); }
      const item = (await call("GET", I(name, id), undefined, OWNER)).item;
      const begun = journal.state, head = begun ? begun.head : item.acceptedHead;
      const ours = !begun || (item.state === "accepted" && item.acceptedHead === begun.head);
      const now = item.state === "accepted" ? `accepted at ${short(item.acceptedHead)}` : item.state;
      const left = begun ? landingLeft(git, cwd, gitDir, begun, p.branch, `Atelier: ${name}/${id} accepted at ${begun.head}`) : {};
      const local = left.commit;
      // Whether the baseline holds a commit, asked of its whole history,
      // fetched here and read by Git.
      let baselineHead = null;
      if (local || (ours && head)) {
        const base = await call("POST", `${P(name)}/baseline-token`, { scope: "read" }, OWNER);
        git(["fetch", "--quiet", base.remote, p.branch], { cwd, token: base.token });
        baselineHead = git(["rev-parse", "FETCH_HEAD"], { cwd });
      }
      const onBaseline = (commit) => !!commit && !!baselineHead && git(["merge-base", "--is-ancestor", commit, baselineHead], { cwd, allowFail: true }).status === 0;
      // A merge already on the baseline is never cancelled, and the checkout
      // keeps it. The journal says so once the push has returned; for a
      // push that reached the baseline just before the process stopped, the
      // baseline's history says so. In a project whose baseline holds part
      // of its history, the baseline has the merge's rebuilt twin, paired
      // with it before the push. A merge the server has recorded, or can no
      // longer record since the item is not accepted at its revision, leaves
      // only the journal to remove; one it can record, merge records.
      if (local) {
        const pairs = p.fresh === true ? loadPairs(gitDir, name) : null;
        const sent = pairs ? Object.keys(pairs).find((commit) => pairs[commit] === local) : local;
        if (begun.phase === "published" || onBaseline(sent)) {
          const lost = left.held ? "" : `\n${p.branch} no longer holds the merge commit ${short(local)}; put it back on that commit before the next merge.`;
          if (ours) die(`${id}'s merge ${short(sent ?? local)} is already on the baseline, so the landing cannot be cancelled, and the checkout keeps it.\nRecord the merge with: atelier merge ${id}${lost}`);
          journal.clear();
          if (item.state === "merged") return console.log(`${id} is already merged as ${short(sent ?? local)}. The landing journal is removed; the checkout keeps the merge.${lost}`);
          return console.log(`${id}'s merge ${short(sent ?? local)} is on the baseline, but ${id} is ${now}, so Atelier cannot record it. The landing journal is removed; the checkout keeps the merge, as the baseline does.${lost}`);
        }
      }
      // The accepted revision on the baseline through another merge commit,
      // made elsewhere: its lease is that merge's, left for it to be
      // recorded. Without a journal there is nothing else to cancel.
      const landed = ours && onBaseline(head);
      if (landed && !begun) die(item.state === "merged" ? `${id} is already merged; there is no landing to cancel` : `${id} at ${short(head)} is already merged on the baseline, so its landing lease cannot be cancelled. Record that merge by running atelier merge ${id} in the checkout that made it`);
      if (left.held || left.merging) {
        const what = left.held ? `this merge's unpublished commit ${short(local)} on top of ${short(begun.start)}` : `this merge's unfinished Git merge of ${short(begun.head)} on ${short(begun.start)}`;
        if (args["discard-local"] !== true) {
          if (!ours) die(`${id} is ${now}, no longer accepted at ${short(begun.head)}, the revision this landing merged, so the landing cannot be finished. The checkout holds ${what}.\nRemove it with: atelier merge ${id} --cancel --discard-local`);
          if (landed) die(`${id} at ${short(head)} is already on the baseline through another merge commit, so this landing cannot be finished. The checkout holds ${what}.\nRemove it with: atelier merge ${id} --cancel --discard-local`);
          die(`the checkout holds ${what}.\n${left.held ? `Finish it with: atelier merge ${id}` : `Abort it with git merge --abort, then finish the landing with: atelier merge ${id}`}\nor cancel and remove it with: atelier merge ${id} --cancel --discard-local`);
        }
        if (git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd }) !== p.branch) die(`check out ${p.branch} in ${cwd} first`);
        const at = git(["rev-parse", "HEAD"], { cwd });
        if (left.held && at !== local) die(`${p.branch} moved since the merge: it is at ${short(at)}, past the merge commit ${short(local)}. Nothing was changed. Move your commits off it and put ${p.branch} back on ${short(local)}, or on ${short(begun.start)} where the merge began, then run: atelier merge ${id} --cancel --discard-local`);
        if (left.held && git(["status", "--porcelain"], { cwd })) die(`the checkout has uncommitted changes on top of the merge commit ${short(local)}. Nothing was changed. Set them aside (git stash), then run: atelier merge ${id} --cancel --discard-local`);
      }
      if (ours && !landed) await call("POST", `${I(name, id)}/landing`, { cancel: true }, OWNER);
      if (left.held) {
        git(["reset", "--quiet", "--hard", begun.start], { cwd });
        console.log(`Removed the unpublished merge commit; ${p.branch} is back at ${short(begun.start)}.`);
      } else if (left.merging) {
        git(["merge", "--abort"], { cwd });
        const rest = git(["status", "--porcelain", "--untracked-files=all"], { cwd });
        console.log(`Aborted the unfinished Git merge; ${p.branch} is at ${short(begun.start)}, where the merge began.${rest ? `\nGit still lists these files as changed or untracked; remove any the merge left:\n${rest}` : ""}`);
      }
      journal.clear();
      if (landed) return console.log(`${id}: the landing in this checkout is cancelled. ${id} at ${short(head)} is already on the baseline through another merge commit, so its landing lease is left for that merge to be recorded.`);
      if (ours) return console.log(`${id}: the merge is cancelled; its owner can push a new revision.`);
      return console.log(`${id}: the landing in this checkout is cancelled. ${id} is ${now}, and nothing changed on the server${item.state === "accepted" ? `; merge its accepted revision with: atelier merge ${id}` : ""}.`);
    } finally { unlock(); }
  }
  const refreshed = await refreshControlPlane(cwd, name);
  // The merge compares the policy as it is now with the one the acceptance
  // was made under, so a policy it cannot read stops it here.
  if (refreshed?.skipped) die(`ControlPlane policy could not be read: ${refreshed.error}. Fix the file, then run atelier merge ${id} again.`);
  if (args.head !== undefined) {
    if (!/^[a-f0-9]{40,64}$/.test(args.head)) die(COMMAND_USAGE.merge);
    const reason=overrideArg("merge ID --head FULL_REVISION");
    const d=await call("GET",I(name,id),undefined,OWNER);
    if (d.item.state==="submitted") {
      if (d.item.head!==args.head) die("the task changed; review the new revision before merging");
      // The owner approves here the criteria this command read with the head.
      if (args.approve) await call("POST",`${I(name,id)}/review`,{head:args.head,criteria:d.criteria,approve:true,note:args.note??""},OWNER);
      await call("POST",`${I(name,id)}/accept`,{head:args.head,...(reason!==undefined?{overrideReview:reason}:{})},OWNER);
    }
  }
  const gitDir=git(["rev-parse","--absolute-git-dir"],{cwd}), landing=landingHome(gitDir);
  let unlock;
  try { unlock=landingLock(landing); } catch (error) { die(error.message); }
  try {
    try { adoptOldLanding(gitDir,landing); } catch (error) { die(error.message); }
    const d=await call("GET",I(name,id),undefined,OWNER), item=d.item;
    // A landing begun at an acceptance that has since been withdrawn or
    // moved cannot be finished: what it merged is no longer what is accepted.
    let begun;
    try { begun=landingJournal(landing,{project:name,item:id}).state; } catch (error) { die(error.message); }
    if (begun && (begun.head!==item.acceptedHead || !['accepted','merged'].includes(item.state))) {
      const left=landingLeft(git,cwd,gitDir,begun,p.branch,`Atelier: ${name}/${id} accepted at ${begun.head}`);
      die(`${id} is ${item.state==='accepted'?`accepted at ${short(item.acceptedHead)}`:item.state}, no longer accepted at ${short(begun.head)}, where this checkout began landing it, so that landing cannot be finished. Cancel it with: atelier merge ${id} --cancel${left.held||left.merging?' --discard-local':''}${item.state==='accepted'?', then merge again':''}`);
    }
    if (!['accepted','merged'].includes(item.state)) die(`${id} is ${item.state}; accept the reviewed revision first`);
    if (args.head && args.head!==item.acceptedHead) die("the accepted revision differs from --head; review it before merging");
    const journal=landingJournal(landing,{project:name,item:id,head:item.acceptedHead});
    if (item.state==='merged') { journal.clear(); console.log(`${id} is already merged.`); return; }
    const acceptedPolicy = acceptancePolicy(d, refreshed?.before ?? d.policy), context = mergeContext(d, refreshed?.items);
    if (refreshed?.policy) {
      const decision = mergePolicyDecision(acceptedPolicy, refreshed.policy, [], false, context);
      if (decision.warning) console.error(decision.warning);
    }
    if (git(["status","--porcelain"],{cwd})) die("the registered checkout has uncommitted changes; preserve them before retrying");
    if (git(["rev-parse","--abbrev-ref","HEAD"],{cwd})!==p.branch) die(`check out ${p.branch} in ${cwd} first`);
    const base=await call("POST",`${P(name)}/baseline-token`,{scope:'write'},OWNER);
    git(['fetch','--quiet',base.remote,p.branch],{cwd,token:base.token});
    const baselineHead=git(['rev-parse','FETCH_HEAD'],{cwd});
    const ws=await call('POST',`${I(name,id)}/read-token`,{},OWNER);
    git(['fetch','--quiet',ws.remote,item.acceptedHead],{cwd,token:ws.token});
    if (git(['rev-parse','FETCH_HEAD'],{cwd})!==item.acceptedHead) die('fetched revision differs from the approval');
    if (refreshed?.policy) {
      if (!item.base) die('the accepted revision has no recorded base; review the task again on its page and accept again');
      // The accepted revision's own changes: those since the newest baseline
      // commit it holds, which atelier update moves past the recorded base.
      const forkPoint = git(['merge-base', baselineHead, item.acceptedHead], { cwd, allowFail: true });
      const since = forkPoint.status === 0 && forkPoint.stdout.trim() ? forkPoint.stdout.trim() : item.base;
      const paths = git(['diff', '--name-only', '--no-renames', '-z', since, item.acceptedHead], { cwd, raw: true }).split('\0').filter(Boolean);
      const decision = mergePolicyDecision(acceptedPolicy, refreshed.policy, paths, args['policy-changed-ok'] === true, context);
      if (decision.refusal) die(`${decision.refusal}\n${server()}/p/${encodeURIComponent(name)}/${encodeURIComponent(id)}`);
    }
    const local=git(['rev-parse','HEAD'],{cwd});
    const owners=[...new Set(d.events.filter(e=>['item.claimed','item.handoff'].includes(e.kind)).map(e=>e.data.to??e.actor))];
    const view=d.evidence.filter(e=>e.head===item.acceptedHead), reviews=d.reviews.filter(r=>r.head===item.acceptedHead);
    const marker=`Atelier: ${name}/${id} accepted at ${item.acceptedHead}`;
    // A project whose baseline holds part of its history (cli/fresh.mjs)
    // merges the task's commits rebuilt onto the paired project commit.
    const fresh=p.fresh===true, pairs=fresh?loadPairs(gitDir,name):null;
    if (!journal.state) {
      if (fresh) {
        const paired=pairs[baselineHead];
        if (!paired) die(`the baseline's head ${short(baselineHead)} has no pair in this checkout; it was set up or synced from another machine`);
        if (local!==paired) die(`${p.branch} has moved since the baseline last matched it (${short(paired)}); run atelier sync --project ${name}, then merge`);
      }
      else if (git(['merge-base','--is-ancestor',baselineHead,'HEAD'],{cwd,allowFail:true}).status!==0) die('the baseline has commits missing locally; reconcile the checkout before merging');
      journal.save({start:local,phase:'prepared',baselineStart:baselineHead});
    }
    if (!journal.state.mergeCommit) {
      // What is merged: the accepted head, or its rebuilt twin on the project's commits.
      let target=item.acceptedHead;
      if (fresh) {
        try { target=carryTask(git,cwd,journal.state.baselineStart??baselineHead,item.acceptedHead,pairs); } catch (error) { journal.clear(); die(error.message); }
        if (!target) { journal.clear(); die('the accepted revision adds nothing to the baseline'); }
      }
      // Recover a commit made just before a crash prevented the journal update.
      const parents=git(['rev-list','--parents','-n','1','HEAD'],{cwd}).split(' ');
      const ownCommit=parents.length===3 && parents[1]===journal.state.start && parents[2]===target && git(['log','-1','--format=%B'],{cwd}).split('\n').includes(marker);
      if (ownCommit) journal.save({mergeCommit:local,phase:'committed'});
      else {
        if(local!==journal.state.start) die('checkout moved during an interrupted merge; inspect the journal before retrying');
        // Paths that differ only by letter case or Unicode form are one file
        // on a Mac, so Git would write one over the other here and in every
        // clone on a Mac. The baseline is shared, so this is refused on every
        // platform, before the checkout changes. The tree checked is the
        // merge's own, from merge-tree, which touches neither the index nor
        // the work tree; it is the accepted tree where merge-tree cannot
        // write one, as with a Git older than 2.38.
        const merged=git(['merge-tree','--write-tree','--no-messages',local,target],{cwd,allowFail:true});
        const mergedTree=merged.status<=1?merged.stdout.split('\n')[0]:'';
        const tree=/^[0-9a-f]{40,64}$/.test(mergedTree)?mergedTree:target;
        const entries=treeEntries(git(['ls-tree','-r','-z','--full-tree',tree],{cwd,raw:true}));
        const clashes=pathCollisions(entries.map(e=>e.path));
        if(clashes.length){journal.clear();die(`the merge would hold paths that a Mac stores as one file, since they differ only by letter case or Unicode form: ${clashes.map(g=>g.join(' and ')).join('; ')}. Git would write one over the other in this checkout and in every clone on a Mac. Nothing was merged; the task's owner must rename or remove all but one of each and submit a new revision`);}
        // The landing reads the ControlPlane policy and receipt template
        // and writes the receipt; a symlink on one of those paths would
        // take the read or the write outside the checkout.
        const links=landingSymlinks(entries);
        if(links.length){journal.clear();die(`the merge would put a symlink where the landing reads or writes its ControlPlane files: ${links.join(', ')}. The landing would follow it out of the checkout. Nothing was merged; the task's owner must replace each with the file or folder itself and submit a new revision`);}
        // A file that this checkout's Git configuration runs (a hook, a
        // filter or merge driver script, an included configuration file)
        // and that the merge would change would run during the merge, or
        // stay to run at the owner's next Git command. The changed paths
        // are those between this checkout and the merge's own tree.
        let runs;
        try{runs=touchedExecutables(git(['diff','--name-only','--no-renames','-z',local,tree],{cwd,raw:true}).split('\0').filter(Boolean),executablePaths(cwd,gitEnv()));}
        catch(error){journal.clear();die(error.message);}
        if(runs.length){journal.clear();die(`the accepted change touches files that this checkout's Git configuration runs: ${runs.map(r=>r.changed.length===1&&r.changed[0]===r.path?`${r.path}, ${r.setting}`:`${r.changed.join(', ')}, which reach ${r.path}, ${r.setting}`).join('; ')}. Landing it would run them, during the merge or at your next Git command. Nothing was merged; review those files in the accepted change and land it by hand, or have the task's owner submit a revision that leaves them alone`);}
        const result=git(['merge','--no-ff','--no-commit',target],{cwd,allowFail:true});
        if(result.status!==0){git(['merge','--abort'],{cwd,allowFail:true});journal.clear();if(item.kind==='plan')await planConflicted(name,id,item);die(`merge conflicts; nothing was merged and ${id} stays accepted. The project owner can send it back to a runner with atelier dispatch ${id} --job merge-main, or hand it to a builder with atelier handoff ${id} --to H/M. The builder resolves the conflicts, rechecks and submits a new revision for review and acceptance; earlier reviews and acceptance stay in the history`);}
        if (!existsSync(join(gitDir,'MERGE_HEAD'))) { journal.clear(); die('this revision is already in the checkout without this merge record; reconcile its history first'); }
        const receipt=writeReceipt(cwd,{name,id,item,owners,view,reviews,policy:d.policy,branch:p.branch,notesRemote:p.notesRemote,changeClass:d.gate.changeClass});
        if(receipt)git(['add',receipt],{cwd});
        git(['commit','--quiet','-m',`Merge ${id}: ${item.title}\n\n${marker}\nWorked by: ${owners.join(' → ')||item.owner}`],{cwd});
        journal.save({mergeCommit:git(['rev-parse','HEAD'],{cwd}),phase:'committed'});
      }
    }
    const mergeCommit=journal.state.mergeCommit;
    const at=git(['rev-parse','HEAD'],{cwd});
    if(at!==mergeCommit)die(`the checkout moved after the merge: ${p.branch} is at ${short(at)}, not at the merge commit ${short(mergeCommit)}. Put ${p.branch} back on ${short(mergeCommit)}, moving any commits of yours off it, then run atelier merge ${id} again, or cancel the landing with: atelier merge ${id} --cancel`);
    // Take the landing lease: it confirms the acceptance has not moved and
    // stops a push over this revision until the merge is recorded.
    // A refusal ends the command here with the server's reason; the local
    // merge commit is kept for reconciliation.
    await call('POST',`${I(name,id)}/landing`,{head:item.acceptedHead},OWNER);
    // The note goes to the public remote too, so it names reviewers and verdicts but never their text (cli/provenance.mjs).
    const note=provenanceNote({name,id,item,view,reviews,events:d.events});
    // Reconcile provenance independently: a previous push can publish only one ref.
    const remoteNotes=git(['ls-remote',base.remote,'refs/notes/atelier'],{cwd,token:base.token});
    if(remoteNotes){
      git(['fetch','--quiet',base.remote,'refs/notes/atelier'],{cwd,token:base.token});
      if(git(['rev-parse','--verify','refs/notes/atelier'],{cwd,allowFail:true}).status===0)
        git(['notes','--ref=atelier','merge','FETCH_HEAD'],{cwd});
      else git(['update-ref','refs/notes/atelier','FETCH_HEAD'],{cwd});
    }
    // The baseline gets the merge commit itself, or, for a baseline holding
    // part of the history, its twin: the same tree, authors, dates and
    // message on the baseline's head and the accepted head. The same inputs
    // give the same twin, so a retry publishes the same commit.
    const published=fresh?rebuild(git,cwd,mergeCommit,[journal.state.baselineStart??baselineHead,item.acceptedHead]):mergeCommit;
    if(fresh)savePairs(gitDir,name,{...loadPairs(gitDir,name),[published]:mergeCommit});
    for(const c of new Set([mergeCommit,published])){
      const priorNote=git(['notes','--ref=atelier','show',c],{cwd,allowFail:true});
      if(priorNote.status!==0||priorNote.stdout.trim()!==note.trim())git(['notes','--ref=atelier','add','-f','-m',note,c],{cwd});
    }
    const alreadyPublished=git(['merge-base','--is-ancestor',published,baselineHead],{cwd,allowFail:true}).status===0;
    git(['push','--quiet',base.remote,...(alreadyPublished?[]:[`${published}:refs/heads/${p.branch}`]),'refs/notes/atelier:refs/notes/atelier'],{cwd,token:base.token});
    journal.save({phase:'published'});
    await call('POST',`${I(name,id)}/merged`,{mergeCommit:published},OWNER);
    journal.clear();
    const notesPush=p.notesRemote?git(['push','--quiet',p.notesRemote,'refs/notes/atelier:refs/notes/atelier'],{cwd,allowFail:true}):null;
    console.log(`${id} merged as ${short(mergeCommit)} in ${cwd}${published!==mergeCommit?` (on the baseline as ${short(published)})`:""}; baseline and ledger agree.`);
    console.log(`Provenance: git notes --ref=atelier show ${short(mergeCommit)}`);
    if(notesPush?.status===0)console.log(`Provenance notes pushed to ${p.notesRemote}.`);
    else if(notesPush)console.log(`Provenance notes need retry: git push ${p.notesRemote} refs/notes/atelier:refs/notes/atelier`);
    console.log("The project branch was not pushed to its own remotes. Nothing was deployed.");
  } finally { unlock(); }
}
