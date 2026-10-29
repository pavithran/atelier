// The one place a change that ends or rotates a task's Git grant takes the
// task's lock (Atelier 2.0, task 5; docs/branches.md): the Ledger stub of the
// Node runtime. Every Ledger method that writes an item's owner, write token
// (token_id) or claim generation, or closes an item, directly or through the
// private methods it calls, is listed here, so no route, page or tick can
// make the change without waiting for the pushes in flight on the task.
// test/claim-branch-ledger-locks.test.mjs reads src/ledger.ts for those
// writes and fails on a method missing from the table.
//
// The scope of each method:
//   task     the task its first argument names: the project's lock as a
//            reader and the task's as a writer. A part or a plan reaches
//            other tasks of its plan, so it takes the project's as a writer.
//   planned  a change to an ordinary task that ends no grant: no lock. On a
//            part or a plan it may rework or reopen another task of the plan
//            (afterPlanChange, the plan tick), so it takes the project's
//            lock as a writer.
//   project  a change that may reach any task of the project: the project's
//            lock as a writer, which waits for every push in it.
//   lease    a change to the project's landing lease (task 6): the project's
//            lock as a reader and, as a writer, the lock of the task its first
//            argument names and of the task that holds the lease now, so a
//            take, takeover, renewal or release waits for the landing push in
//            flight on either, and a landing push that starts meanwhile waits
//            for it and is then refused.
// Since task 6 every method that writes an item's head or acceptance takes
// the task's lock too (never "planned"): a landing grant counts only while
// its task is accepted at its head.
export const GRANT_LOCKS = {
  claim: "task", unclaim: "task", recordToken: "task", recordRunnerGit: "task", recordOwnerPortToken: "task",
  release: "task", handoff: "task", abandon: "task", dispatch: "task", merged: "task", recordMerge: "task", landedFast: "task",
  accept: "task", setBlockedBy: "task", recordPush: "task", observePush: "task", editItem: "task", addReview: "task", setFork: "task", moveFork: "task", taskRefreshed: "task",
  beginProjectLanding: "lease", renewProjectLanding: "lease", cancelProjectLanding: "lease",
  submit: "planned", addEvidence: "planned",
  claimReview: "planned", withdrawReviewRequest: "planned", claimCriteriaReview: "planned", addCriteriaReview: "planned",
  failCriteriaReview: "planned", requestCriteriaReview: "planned", resolveCriteriaFinding: "planned",
  integratePart: "project", integrationFailed: "project", stopPlan: "project", approvePlan: "project",
  planRefresh: "project", planResolve: "project", reroutePlan: "project", retryPlan: "project",
  refreshed: "project", refreshFailed: "project", poolChanged: "project", setMode: "project",
  retickDeployed: "project", initProject: "project", alarm: "project",
};

const TASK = /^t[1-9][0-9]*$/;

// The Namespace's `around` for project Ledgers: takes the method's locks
// before the call joins the Ledger's queue, and releases them when it
// settles. `git` is the GitHost; `stub(name)` a stub of the named object.
export function ledgerLocks(git, stub) {
  let RuleError;
  const refused = async (task) => {
    RuleError ??= (await import("../rules.ts")).RuleError;
    return new RuleError("push_running", `a push to ${task ? `${task}'s branch` : "this project"} is still running, and it ends within 15 minutes; nothing was changed`, 503, "wait for the push to end, then run the same command again");
  };
  // The lease's locks: the named task's and the holder's, taken in order;
  // a holder that changed while they were taken is locked again.
  const leaseLocked = async (key, id, call) => {
    const holderOf = async () => (await stub(`project:${key}`).readProjectLanding().catch(() => null))?.item ?? null;
    for (;;) {
      const holder = await holderOf();
      const tasks = [...new Set([id, holder].filter((t) => typeof t === "string" && TASK.test(t)))];
      let release;
      try { release = await git.lock(key, tasks); }
      catch { throw await refused(tasks[0] ?? null); }
      if (await holderOf() !== holder) { release(); continue; }
      try { return await call(); } finally { release(); }
    }
  };
  return async (name, method, args, call) => {
    // A call made on a model's word (G18) reaches the Ledger as actingCall
    // (acting, method, args): its locks are the method's own.
    if (method === "actingCall" && typeof args?.[1] === "string") [method, args] = [args[1], Array.isArray(args[2]) ? args[2] : []];
    const scope = GRANT_LOCKS[method];
    if (!scope || !name.startsWith("project:")) return call();
    const key = name.slice("project:".length);
    const first = args?.[0];
    const id = typeof first === "string" ? first : typeof first?.itemId === "string" ? first.itemId : null;
    let task = null;
    if (scope !== "project" && id && TASK.test(id)) {
      const item = await stub(name).item(id).catch(() => null);
      const planned = !item || item.kind === "plan" || item.kind === "part";
      if (!planned && scope === "planned") return call();
      task = planned ? null : id;
    }
    if (scope === "lease") return leaseLocked(key, id, call);
    let release;
    try { release = await git.lock(key, task); }
    catch { throw await refused(task); }
    try { return await call(); } finally { release(); }
  };
}
