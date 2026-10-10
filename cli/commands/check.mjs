// atelier check. Its forms, flags and help are declared in src/usage/commands/check.ts.
import { join } from "node:path";
import { checkApplies } from "../../src/rules.ts";
import { appliesText, refusalOf, refusalText } from "../../src/checks.ts";
import { coreCount, envLoad, formatLoad, loadLimitOf, waitForLoad } from "../load.mjs";
import { CLEAN_CLONE, I, OWNER_NAME, actor, apiToken, args, at, call, checkInSandbox, cleanClone, cliState, die, doneChecks, itemArg, mergeWithMain, postEvidence, project, removeClone, runCheck, short, workspacePath, workspaceTokens } from "../atelier.mjs";

// Observed evidence: run each required check (or the given command) in a
// clean clone of exactly the head Artifacts holds, and record the result.
export default async function checkCommand() {
  if (args.sandbox) return checkInSandbox();
  const name = project(), id = itemArg(), as = await actor();
  const d = await call("GET", I(name, id), undefined, as);
  if (d.policy.sandboxOnly) return checkInSandbox();
  const cmds = args.rest?.length ? [args.rest.join(" ")] : d.policy.checks;
  if (!cmds.length) die("this project has no required checks; pass one: atelier check -- npm test");
  // A command that is never read-only is not run, here or anywhere.
  const refused = cmds.flatMap((cmd) => { const why = refusalOf(cmd); return why ? [refusalText(cmd, why)] : []; });
  if (refused.length) die(`${refused.join(".\n")}.${args.rest?.length ? "" : `\nNothing was run. Ask ${OWNER_NAME} to replace the check with atelier init --check.`}`);
  const ws = await call("POST", `${I(name, id)}/read-token`, {}, as);
  if (!ws.head) die("nothing pushed yet");
  // The base a part is measured against is its plan's fork, not the baseline
  // (docs/orchestrator.md, section 5).
  const base = await call("POST", `${I(name, id)}/base-token`, { scope: "read" }, as);
  const { dir, changed, againstMain } = cleanClone(ws.remote, ws.token, ws.head, base, name);
  // The clone goes however this command ends: below once the checks are
  // recorded, or on the way out when a step ends the command first.
  const cleanup = () => removeClone(dir);
  process.once("exit", cleanup);
  const policy = d.policy;
  // What a check could print and this command would then upload: the API
  // token, the read tokens for the fork and the baseline, and the write
  // token in the workspace's Git settings.
  const secrets = [apiToken(), ws.token, base.token, ...workspaceTokens(workspacePath(name, id))];
  let failed = 0, recorded, mainHead;
  try {
    // --merged checks the would-be merge: the head merged with main's head,
    // in this clone. The evidence is bound to both revisions, and the
    // Worker refuses a main head that is not on main's line.
    if (args.merged) mainHead = mergeWithMain(dir, id);
    const on = mainHead ? ` merged with main ${short(mainHead)}` : "";
    // A landing's required checks compete with the home runners for this
    // machine (t403): while the load average is at or above the limit they
    // wait, saying so, and each result records the load it started at. The
    // limit is ATELIER_LOAD_LIMIT when set, else the core count.
    const configuredLimit = process.env.ATELIER_LOAD_LIMIT;
    const limit = loadLimitOf(configuredLimit !== undefined && Number(configuredLimit) > 0 ? Number(configuredLimit) : undefined, coreCount());
    // One reader for the whole command, so a sequence of readings (a test's
    // ATELIER_LOAD) advances across the checks and each records its own.
    const readLoad = envLoad();
    for (const cmd of cmds) {
      // A registered check whose paths this change does not touch is not
      // run. It is recorded as not applicable, which the Worker accepts only
      // when the paths it measures itself show the same.
      if (!args.rest?.length && againstMain && checkApplies(policy, cmd, againstMain) === false) {
        const n = await postEvidence(`${I(name, id)}/evidence`, { kind: "check", claim: cmd, head: ws.head, notApplicable: true }, as);
        const row = n?.evidence?.filter?.((e) => e.head === ws.head && e.claim === cmd).at(-1);
        if (row) recorded = row.changedPaths;
        doneChecks.push({ claim: cmd, result: "not applicable", where: CLEAN_CLONE });
        console.log(`N/A   ${cmd}  @ ${short(ws.head)}  (it ${appliesText(policy, cmd)}; this change touches none of them)`);
        continue;
      }
      // The wait is per check (t403): a check that starts later must wait on
      // the load as the earlier one did, and its own starting load is what
      // its result records, not the first check's.
      const startLoad = await waitForLoad(limit, {
        readLoad,
        report: (current) => process.stderr.write(`atelier: load ${formatLoad(current)} is at or above the limit ${formatLoad(limit)}; waiting for it to fall before running the checks\n`),
      });
      const r = await runCheck(cmd, dir, secrets);
      // The Worker measures the changed paths from Artifacts and ignores this
      // list, which is sent only so a deployment without that measurement
      // still records one. The list printed below is the one the Worker
      // recorded, which is the one the gate reads; this clone's is shown only
      // when the reply carries none. A merged check measures no paths.
      const d = await postEvidence(`${I(name, id)}/evidence`, {
        kind: "check", claim: cmd, head: ws.head, passed: r.passed, changedPaths: changed,
        outputTail: `${r.output.slice(-3500)}\n[sha256 of full output: ${r.sha}]`,
        load: startLoad,
        ...(mainHead ? { merged: true, mainHead } : {}),
      }, as);
      const row = d?.evidence?.filter?.((e) => e.head === ws.head && e.claim === cmd && !e.merged).at(-1);
      if (row) recorded = row.changedPaths;
      doneChecks.push({ claim: cmd, result: r.passed ? "passed" : "failed", where: CLEAN_CLONE });
      console.log(`${r.passed ? "PASS" : "FAIL"}  ${cmd}  @ ${short(ws.head)}${on}`);
      if (!r.passed) { failed++; process.stdout.write(r.output.slice(-2000) + "\n"); }
    }
  } finally {
    process.off("exit", cleanup);
    cleanup();
  }
  const paths = recorded === undefined ? changed : recorded;
  if (mainHead) console.log(`Recorded on the merge with main at ${short(mainHead)}; these results stand beside the revision's own checks and go stale when main moves.`);
  else console.log(Array.isArray(paths) ? `changed: ${paths.join(", ") || "nothing"}` : "changed: not measured; the gate waits for a check that measures it");
  if (failed && !cliState.doneStep) process.exit(2);
}
