import { releaseSequence } from "../load.mjs";
// atelier check. Its forms, flags and help are declared in src/usage/commands/check.ts.
import { prepareChecks } from "../../src/check-preparation.ts";
import { join } from "node:path";
import { checkApplies } from "../../src/rules.ts";
import { collectFailureLines, LOCAL_OUTPUT_TAIL } from "../../src/check-failure.ts";
import { appliesText, refusalOf, refusalText } from "../../src/checks.ts";
import { CLEAN_CLONE, I, OWNER_NAME, actor, apiToken, args, at, call, cleanClone, cliState, die, doneChecks, itemArg, mergeWithMain, postEvidence, project, removeClone, runCheck, short, workspacePath, workspaceTokens } from "../atelier.mjs";

export const SANDBOX_GONE = "atelier: this project's policy names the container check mode (sandboxOnly), which Atelier no longer has; running the checks here, in a clean clone on this machine. The next atelier init writes the policy without it.\n";
const FLAKE_NOTE = "failed once, then passed on a rerun at the same head";

// Observed evidence: run each required check (or the given command) in a
// clean clone of exactly the head Artifacts holds, and record the result.
export default async function checkCommand() {
  const name = project(), id = itemArg(), as = await actor();
  const d = await call("GET", I(name, id), undefined, as);
  // A policy recorded before t768 may still name the container check, which
  // is gone: the checks run here, said once, and the policy is not read again.
  if (d.policy.sandboxOnly) process.stderr.write(SANDBOX_GONE);
  const cmds = args.rest?.length ? [args.rest.join(" ")] : d.policy.checks;
  if (!cmds.length) die("this project has no required checks; pass one: atelier check -- npm test");
  // A command that is never read-only is not run, here or anywhere.
  const refused = [...(d.policy.prepare ? [d.policy.prepare.command] : []), ...cmds].flatMap((cmd) => { const why = refusalOf(cmd); return why ? [refusalText(cmd, why)] : []; });
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
  let failed = 0, recorded, mainHead, provenance = "";
  const evidenceBody = (cmd, r, note) => {
    const lead = [r.logPath ? `Full redacted local log: ${r.logPath}` : "", note ? `FLAKE: ${note}` : "", provenance].filter(Boolean).join("\n\n");
    const tailSize = lead ? Math.max(500, LOCAL_OUTPUT_TAIL - lead.length) : LOCAL_OUTPUT_TAIL;
    const failureLines = !r.passed && r.output.length > tailSize ? collectFailureLines(r.output) : "";
    return {
      kind: "check", claim: cmd, head: ws.head, passed: r.passed, changedPaths: changed,
      outputTail: lead ? `${lead}\n\n${r.output.slice(-tailSize)}\n[sha256 of full output: ${r.sha}]` : `${r.output.slice(-LOCAL_OUTPUT_TAIL)}\n[sha256 of full output: ${r.sha}]`,
      ...(failureLines ? { failureLines } : {}),
      ...(mainHead ? { merged: true, mainHead } : {}),
    };
  };
  const sequence = releaseSequence({ project: name, task: id, actor: as });
  try {
    // --merged checks the would-be merge: the head merged with main's head,
    // in this clone. The evidence is bound to both revisions, and the
    // Worker refuses a main head that is not on main's line. What the merge
    // regenerated or united, and where its generator logs are kept, goes at
    // the head of each check's output, which outlives the clone.
    if (args.merged) ({ main: mainHead, provenance } = await mergeWithMain(dir, id, name));
    await prepareChecks(policy.prepare, (cmd) => runCheck(cmd, dir, secrets, sequence.next()), secrets).catch((error) => die(error.message, 2));
    const on = mainHead ? ` merged with main ${short(mainHead)}` : "";
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
      let r = await runCheck(cmd, dir, secrets, sequence.next());
      // A check that fails is run once more at the same head (t744): a
      // result that changes with nothing else changed is the machine's, not
      // the change's. Both results are recorded, the failure first, so the
      // history shows the flake, and the gate counts the later pass. A check
      // that fails twice stays failed, and one that timed out is not run again.
      let flake = false;
      if (!r.passed && !r.timedOut) {
        process.stderr.write(`atelier: \`${cmd}\` failed; running it once more at the same head\n`);
        const first = r;
        await postEvidence(`${I(name, id)}/evidence`, evidenceBody(cmd, first, ""), as);
        r = await runCheck(cmd, dir, secrets, sequence.next());
        flake = r.passed;
      }
      // The Worker measures the changed paths from Artifacts and ignores this
      // list, which is sent only so a deployment without that measurement
      // still records one. The list printed below is the one the Worker
      // recorded, which is the one the gate reads; this clone's is shown only
      // when the reply carries none. A merged check measures no paths.
      // A failed run whose output is longer than the tail kept inline also
      // posts the lines naming its failure, read from the whole output
      // (t569): the tail of `npm test` can hold only stderr noise.
      const d = await postEvidence(`${I(name, id)}/evidence`, evidenceBody(cmd, r, flake ? FLAKE_NOTE : ""), as);
      const row = d?.evidence?.filter?.((e) => e.head === ws.head && e.claim === cmd && !e.merged).at(-1);
      if (row) recorded = row.changedPaths;
      doneChecks.push({ claim: cmd, result: r.passed ? "passed" : "failed", where: CLEAN_CLONE });
      console.log(`${r.passed ? "PASS" : "FAIL"}  ${cmd}  @ ${short(ws.head)}${on}${flake ? `  (${FLAKE_NOTE})` : ""}`);
      if (!r.passed) { failed++; process.stdout.write(r.output.slice(-2000) + "\n"); }
    }
  } finally {
    try { await sequence.close(); }
    finally { process.off("exit", cleanup); cleanup(); }
  }
  const paths = recorded === undefined ? changed : recorded;
  if (mainHead) console.log(`Recorded on the merge with main at ${short(mainHead)}; these results stand beside the revision's own checks and go stale when main moves.`);
  else console.log(Array.isArray(paths) ? `changed: ${paths.join(", ") || "nothing"}` : "changed: not measured; the gate waits for a check that measures it");
  if (failed && !cliState.doneStep) process.exit(2);
}
