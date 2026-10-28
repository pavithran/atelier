import { executePostMerge } from "../post-merge.mjs";
// atelier merge. Its forms, flags and help are declared in src/usage/commands/merge.ts.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathCollisions } from "../../src/rules.ts";
import { acceptancePolicy, evidenceAt, mergeContext, mergePolicyDecision } from "../../src/rules.ts";
import { adoptOldLanding, describeTouched, executablePaths, landingJournal, landingLeft, landingLock, pushMergeToProjectBranch, tailOf, touchedExecutables, treeEntries } from "../landing.mjs";
import { runRegenerateIn } from "../land.mjs";
import { releaseSequence } from "../load.mjs";
import { prepareChecks } from "../../src/check-preparation.ts";
import { refusalOf, refusalText } from "../../src/checks.ts";
import { stopLine } from "../../src/check-limit.ts";
import { REAL_HISTORY_ENV, carryTask, loadPairs, rebuild, savePairs } from "../fresh.mjs";
import { provenanceNote } from "../provenance.mjs";
import { guardedPush, privateGuardFor, privateRefusal } from "../private-guard.mjs";
import { describeConflicts, indexBeyond, mergeThrough, previewMerge, readManifest, verifyAccepted } from "../merge-pipeline.mjs";
import { COMMAND_USAGE } from "../help.mjs";
import { collectCache } from "../gc.mjs";
import { IDENTITY_LOG_FORMAT, isPublicMirror, NO_IDENTITY, parseIdentityLog, publicRefusals } from "../../src/commit-identity.ts";
import { CACHE, I, OWNER, P, actingHeaders, actor, apiToken, args, at, call, cfg, cleanClone, die, directionArg, git, gitEnv, identityEnv, identityRangeRefusals, itemArg, landingGit, landingHome, needCheckout, overrideArg, project, redact, removeClone, request, runCheck, saveConfig, server, short } from "../atelier.mjs";
import { pinCheckoutIdentity } from "../identity.mjs";

// The project owner merges an exact revision. With --head, a submitted item
// is first approved (with --approve) and accepted at that revision only.
// t708: the tree of the merge commit when every required check's latest
// counting run at the accepted head passed: the gate's own reading
// (evidenceAt), so a later failing run of a check is not masked by an earlier
// pass. The accepted head's tree must be that tree. Anything that cannot be
// read or compared gives null, and a null makes the provenance note claim
// nothing, so the deploy gate runs again. (The claim used to go in a
// ControlPlane receipt, written with the merge; the note carries it now, read
// from the merge commit, so a resumed merge states it too.)
function checkedTreeMatch(cwd,evidence,policy,head,mergeCommit){
  try{
    const checks=evidenceAt(policy,evidence,head).checks;
    if(!checks.length||!checks.every(c=>c.grade==='observed'&&c.passed===true))return null;
    const out=(...a)=>{const r=landingGit(a,{cwd,allowFail:true});return r.status===0?r.stdout.trim():'';};
    const tree=out('rev-parse','--verify','--quiet',`${mergeCommit}^{tree}`);
    if(!/^[0-9a-f]{40,64}$/.test(tree)||out('rev-parse','--verify','--quiet',`${head}^{tree}`)!==tree)return null;
    return{tree,claims:checks.map(c=>c.claim)};
  }catch{return null;}
}

export default async function mergeCommand() {
  const git = landingGit;
  // A merged task's workspace on this Mac goes once its work is in main or
  // the head Atelier recorded (t561); one holding more is kept and named.
  // Its removal never fails the merge.
  const cleanWorkspace = async (name, id, branch, cwd) => {
    if (!existsSync(join(CACHE, "work", name, id))) return;
    try {
      // request throws where call would end the command: a ledger that
      // fails after the merge must not fail it or skip what follows.
      const getItem = async () => (await request("GET", I(name, id), undefined, OWNER)).item;
      await collectCache({ cache: CACHE, name, items: [await getItem()], getItem, apply: true, only: id, main: { dir: cwd, branch },
        log: (line) => console.log(line.replace(/^REMOVED /, `Removed ${id}'s workspace `).replace(/^KEEP +(.*?): /, `Kept ${id}'s workspace $1: `)) });
    } catch (error) { console.log(`${id}'s workspace was left in place: ${error.message}`); }
  };
  const postMerge = (name, id) => executePostMerge({ name, id, request: (method, path, body) => request(method, path, body, OWNER) });
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
  if ((args["override-review"] !== undefined || args.quote !== undefined) && args.head === undefined) die("--override-review is recorded while accepting a submitted revision: atelier merge ID --head FULL_REVISION --override-review REASON");
  const name = project(), id = itemArg();
  const p = cfg.projects?.[name] ?? die(`${name} is not registered on this Mac`), cwd = needCheckout(name, p);
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
      if (ours) return console.log(`${id}: the merge is cancelled; its holder can push a new revision.`);
      return console.log(`${id}: the landing in this checkout is cancelled. ${id} is ${now}, and nothing changed on the server${item.state === "accepted" ? `; merge its accepted revision with: atelier merge ${id}` : ""}.`);
    } finally { unlock(); }
  }
  if (args.head !== undefined) {
    if (!/^[a-f0-9]{40,64}$/.test(args.head)) die(COMMAND_USAGE.merge);
    const reason=overrideArg("merge ID --head FULL_REVISION");
    // The developer's words, with the acting model, confirm the override without the page (t629).
    const direction=reason!==undefined?directionArg("merge ID --head FULL_REVISION --override-review REASON"):{};
    const d=await call("GET",I(name,id),undefined,OWNER);
    if (d.item.state==="submitted") {
      if (d.item.head!==args.head) die("the task changed; review the new revision before merging");
      // The owner approves here the criteria this command read with the head.
      if (args.approve) await call("POST",`${I(name,id)}/review`,{head:args.head,criteria:d.criteria,approve:true,note:args.note??""},OWNER);
      await call("POST",`${I(name,id)}/accept`,{head:args.head,...(reason!==undefined?{overrideReview:reason,...direction}:{})},OWNER,reason!==undefined?actingHeaders():{});
    }
  }
  const gitDir=git(["rev-parse","--absolute-git-dir"],{cwd}), landing=landingHome(gitDir);
  // The lander's merge (G2, --landing, run by atelier land under the lease):
  // the merge commit is made here, the project's checks run on its tree, and
  // only then is it pushed to the project's branch; each step is recorded on
  // the task's landing record (G1), a failure with the last lines of its own
  // output. Main moving between the checks and the push is refused (by Git
  // and the hook: the push is not a fast-forward); the merge and the checks
  // are then made again on the new main, at most MAIN_MOVED_REDOS times.
  const lander=args.landing===true;
  let step='merge-main', stepAt=Date.now();
  const begin=(s)=>{step=s;stepAt=Date.now();};
  // The attempt this merge entered (beginLandMerge), sent with each step it
  // records, so the Ledger takes them only for the current attempt.
  let landAttempt;
  const record=async(s,ms,data={})=>{
    if(!lander)return;
    try{await request('POST',`${I(name,id)}/land`,{step:s,ms:Math.max(0,Math.round(ms)),...data,...(Number.isInteger(landAttempt)?{attempt:landAttempt}:{})},OWNER);}
    catch(error){console.error(`Warning: the landing's ${s} step could not be recorded: ${error.message}`);}
  };
  // Every stop of the lander's merge names its step on the record, with the
  // last lines of what that step said, before the command ends.
  const fail=async(message,data={},code=1)=>{
    if(lander)await record(step,Date.now()-stepAt,{failed:true,tail:tailOf(message),...data});
    die(message,code??1);
  };
  let unlock;
  try { unlock=landingLock(landing); } catch (error) { await fail(error.message); }
  try {
    try { adoptOldLanding(gitDir,landing); } catch (error) { await fail(error.message); }
    for (let round=0; ; round++) {
    begin('merge-main');
    // The landing enters its merge on the Ledger before anything merges
    // (G1): from here a cancel of its queued landing is refused, naming the
    // step, and one that came first stops it here.
    if(lander){
      // It names the attempt it belongs to, which the Ledger checks against
      // the task's landing record and its live lease.
      // atelier land names its attempt in ATELIER_LAND_ATTEMPT and it holds
      // for every round; run by hand, the record's current attempt is read once.
      if(round===0){
        const named=Number(process.env.ATELIER_LAND_ATTEMPT);
        landAttempt=Number.isInteger(named)&&named>=1?named:(await request('GET',I(name,id),undefined,OWNER).catch(()=>null))?.landing?.attempt;
      }
      // A refused entry is this call's, not the landing's: it ends here with
      // the refusal and records nothing on the task.
      try{await request('POST',`${I(name,id)}/land-merge`,landAttempt===undefined?{}:{attempt:landAttempt},OWNER);}
      catch(error){die(error.message,error.code??1);}
    }
    const d=await call("GET",I(name,id),undefined,OWNER), item=d.item;
    // A landing begun at an acceptance that has since been withdrawn or
    // moved cannot be finished: what it merged is no longer what is accepted.
    let begun;
    try { begun=landingJournal(landing,{project:name,item:id}).state; } catch (error) { await fail(error.message); }
    if (begun && (begun.head!==item.acceptedHead || !['accepted','merged'].includes(item.state))) {
      const left=landingLeft(git,cwd,gitDir,begun,p.branch,`Atelier: ${name}/${id} accepted at ${begun.head}`);
      await fail(`${id} is ${item.state==='accepted'?`accepted at ${short(item.acceptedHead)}`:item.state}, no longer accepted at ${short(begun.head)}, where this checkout began landing it, so that landing cannot be finished. Cancel it with: atelier merge ${id} --cancel${left.held||left.merging?' --discard-local':''}${item.state==='accepted'?', then merge again':''}`);
    }
    if (!['accepted','merged'].includes(item.state)) await fail(`${id} is ${item.state}; accept the reviewed revision first`);
    if (args.head && args.head!==item.acceptedHead) await fail("the accepted revision differs from --head; review it before merging");
    const journal=landingJournal(landing,{project:name,item:id,head:item.acceptedHead});
    if (item.state==='merged') { journal.clear(); console.log(`${id} is already merged.`); await cleanWorkspace(name, id, p.branch, cwd); if (d.policy.postMerge || d.postMerge) await postMerge(name, id); return; }
    // The merge compares the project's stored policy as the item's detail
    // states it now with the policy the acceptance was made under
    // (mergePolicyDecision in src/rules.ts). Nothing is read from the checkout
    // or written to the project. The live items are read only when overlapping
    // claims became refused since the acceptance, the one change that needs them.
    const nowPolicy = d.policy, acceptedPolicy = acceptancePolicy(d, nowPolicy);
    const items = nowPolicy.refuseOverlap && !acceptedPolicy.refuseOverlap ? (await call("GET", P(name), undefined, OWNER)).items ?? [] : [];
    const context = mergeContext(d, items);
    const warning = mergePolicyDecision(acceptedPolicy, nowPolicy, [], false, context).warning;
    if (warning) console.error(warning);
    if (git(["status","--porcelain"],{cwd})) await fail("the registered checkout has uncommitted changes; preserve them before retrying");
    if (git(["rev-parse","--abbrev-ref","HEAD"],{cwd})!==p.branch) await fail(`check out ${p.branch} in ${cwd} first`);
    const base=await call("POST",`${P(name)}/baseline-token`,{scope:'write'},OWNER);
    // The Node server mints no token for the developer's write of the
    // project's branch: the developer's own server token is the credential
    // (docs/branches.md), which task 6 replaces with a landing grant.
    if(!base.token)base.token=apiToken();
    git(['fetch','--quiet',base.remote,p.branch],{cwd,token:base.token});
    const baselineHead=git(['rev-parse','FETCH_HEAD'],{cwd});
    const ws=await call('POST',`${I(name,id)}/read-token`,{},OWNER);
    git(['fetch','--quiet',ws.remote,item.acceptedHead],{cwd,token:ws.token});
    const fetched=git(['rev-parse','FETCH_HEAD'],{cwd});
    if (fetched!==item.acceptedHead) await fail(`fetched revision differs from the approval: fetched ${fetched}, approved ${item.acceptedHead}`);
    // The commits the task adds to the baseline carry the project's
    // address or an agent address its policy allows (t451); what the
    // baseline already holds is not read.
    const identity=d.policy?.commitIdentity ?? await fail(`${NO_IDENTITY(name)}. Nothing was merged.`);
    try { pinCheckoutIdentity(cwd,identity); } catch (error) { await fail(`${error.message}. Nothing was merged.`); }
    const taskRefusals=identityRangeRefusals(git,cwd,identity,baselineHead,item.acceptedHead);
    if (taskRefusals.length) await fail(`${id}'s accepted revision holds commits whose identity the project's policy refuses:\n  ${taskRefusals.join('\n  ')}\nNothing was merged. The task's holder rewrites those commits under an allowed identity and submits a new revision, or the developer allows the address with atelier init --agent-email EMAIL.`);
    // The project's private files (t645) reach the baseline through no task.
    const guard=privateGuardFor(name);
    if (guard.refusal) await fail(`${id} was not merged: ${guard.refusal}`);
    const taskPrivate=privateRefusal(cwd,guard.paths,item.acceptedHead,[baselineHead],`${id}'s accepted revision`);
    if (taskPrivate) await fail(`${taskPrivate} Nothing was merged.`);
    // The accepted revision's own changes: those since the newest baseline
    // commit it holds, which atelier update moves past the recorded base. With
    // neither, every path that differs from the baseline: more than the
    // revision's own, so the comparison errs toward refusing.
    const forkPoint = git(['merge-base', baselineHead, item.acceptedHead], { cwd, allowFail: true });
    const since = forkPoint.status === 0 && forkPoint.stdout.trim() ? forkPoint.stdout.trim() : item.base ?? baselineHead;
    const paths = git(['diff', '--name-only', '--no-renames', '-z', since, item.acceptedHead], { cwd, raw: true }).split('\0').filter(Boolean);
    const decision = mergePolicyDecision(acceptedPolicy, nowPolicy, paths, args['policy-changed-ok'] === true, context);
    if (decision.refusal) await fail(`${decision.refusal}\n${server()}/p/${encodeURIComponent(name)}/${encodeURIComponent(id)}`);
    const fresh=p.fresh===true, pairs=fresh?loadPairs(gitDir,name):null;
    // The lander brings a checkout that only lags the baseline up to it
    // before merging (G2): a clean checkout whose branch the baseline holds,
    // with no landing of its own begun, is fast-forwarded, as atelier pull
    // would. A partial-history project keeps its pairing step (sync).
    // A journal left unpublished, by a landing or by a plain atelier merge,
    // is adopted by the lander only when its merge began at the project's
    // tip as the journal recorded it: one begun on a checkout ahead of it
    // would publish commits no landing reviewed.
    if (lander && !fresh && journal.state && journal.state.phase!=='published' && (!journal.state.baselineStart || journal.state.start!==journal.state.baselineStart)) {
      await fail(`the unfinished merge of ${id} in ${cwd} began at ${short(journal.state.start)}, not at the project's ${p.branch} (${journal.state.baselineStart?short(journal.state.baselineStart):'not recorded'}) as it stood then, so it may carry commits no landing reviewed; nothing was merged or pushed.\nnext: only the developer can: atelier merge ${id} --cancel --discard-local, then atelier land ${id} again`);
    }
    if (lander && !fresh && !journal.state && git(['rev-parse','HEAD'],{cwd})!==baselineHead
      && git(['merge-base','--is-ancestor','HEAD',baselineHead],{cwd,allowFail:true,env:REAL_HISTORY_ENV}).status===0) {
      git(['merge','--quiet','--ff-only',baselineHead],{cwd});
      console.log(`${p.branch} in ${cwd} was behind the baseline; fast-forwarded it to ${short(baselineHead)} before merging ${id}.`);
    }
    const local=git(['rev-parse','HEAD'],{cwd});
    const owners=[...new Set(d.events.filter(e=>['item.claimed','item.handoff'].includes(e.kind)).map(e=>e.data.to??e.actor))];
    const view=d.evidence.filter(e=>e.head===item.acceptedHead), reviews=d.reviews.filter(r=>r.head===item.acceptedHead);
    const marker=`Atelier: ${name}/${id} accepted at ${item.acceptedHead}`;
    // A project whose baseline holds part of its history (cli/fresh.mjs)
    // merges the task's commits rebuilt onto the paired project commit.
    // Another checkout has carried commits to the baseline (t644): pull
    // brings them in before this checkout lands anything on top.
    const behind=()=>`${p.branch} does not hold the baseline's ${p.branch} (${short(baselineHead)}): another checkout has carried commits to the baseline since this one last matched it. Nothing was merged. Run atelier pull --project ${name} to bring them into this checkout, then atelier merge ${id} again.`;
    if (!journal.state) {
      if (fresh) {
        const paired=pairs[baselineHead];
        if (!paired) await fail(behind());
        if (local!==paired) await fail(`${p.branch} has moved since the baseline last matched it (${short(paired)}); run atelier sync --project ${name}, then merge`);
      }
      else if (git(['merge-base','--is-ancestor',baselineHead,'HEAD'],{cwd,allowFail:true,env:REAL_HISTORY_ENV}).status!==0) await fail(behind());
      // The lander's merge starts from the project's tip itself (G2): a
      // checkout ahead of it holds commits no landing reviewed, which the
      // push would publish with the merge.
      else if (lander && local!==baselineHead) {
        const ahead=git(['log','--format=%h %s',`${baselineHead}..${local}`],{cwd,allowFail:true}).stdout.trim().split('\n').filter(Boolean);
        await fail(`${p.branch} in ${cwd} is at ${short(local)}, ${ahead.length} commit${ahead.length===1?'':'s'} ahead of the project's ${p.branch} (${short(baselineHead)}), which no landing reviewed:\n  ${ahead.slice(0,10).join('\n  ')}\nThe landing merges onto the project's tip alone, so nothing was merged or pushed.\nnext: only the developer can: move those commits off ${p.branch} in ${cwd} (or land them as a task), then run atelier land ${id} again`);
      }
      journal.save({start:local,phase:'prepared',baselineStart:baselineHead});
    }
    if (!journal.state.mergeCommit) {
      // What is merged: the accepted head, or its rebuilt twin on the project's commits.
      let target=item.acceptedHead;
      if (fresh) {
        try { target=carryTask(git,cwd,journal.state.baselineStart??baselineHead,item.acceptedHead,pairs); } catch (error) { journal.clear(); await fail(error.message); }
        if (!target) { journal.clear(); await fail('the accepted revision adds nothing to the baseline'); }
      }
      // Recover a commit made just before a crash prevented the journal update.
      const parents=git(['rev-list','--parents','-n','1','HEAD'],{cwd}).split(' ');
      const ownCommit=parents.length===3 && parents[1]===journal.state.start && parents[2]===target && git(['log','-1','--format=%B'],{cwd}).split('\n').includes(marker);
      if (ownCommit) journal.save({mergeCommit:local,phase:'committed'});
      else {
        if(local!==journal.state.start) await fail('checkout moved during an interrupted merge; inspect the journal before retrying');
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
        if(clashes.length){journal.clear();await fail(`the merge would hold paths that a Mac stores as one file, since they differ only by letter case or Unicode form: ${clashes.map(g=>g.join(' and ')).join('; ')}. Git would write one over the other in this checkout and in every clone on a Mac. Nothing was merged; the task's holder must rename or remove all but one of each and submit a new revision`);}
        // A file that this checkout's Git configuration runs (a hook, a
        // filter or merge driver script, an included configuration file)
        // and that the merge would change would run during the merge, or
        // stay to run at the owner's next Git command. The changed paths
        // are those between this checkout and the merge's own tree.
        let runs;
        try{runs=touchedExecutables(git(['diff','--name-only','--no-renames','-z',local,tree],{cwd,raw:true}).split('\0').filter(Boolean),executablePaths(cwd,gitEnv()));}
        catch(error){journal.clear();await fail(error.message);}
        if(runs.length){journal.clear();await fail(`the accepted change touches files that this checkout's Git configuration runs: ${describeTouched(runs)}. Landing it would run them, during the merge or at your next Git command. Nothing was merged; review those files in the accepted change and land it by hand, or have the task's holder submit a revision that leaves them alone`);}
        // The merge onto the baseline goes through the merge pipeline
        // (cli/merge-pipeline.mjs) and runs no generator in this checkout.
        // Where it needs one, verifyAccepted runs the merge first in a
        // throwaway clone pinned to this checkout's head and the accepted
        // head: outputs equal to the accepted revision's, mode and bytes,
        // were checked and reviewed with it, so the merge goes on and takes
        // them from it; anything else was never checked or reviewed, so
        // nothing is merged and the task goes back to its builder (atelier
        // land refuses an accepted task). The approval stays bound to the
        // accepted head and never carries over to outputs generated after it.
        const preview=previewMerge(cwd,local,target,{git});
        let adopt=null;
        if(!preview.error&&(preview.regenerate.length||preview.generated.length)){
          const verified=await verifyAccepted(cwd,local,target,{git,identity});
          const moved=git(['rev-parse','HEAD'],{cwd});
          if(verified.ok&&moved!==local)Object.assign(verified,{ok:false,reason:`${p.branch} moved from ${short(local)} to ${short(moved)} while the outputs were compared`});
          if(!verified.ok){journal.clear();await fail(`merging ${id} would regenerate ${[...new Set([...preview.generated,...(readManifest(cwd,{git,rev:preview.tree})?.generators??[]).filter(g=>preview.regenerate.includes(g.name)).flatMap(g=>g.outputs)])].join(', ')}, since the baseline and the accepted revision both changed what ${preview.regenerate.length===1?'its generator reads':'their generators read'} (${preview.regenerate.join(', ')}), and ${verified.reason}. Outputs that are not the accepted revision's were never checked or reviewed, so nothing was merged and ${id} stays accepted. The generators' logs and the comparison are in ${verified.kept}. The developer can send it back to a runner with atelier dispatch ${id} --job merge-main, or hand it to a builder with atelier handoff ${id} --to H/M: main is merged into its workspace there and the outputs regenerated, and the new head is checked, reviewed and accepted again before it merges`);}
          adopt={tree:verified.tree,regenerated:verified.regenerated};
        }
        const result=await mergeThrough(cwd,target,{git,commit:false,leave:false,generate:false,adopt});
        if(result.state==='conflicts'||result.state==='stopped'||result.state==='failed'){
          journal.clear();
          if(item.kind==='plan')await planConflicted(name,id,item);
          // A conflict names its files on the landing record (G1); the
          // approval stands at the accepted head, and who resolves it is not
          // the lander's to decide.
          const files=[...(result.source??[]),...(result.records??[]),...(result.generated??[])];
          await fail(`merge conflicts; nothing was merged and ${id} stays accepted.${result.state==='conflicts'?`\n${describeConflicts(result,result.manifest)}\n`:` ${result.reason}. `}The developer can send it back to a runner with atelier dispatch ${id} --job merge-main, or hand it to a builder with atelier handoff ${id} --to H/M. The builder resolves the conflicts, rechecks and submits a new revision for review and acceptance; earlier reviews and acceptance stay in the history`,files.length?{files,mainHead:baselineHead}:{mainHead:baselineHead});
        }
        if (!existsSync(join(gitDir,'MERGE_HEAD'))) { journal.clear(); await fail('this revision is already in the checkout without this merge record; reconcile its history first'); }
        // The tree published is the one verifyAccepted compared: anything
        // else the merge left in the index refuses.
        if(adopt){
          const left=indexBeyond(cwd,adopt.tree,{git});
          if(left.length){git(['merge','--abort'],{cwd,allowFail:true});journal.clear();await fail(`the merge would publish ${left.join(', ')}, which the compared tree does not hold. Nothing was merged and ${id} stays accepted`);}
        }
        // The merge commit is the landing's own, made under the project's
        // identity whatever this checkout or its environment would give,
        // with the pipeline's provenance in its trailers.
        git(['commit','--quiet','-m',[`Merge ${id}: ${item.title}\n\n${marker}\nWorked by: ${owners.join(' → ')||item.owner}`,...result.provenance].join('\n')],{cwd,env:identityEnv(identity)});
        journal.save({mergeCommit:git(['rev-parse','HEAD'],{cwd}),phase:'committed'});
      }
      await record('merge-main',Date.now()-stepAt,{head:item.acceptedHead,mainHead:journal.state.baselineStart??baselineHead,mergeCommit:journal.state.mergeCommit});
    }
    // The lander's checks on the merged tree (G2), before anything is
    // published: a failure puts the checkout back where the merge began and
    // pushes nothing, and the task stays accepted with its approvals.
    if (lander && journal.state.checked!==journal.state.mergeCommit) {
      const undo=()=>{git(['reset','--quiet','--hard',journal.state.start],{cwd});journal.clear();};
      const checked=await checkMergedTree({name,id,cwd,policy:d.policy,identity,commit:journal.state.mergeCommit,secrets:[apiToken(),base.token,ws.token],begin,
        stop:async(message,data)=>{undo();await fail(message,data);},record});
      journal.save({mergeCommit:checked,checked});
    }
    begin('push');
    const mergeCommit=journal.state.mergeCommit;
    const at=git(['rev-parse','HEAD'],{cwd});
    if(at!==mergeCommit)await fail(`the checkout moved after the merge: ${p.branch} is at ${short(at)}, not at the merge commit ${short(mergeCommit)}. Put ${p.branch} back on ${short(mergeCommit)}, moving any commits of yours off it, then run atelier merge ${id} again, or cancel the landing with: atelier merge ${id} --cancel`);
    // Take the landing lease: it confirms the acceptance has not moved and
    // stops a push over this revision until the merge is recorded.
    // A refusal ends the command here with the server's reason; the local
    // merge commit is kept for reconciliation.
    try { await request('POST',`${I(name,id)}/landing`,{head:item.acceptedHead},OWNER); }
    catch (error) { await fail(error.message,{},error.code); }
    // The note goes to the public remote too, so it names reviewers and verdicts but never their text (cli/provenance.mjs).
    const note=provenanceNote({name,id,item,view,reviews,events:d.events,policy:d.policy,acceptanceFamily:d.acceptanceFamily,checkedTree:checkedTreeMatch(cwd,d.evidence,d.policy,item.acceptedHead,mergeCommit)});
    // The notes commits refs/notes/atelier holds that FROM (a remote's notes
    // tip, or nothing) does not, checked against the policy's identity.
    // A remote the policy declares a public mirror takes only the project's own
    // public address (publicRefusals), never an agent's, as wrap's push does.
    const notesRangeRefusals=(from,remote=null)=>{
      const known=from&&git(['cat-file','-e',`${from}^{commit}`],{cwd,allowFail:true}).status===0;
      if(!remote||!isPublicMirror(identity,remote))return identityRangeRefusals(git,cwd,identity,known?from:null,'refs/notes/atelier');
      const log=git(['log',`--format=${IDENTITY_LOG_FORMAT}`,known?`${from}..refs/notes/atelier`:'refs/notes/atelier'],{cwd,raw:true});
      return publicRefusals(identity,parseIdentityLog(log));
    };
    // Reconcile provenance independently: a previous push can publish only one ref.
    const listedNotes=git(['ls-remote',base.remote,'refs/notes/atelier'],{cwd,token:base.token,allowFail:true});
    const remoteNotes=listedNotes.status===0?listedNotes.stdout.trim():'';
    if(remoteNotes){
      git(['fetch','--quiet',base.remote,'refs/notes/atelier'],{cwd,token:base.token});
      if(git(['rev-parse','--verify','refs/notes/atelier'],{cwd,allowFail:true}).status===0)
        git(['notes','--ref=atelier','merge','FETCH_HEAD'],{cwd,...(identity?{env:identityEnv(identity)}:{})});
      else git(['update-ref','refs/notes/atelier','FETCH_HEAD'],{cwd});
    }
    // The baseline gets the merge commit itself, or, for a baseline holding
    // part of the history, its twin: the same tree, authors, dates and
    // message on the baseline's head and the accepted head. The same inputs
    // give the same twin, so a retry publishes the same commit.
    const published=fresh?rebuild(git,cwd,mergeCommit,[journal.state.baselineStart??baselineHead,item.acceptedHead]):mergeCommit;
    if(fresh)savePairs(gitDir,name,{...loadPairs(gitDir,name),[published]:mergeCommit});
    // Every commit the push adds to the baseline, the landing's generated
    // merge commit and its twin included, is checked again before it goes.
    const landingRefusals=identityRangeRefusals(git,cwd,identity,baselineHead,published);
    if(landingRefusals.length)await fail(`the landing would put commits on the baseline whose identity the project's policy refuses:\n  ${landingRefusals.join('\n  ')}\nNothing was pushed. Remove the merge with atelier merge ${id} --cancel --discard-local, then merge again.`);
    for(const c of new Set([mergeCommit,published])){
      const priorNote=git(['notes','--ref=atelier','show',c],{cwd,allowFail:true});
      if(priorNote.status!==0||priorNote.stdout.trim()!==note.trim())git(['notes','--ref=atelier','add','-f','-m',note,c],{cwd,...(identity?{env:identityEnv(identity)}:{})});
    }
    // The notes ref is history too: every notes commit the push adds, the ones
    // merge and add just made included, carries the project's identity (t451).
    const notesRefusals=identity?notesRangeRefusals(remoteNotes.split(/\s/)[0]||null):[];
    if(notesRefusals.length)await fail(`the landing would push provenance notes whose identity the project's policy refuses:\n  ${notesRefusals.join('\n  ')}\nNothing was pushed. Remove the merge with atelier merge ${id} --cancel --discard-local, fix refs/notes/atelier, then merge again.`);
    const alreadyPublished=git(['merge-base','--is-ancestor',published,baselineHead],{cwd,allowFail:true}).status===0;
    // The push itself (G2): the merge commit to the project's branch and
    // nothing else, through one function (pushMergeToProjectBranch), so the
    // credential it carries can be swapped for a landing grant (task 6).
    // Nor through the checkout's own commits the push carries with it (t645).
    // A cancel the Ledger took before the merge began stops it before the push.
    if(lander&&!alreadyPublished){
      const now=(await request('GET',I(name,id),undefined,OWNER).catch(()=>null))?.landing;
      if(now?.cancelled)await fail(`${id}'s queued landing was cancelled before its merge was pushed, so nothing was pushed; the merge commit is left in the checkout: atelier merge ${id} --cancel --discard-local removes it`);
    }
    let pushed=null, refusedPush=null;
    try {
      pushed=alreadyPublished?{status:0}:guardedPush({project:name,cwd,tip:published,base:[baselineHead],what:'The landing',fail:(m)=>{throw new GuardStop(`${m} Remove the merge with atelier merge ${id} --cancel --discard-local, then merge again.`);}},
        (sha)=>pushMergeToProjectBranch({git,cwd,remote:base.remote,token:base.token,commit:sha,branch:p.branch}));
    } catch (error) { if (error instanceof GuardStop) refusedPush=error.message; else throw error; }
    if (refusedPush) await fail(refusedPush);
    if (pushed.status!==0) {
      const said=String(pushed.stderr||pushed.stdout||'').split(base.token||'\0').join('[redacted]').trim();
      // Main moved since the merge was made: the push was not a fast-forward
      // (Git refuses it, and the hook would). Read main again to tell that
      // from any other refusal.
      const again=git(['fetch','--quiet',base.remote,p.branch],{cwd,token:base.token,allowFail:true});
      const now=again.status===0?git(['rev-parse','FETCH_HEAD'],{cwd}):null;
      const moved=!!now&&now!==baselineHead&&git(['merge-base','--is-ancestor',published,now],{cwd,allowFail:true}).status!==0;
      if (moved && lander && !fresh) {
        // Nothing reached main: the landing record of the merge is given
        // back, the checkout returns to where the merge began, and the
        // merge and the checks are made again on the new main.
        await request('POST',`${I(name,id)}/landing`,{cancel:true},OWNER).catch((error)=>console.error(`Warning: the landing record could not be released after main moved: ${error.message}`));
        git(['reset','--quiet','--hard',journal.state.start],{cwd});
        journal.clear();
        if (round>=MAIN_MOVED_REDOS) await fail(`main moved from ${short(baselineHead)} to ${short(now)} between the checks and the push, ${round+1} times in a row, so ${id} was not merged: each merge was checked and then refused as not a fast-forward, and nothing was pushed. ${id} stays accepted with its approvals; run atelier land ${id} again once main settles`,{rounds:round+1,mainHead:now});
        console.log(`main moved from ${short(baselineHead)} to ${short(now)} after ${id}'s merge was checked, so the push was refused and nothing reached main. Merging and checking again on the new main (${round+1} of ${MAIN_MOVED_REDOS}).`);
        await record('push',Date.now()-stepAt,{reason:`refused: main moved from ${baselineHead} to ${now}; merging and checking again`,rounds:round+1,mainHead:now});
        continue;
      }
      await fail(`the push of ${id}'s merge ${short(published)} to ${p.branch} was refused${moved?` (main moved from ${short(baselineHead)} to ${short(now)})`:''}:\n${said}\nNothing was published; the merge commit is kept in the checkout. Run atelier merge ${id} again to retry, or cancel with atelier merge ${id} --cancel --discard-local.`);
    }
    // The provenance notes go on a push of their own, after the merge (the
    // Node server's hook takes one ref per push; the owner and landing grants
    // may write refs/notes/atelier, fast-forward only). A refusal never
    // undoes the merge: the notes stay in this checkout and the next landing
    // pushes them, merged with the baseline's.
    const notesPushed=git(['push','--quiet',base.remote,'refs/notes/atelier:refs/notes/atelier'],{cwd,token:base.token,allowFail:true});
    if(notesPushed.status!==0){const lines=String(notesPushed.stderr||'').split('\n').filter(Boolean);console.log(`Provenance notes were not published to the baseline (${(lines.find((l)=>/atelier:/.test(l))??lines.at(-1)??'refused').replace(/^remote:\s*/,'').split(base.token||'\0').join('[redacted]')}); they stay in this checkout under refs/notes/atelier.`);}
    journal.save({phase:'published'});
    await record('push',Date.now()-stepAt,{mergeCommit:published,mainHead:baselineHead,...(round?{rounds:round}:{})});
    begin('merged');
    let recorded;
    try { recorded = await request('POST',`${I(name,id)}/merged`,{mergeCommit:published},OWNER); }
    catch (error) { await fail(error.message,{},error.code); }
    journal.clear();
    await record('merged',Date.now()-stepAt,{mergeCommit:published});
    const privatePublication = (recorded.postMerge?.policy ?? d.policy.postMerge)?.steps.some(s => s.class === 'publish');
    // A public notes remote gets only notes history whose identities pass; one
    // whose tip cannot be read is not pushed to (fail closed).
    let notesHeld=null;
    if(p.notesRemote&&!privatePublication&&identity){
      const listed=git(['ls-remote',p.notesRemote,'refs/notes/atelier'],{cwd,allowFail:true});
      const refused=listed.status!==0?[`${p.notesRemote}: its refs/notes/atelier could not be read`]:notesRangeRefusals(listed.stdout.split(/\s/)[0]||null,p.notesRemote);
      if(refused.length)notesHeld=refused;
    }
    const notesPush=p.notesRemote&&!privatePublication&&!notesHeld?git(['push','--quiet',p.notesRemote,'refs/notes/atelier:refs/notes/atelier'],{cwd,allowFail:true}):null;
    if(notesHeld)console.log(`Provenance notes were not pushed to ${p.notesRemote}:\n  ${notesHeld.join('\n  ')}`);
    console.log(`${id} merged as ${short(mergeCommit)} in ${cwd}${published!==mergeCommit?` (on the baseline as ${short(published)})`:""}; baseline and ledger agree.`);
    console.log(`Provenance: git notes --ref=atelier show ${short(mergeCommit)}`);
    if(notesPush?.status===0)console.log(`Provenance notes pushed to ${p.notesRemote}.`);
    else if(notesPush)console.log(`Provenance notes need retry: git push ${p.notesRemote} refs/notes/atelier:refs/notes/atelier`);
    await cleanWorkspace(name, id, p.branch, cwd);
    if (recorded.postMerge || d.policy.postMerge || d.postMerge) await postMerge(name, id);
    else console.log("The project branch was not pushed to its own remotes. Nothing was deployed.");
    break;
    }
  } finally { unlock?.(); }
}

// How many times the lander's merge is made and checked again after main
// moved between its checks and its push (G2): twice, so at most three merges
// are checked, and each is pushed once at most.
export const MAIN_MOVED_REDOS = 2;
class GuardStop extends Error {}

// The project's checks on the merged tree (G2), in a clean clone of the merge
// commit made from the registered checkout: first the project's regenerate
// command where its policy declares one, whose changes are folded into the
// merge commit (its parents stay the branch's tip and the accepted head, as
// the hook's rule 4 wants), then each required check, once. A check observed
// once per merge result: a failure is not run again, so a flaky pass on a
// second run is never what lands. Each is recorded as a landing step, a
// failure with the last lines of the failing check's own output. Answers the
// merge commit the checks passed on.
async function checkMergedTree({ name, id, cwd, policy, identity, commit, secrets, begin, stop, record }) {
  const cmds = Array.isArray(policy?.checks) ? policy.checks : [];
  const regenerate = typeof policy?.regenerate === "string" && policy.regenerate ? policy.regenerate : null;
  begin("checks");
  const refused = [...(policy?.prepare ? [policy.prepare.command] : []), ...cmds].flatMap((cmd) => { const why = refusalOf(cmd); return why ? [refusalText(cmd, why)] : []; });
  if (refused.length) await stop(`${refused.join(".\n")}.\nNothing was merged or pushed; ${id} stays accepted.`);
  if (!cmds.length && !regenerate) { await record("checks", 0, { skipped: true, reason: "the project declares no required checks" }); return commit; }
  const { dir } = cleanClone(cwd, null, commit, null, name);
  const sequence = releaseSequence({ project: name, task: id, actor: OWNER });
  const cleanup = () => removeClone(dir);
  process.once("exit", cleanup);
  try {
    let checked = commit;
    if (regenerate) {
      begin("regenerate");
      const t0 = Date.now();
      console.log(`Regenerating with \`${regenerate}\` on the merged tree…`);
      const r = await runRegenerateIn(dir, regenerate, { redact, secrets: () => secrets }, policy);
      // The record's tail is the command's own output, redacted, not ours.
      if (!r.ok) await stop(`the regeneration command \`${regenerate}\` failed on the merged tree (${r.why}); nothing was pushed and ${id} stays accepted. Fix the command (atelier init --regenerate), then run atelier land ${id} again. Its output ends:\n${tailOf(r.output)}`, { command: regenerate, tail: tailOf(r.output) });
      const changed = !!landingGit(["status", "--porcelain", "-uall"], { cwd: dir });
      if (changed) {
        landingGit(["add", "-A"], { cwd: dir });
        landingGit(["commit", "--quiet", "--amend", "--no-edit"], { cwd: dir, env: identityEnv(identity) });
        checked = landingGit(["rev-parse", "HEAD"], { cwd: dir });
        landingGit(["fetch", "--quiet", dir, "HEAD"], { cwd });
        landingGit(["reset", "--quiet", "--hard", checked], { cwd });
        console.log(`The regeneration changed the merged tree; folded into the merge commit ${short(checked)}.`);
      }
      await record("regenerate", Date.now() - t0, { command: regenerate, changed, mergeCommit: checked });
      begin("checks");
    }
    if (!cmds.length) return checked;
    const t0 = Date.now();
    // What passes must describe what is pushed: before each check and after
    // the last, the clone's HEAD is the merge commit and its tracked tree
    // and index are as that commit holds them (untracked build output may
    // stand). A change names the step that made it, and nothing is pushed.
    const unchanged = async (after) => {
      const head = landingGit(["rev-parse", "HEAD"], { cwd: dir });
      const worktree = landingGit(["diff", "--quiet", "HEAD"], { cwd: dir, allowFail: true }).status;
      const index = landingGit(["diff", "--cached", "--quiet"], { cwd: dir, allowFail: true }).status;
      if (head === checked && worktree === 0 && index === 0) return;
      const what = head !== checked ? `moved HEAD from the merge commit ${short(checked)} to ${short(head)}` : `changed tracked files (${landingGit(["diff", "--name-only", "HEAD"], { cwd: dir, allowFail: true }).stdout.split("\n").filter(Boolean).slice(0, 10).join(", ") || "the index"})`;
      await stop(`${after} ${what} in the clone the checks run in, so the checks would not describe the merge that is pushed; nothing was pushed and ${id} stays accepted. Make the checks and their preparation leave tracked files alone, then run atelier land ${id} again`, { mergeCommit: checked });
    };
    await prepareChecks(policy.prepare, (cmd) => runCheck(cmd, dir, secrets, sequence.next(), undefined, policy), secrets).catch((error) => stop(`the checks' preparation failed on the merged tree: ${error.message}\nNothing was pushed; ${id} stays accepted.`));
    let previous = policy.prepare ? `the checks' preparation (\`${policy.prepare.command}\`)` : "the clone's set-up";
    for (const cmd of cmds) {
      await unchanged(previous);
      previous = `the check \`${cmd}\``;
      const r = await runCheck(cmd, dir, secrets, sequence.next(), undefined, policy);
      console.log(`${r.passed ? "PASS" : r.stopped ? "STOP" : "FAIL"}  ${cmd}  @ ${short(checked)} (the merge of ${id} into main)`);
      if (!r.passed) {
        const why = r.stopped ? stopLine(r.stopped) : r.error ? r.error.message : `exit ${r.status ?? "by a signal"}`;
        await stop(`the check \`${cmd}\` failed on the merged tree (${why}), so nothing was pushed to main; ${id} stays accepted with its approvals, and is not rejected. Its output ends:\n${tailOf(r.output)}`, { failedCheck: cmd, tail: tailOf(r.output), mergeCommit: checked });
      }
    }
    await unchanged(previous);
    await record("checks", Date.now() - t0, { mergeCommit: checked, statuses: cmds.map((c) => `passed: ${c}`.slice(0, 200)) });
    return checked;
  } finally {
    try { await sequence.close(); } finally { process.off("exit", cleanup); cleanup(); }
  }
}
