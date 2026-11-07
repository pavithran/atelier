import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentStep, failureKey, hash, newRevertState, redactedOutput } from "../src/post-merge.ts";
import { revertNotificationRequest } from "../src/notify.ts";
import { matchesFolded } from "../src/rules.ts";
import { checkEnv } from "./check-env.mjs";
import { runGroup } from "./group.mjs";
import { pushMergeToProjectBranch } from "./landing.mjs";
import { guardedPush } from "./private-guard.mjs";
import { readGrant } from "./read-grant.mjs";

// No shell quoting is involved in publication: the owner approves a URL,
// one ref and a privacy policy, not a shell program that could bypass it.
export async function publishPinned({ git, run, step, cwd, project }) {
  const g = async args => git(["-c", "core.hooksPath=/dev/null", "-c", "push.followTags=false", ...args], { cwd, raw: true });
  if (!hash(run.after) || (await g(["rev-parse", "--is-shallow-repository"])).trim() !== "false") throw new Error("publication requires complete history");
  const tip = async () => {
    const lines = (await g(["ls-remote", "--refs", step.destination, step.ref])).trim();
    if (!lines) return null;
    const rows = lines.split("\n");
    if (rows.length !== 1 || rows[0].split(/\s+/)[1] !== step.ref || !hash(rows[0].split(/\s+/)[0])) throw new Error("unknown destination history");
    return rows[0].split(/\s+/)[0];
  };
  // Successful content scans are reusable only within this policy/execution.
  // Paths still need checking on every occurrence, including renamed blobs.
  const scannedBlobs = new Set();
  for (let tries = 0; tries < 3; tries++) {
    const remote = await tip();
    if (remote) {
      await g(["fetch", "--no-tags", step.destination, remote]);
      await g(["merge-base", "--is-ancestor", remote, run.after]);
    }
    const commits = (await g(["rev-list", run.after, ...(remote ? ["--not", remote] : [])])).trim().split("\n").filter(Boolean);
    for (const commit of commits) {
      const [an, ae, cn, ce] = (await g(["show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce%x00", commit])).split("\0");
      // Pretty-format output can truncate a commit message at an embedded
      // NUL. Read the raw object so even malformed message tails are scanned.
      const raw = await g(["cat-file", "commit", commit]);
      const separator = raw.indexOf("\n\n");
      if (separator === -1) throw new Error(`unreadable commit ${commit}`);
      const message = raw.slice(separator + 2);
      const identity = (list, name, email) => list.some(i => i.name === name && i.email === email);
      if (!identity(step.privacy.authors, an, ae) || !identity(step.privacy.committers, cn, ce)) throw Object.assign(new Error(`privacy identity rejected at commit ${commit}`), { privacy: true });
      const forbidden = text => step.privacy.patterns.some(p => text.includes(p));
      if (forbidden(message)) throw Object.assign(new Error(`privacy message rejected at commit ${commit}`), { privacy: true });
      for (const entry of (await g(["ls-tree", "-r", "-z", "--full-tree", commit])).split("\0").filter(Boolean)) {
        const tab = entry.indexOf("\t"), path = entry.slice(tab + 1);
        const [mode, type, object] = entry.slice(0, tab).split(" ");
        // No secret value or matching pattern is ever included in an error.
        const safePath = JSON.stringify(step.privacy.patterns.reduce((text, pattern) => text.split(pattern).join("[redacted]"), path)).slice(0, 300);
        if (forbidden(path) || matchesFolded(path, step.privacy.forbiddenPaths)) throw Object.assign(new Error(`privacy path rejected at commit ${commit} path ${safePath}`), { privacy: true });
        if (type !== "blob" || mode === "160000") throw Object.assign(new Error(`unknown tree content at commit ${commit} path ${safePath}`), { privacy: true });
        if (!scannedBlobs.has(object)) {
          if (forbidden(await g(["cat-file", "blob", object]))) throw Object.assign(new Error(`privacy content rejected at commit ${commit} path ${safePath}`), { privacy: true });
          scannedBlobs.add(object);
        }
      }
    }
    if (await tip() !== remote) continue; // Recompute outgoing history and rescan.
    if ((await g(["rev-parse", "HEAD"])).trim() !== run.after) throw new Error("publication source moved");
    // The lease checks the remote tip atomically at receive time. Even an
    // update after the second ls-remote cannot publish an unscanned range.
    // The project's private files go to no publication either (t645).
    await guardedPush({ project, cwd, tip: run.after, base: remote ? [remote] : [], what: `The publication to ${step.destination}`, fail: (message) => { throw Object.assign(new Error(message), { privacy: true }); } },
      () => g(["push", "--no-verify", "--recurse-submodules=no", `--force-with-lease=${step.ref}:${remote ?? ""}`, step.destination, `${run.after}:${step.ref}`]));
    return { source: run.after, remote, commits: commits.length };
  }
  throw new Error("publication destination kept moving; retry to rescan");
}

// One run of a step in a fresh clone of a pinned commit, under the step's
// deadline. `source` names another remote to clone from (the checkout holding a
// revert that is not pushed yet); the default is the project's own, by grant.
export async function runStep({ request, name, run, step, env, print, group, source, commit = run.after }) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-post-merge-"));
  let passed = false, output = "", commandOutcome = "failed", publication;
  const deadline = Date.now() + step.timeoutMs;
  // The same process-group deadline covers clone, setup, scans and push.
  // Git does not load system/global configuration, filters or hooks. Owner
  // publication credentials may come from GIT_ASKPASS and its environment.
  const git = async (argv, opts = {}) => {
    const gitEnvironment = { ...env };
    for (const key of Object.keys(gitEnvironment)) if (key.startsWith("GIT_") && key !== "GIT_ASKPASS") delete gitEnvironment[key];
    Object.assign(gitEnvironment, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" });
    if (opts.token) Object.assign(gitEnvironment, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${opts.token}` });
    const result = await group(["git", "-c", "core.hooksPath=/dev/null", ...argv], { cwd: opts.cwd, env: gitEnvironment, timeoutMs: Math.max(1, deadline - Date.now()), maxBytes: 16 * 1024 * 1024 });
    if (result.status !== 0 || result.error) throw new Error("post-merge Git operation failed, timed out or exceeded its scan limit");
    return result.stdout;
  };
  try {
    const base = source ?? await readGrant(request, name);
    await git(["-c", "core.hooksPath=/dev/null", "clone", "--no-checkout", "--no-local", base.remote, dir], { token: base.token });
    await git(["-c", "core.hooksPath=/dev/null", "checkout", "--detach", commit], { cwd: dir });
    if ((await git(["rev-parse", "HEAD"], { cwd: dir })).trim() !== commit) throw new Error("clone does not hold the pinned merge");
    const command = async argv => {
      const result = await group(argv, { cwd: dir, env: step.class === "check" ? checkEnv(env) : env, timeoutMs: Math.max(1, deadline - Date.now()), maxBytes: step.class === "check" ? undefined : 1024 * 1024 });
      output += result.stdout + result.stderr;
      if (result.status !== 0 || result.error) throw new Error("post-merge command failed or timed out");
    };
    if (step.class === "publish") publication = await publishPinned({ git, run, step, cwd: dir, project: name });
    else {
      // Lockfile installation is deterministic; lifecycle scripts are part
      // of the owner's approved protected source. No install on the host.
      if (existsSync(join(dir, "package.json"))) {
        if (!existsSync(join(dir, "package-lock.json"))) throw new Error("post-merge npm setup requires package-lock.json");
        await command(["npm", "ci", "--no-audit", "--no-fund"]);
      }
      await command(step.class === "deploy" ? ["npm", "run", "deploy"] : ["/bin/sh", "-c", step.command]);
    }
    passed = true; commandOutcome = "passed";
  } catch (error) { output += error.message; if (error.privacy) print(error.message); }
  finally { rmSync(dir, { recursive: true, force: true }); }
  return { passed, output, publication, commandOutcome };
}

export async function executePostMerge({ request, name, id, env = process.env, print = console.log, group = runGroup, recover = recoverFailedLanding }) {
  const path = `/projects/${encodeURIComponent(name)}/post-merge/${encodeURIComponent(id)}`;
  let { run } = await request("GET", path);
  if (!run || run.state === "complete") return run;
  if (run.paths === null) ({ run } = await request("POST", path, { run: run.id, action: "prepare" }));
  while (run.state !== "complete") {
    if (run.state !== "pending") throw new Error(`post-merge run ${run.id} is ${run.state}; inspect with land ${id} --post-merge status`);
    ({ run } = await request("POST", path, { run: run.id, action: "start" }));
    const state = currentStep(run), step = run.policy.steps.find(s => s.name === state.name), attempt = state.attempts.at(-1);
    print(`Post-merge ${run.id} @ ${run.after}: ${step.name}, attempt ${attempt.number}`);
    const { passed, output, publication, commandOutcome } = await runStep({ request, name, run, step, env, print, group });
    // Keep the command outcome even if deployment observation or its response
    // is lost. A command report never resolves the reservation on its own.
    await request("POST", path, { run: run.id, action: "command", attempt: attempt.id, passed, publication });
    let failedOutput = output;
    try {
      ({ run } = await request("POST", path, { run: run.id, action: "finish", attempt: attempt.id, passed, commandOutcome, output: redactedOutput(output, [...Object.values(env).filter(value => typeof value === "string" && value.length >= 8), ...(step.privacy?.patterns ?? [])]) }));
    } catch (error) {
      // A successful deploy command and a wrong /version are different facts.
      // Re-submit failure only for a definite verification refusal; a lost
      // response is uncertain, never permission to replay an external effect.
      if (passed && step.class === "deploy" && error.message.includes("deployment_unverified")) {
        failedOutput = "deployment verification failed";
        ({ run } = await request("POST", path, { run: run.id, action: "finish", attempt: attempt.id, passed: false, commandOutcome, output: failedOutput }));
      } else throw error;
    }
    if (run.state === "failed") {
      // A failed check on the landed merge is put right here, with no session.
      let outcome = null;
      try { outcome = await recover?.({ request, name, id, env, print, group, run, step, output: redactedOutput(failedOutput, Object.values(env).filter(value => typeof value === "string" && value.length >= 8)) }); }
      catch (error) { print(`automatic revert of ${id} stopped: ${error.message}`); }
      if (outcome?.action === "reverted") throw new Error(`post-merge ${step.name} failed; ${id} was reverted (${outcome.revert}) and reopened`);
      throw new Error(`post-merge ${step.name} failed; ${id} remains merged; later merges are blocked`);
    }
  }
  print(`Post-merge run ${run.id} complete at ${run.after}.`);
  return run;
}

// The first-parent inverse of a landed merge, committed on the checked-out
// default branch without a task workspace or a session. A conflict aborts the
// revert and throws, leaving the tree clean. A revert already committed for
// this merge is returned as it is, so a retry after a crash adds no second one.
export function revertOnMain({ git, merge, ids, actor }) {
  if (!hash(merge)) throw new Error("revert needs the recorded merge commit");
  const note = `This reverts merge commit ${merge}, relative to its first parent`;
  const made = git(["log", "--format=%H", "-n", "1", "--fixed-strings", `--grep=${note}`, `${merge}..HEAD`]).trim();
  if (made) return made;
  const result = git(["revert", "--no-commit", "-m", "1", merge], { allowFail: true });
  if (result.status !== 0) {
    git(["revert", "--abort"], { allowFail: true });
    throw new Error(`git revert of ${merge} stopped: ${result.stderr || result.stdout}`);
  }
  git(["commit", "-m", `Revert ${ids.join(", ")}\n\n${note}, because main or the release gate went red after it landed.\n\nAgent: ${actor}`]);
  return git(["rev-parse", "HEAD"]).trim();
}

// After a landing: run the post-merge suite, then the release gate. A red one
// is run again on the same tree; a failure that passes the second time is
// flaky and nothing is reverted. A failure that stands is reverted with no
// session: the revert is checked before it lands, the task reopens with the
// failure and the owner is told once. A revert that fails its checks halts
// all reverting and wakes a session (io.wake). A repeat of a failure already
// handled, the same failure after the same merge, does nothing; the same
// failure after another merge is handled again. io.state records each stage
// after it is done (src/post-merge.ts) and io.save persists it, so a crash
// leaves later stages unset and a retry resumes without reverting twice. A
// stage that unfinished work remains in is resumed before anything is run,
// green or red. The revert is looked up before it is made (revertOnMain) and
// pushing a commit already pushed does nothing, so a crash between landing and
// its marker repeats nothing. The notification is the one stage that cannot be
// looked up: its marker is written before it is sent, so it is sent at most once.
export async function guardLanding({ project, members, head, io }) {
  const state = io.state, save = async () => { await io.save?.(state); };
  const finish = async entry => {
    if (!entry.reopened) {
      for (const id of entry.members) await io.reopen(id, entry.output);
      entry.reopened = true; await save();
    }
    if (!entry.notified) {
      if (!entry.notifying) {
        entry.notifying = true; await save();
        await io.notify(revertNotificationRequest(io.topic, io.origin, project, { itemId: entry.members[0], kind: entry.kind, mergeCommit: entry.merge, revertCommit: entry.landed }));
      }
      entry.notified = true; await save();
    }
  };
  for (const entry of Object.values(state.failures)) if (entry.landed && !entry.notified) await finish(entry);
  let kind = "suite", red = await io.suite();
  if (red.passed) { kind = "gate"; red = await io.gate(); }
  if (red.passed) return { action: "green" };
  if ((await (kind === "suite" ? io.suite() : io.gate())).passed) return { action: "flaky", kind };
  if (state.halted) {
    await io.wake(`automatic reverting is halted (${state.halted.reason}); ${members.join(", ")} turned ${kind === "gate" ? "the release gate" : "main"} red at ${head}`);
    return { action: "halted", kind };
  }
  const key = failureKey(kind, red.output, head);
  // Main standing on a revert this made is not a landing to revert again.
  if (state.failures[key]?.notified || Object.values(state.failures).some(e => e.landed === head)) return { action: "repeat", kind };
  const entry = state.failures[key] ??= { kind, members: [...members], merge: head, output: redactedOutput(red.output) };
  await save();
  if (!entry.landed) {
    const halt = async (reason, detail) => {
      state.halted = { reason, at: new Date().toISOString() };
      await save();
      await io.wake(`the revert of ${members.join(", ")} (${head}) ${detail}; no more will be reverted`);
      return { action: "halted", kind };
    };
    let sha;
    try { sha = await io.revert(members, head); }
    catch (error) { return halt("the revert could not be made", `could not be made: ${error.message}`); }
    const checked = await io.check(sha);
    if (!checked.passed) {
      await io.discard?.(sha);
      return halt(`the revert ${sha} failed its checks`, `failed its checks and was not landed: ${checked.output}`);
    }
    await io.land(sha);
    entry.landed = sha; await save();
  }
  await finish(entry);
  return { action: "reverted", kind, revert: entry.landed };
}

// The production effects of guardLanding for a check step that failed on the
// landed merge. A project with no checkout on this Mac is left to the person:
// nothing is reverted. Only check steps revert; a failed deploy or publication
// has effects a revert does not undo. The server has no way to reopen a merged
// task, so the task reopens as a fix of it (fixOf) whose brief carries the
// failing output, and a halted revert wakes a session the same way, as a task.
export async function recoverFailedLanding({ request, name, id, env, print, group, run, step, output }) {
  if (step.class !== "check") return null;
  const { cfg, landingGit, entryPath, server } = await import("./atelier.mjs");
  const entry = cfg.projects?.[name], cwd = entryPath(entry);
  if (!cwd) { print(`${name} has no checkout on this Mac; ${id} is not reverted automatically`); return null; }
  const git = (args, opts = {}) => landingGit(args, { cwd, ...opts });
  const stateFile = join(git(["rev-parse", "--absolute-git-dir"]), "atelier-auto-revert.json");
  let state;
  try { state = JSON.parse(readFileSync(stateFile, "utf8")); } catch { state = newRevertState(); }
  const kind = step.gate ? "gate" : "suite";
  let first = true;
  const again = async () => {
    if (first) { first = false; return { passed: false, output }; }
    const result = await runStep({ request, name, run, step, env, print, group });
    return { passed: result.passed, output: redactedOutput(result.output) };
  };
  const itemsPath = `/projects/${encodeURIComponent(name)}/items`;
  const topic = env.ATELIER_NTFY_TOPIC ?? env.NTFY_TOPIC;
  const wake = async reason => {
    print(reason);
    await request("POST", itemsPath, { title: "Automatic revert needs a session", brief: reason });
  };
  const io = {
    state, topic, origin: (() => { try { return server(); } catch { return "https://atelier.invalid"; } })(),
    suite: kind === "suite" ? again : async () => ({ passed: true, output: "" }),
    gate: kind === "gate" ? again : async () => ({ passed: true, output: "" }),
    save: async s => { writeFileSync(`${stateFile}.tmp`, JSON.stringify(s)); renameSync(`${stateFile}.tmp`, stateFile); },
    revert: (ids, merge) => revertOnMain({ git, merge, ids, actor: "atelier/auto-revert" }),
    check: async sha => {
      const result = await runStep({ request, name, run, step, env, print, group, source: { remote: cwd }, commit: sha });
      return { passed: result.passed, output: redactedOutput(result.output) };
    },
    discard: sha => { if (git(["rev-parse", "HEAD"]) === sha) git(["reset", "--hard", `${sha}^`]); },
    land: async sha => {
      const base = await readGrant(request, name);
      const pushed = guardedPush({ project: name, cwd, tip: sha, base: [run.after], what: "The automatic revert" },
        s => pushMergeToProjectBranch({ git: landingGit, cwd, remote: base.remote, token: base.token, commit: s, branch: entry.branch }));
      if (pushed.status !== 0) throw new Error(`the revert ${sha} was not pushed: ${pushed.stderr || pushed.stdout}`);
    },
    reopen: (member, text) => request("POST", itemsPath, { title: `Fix ${member}: its landing turned ${kind === "gate" ? "the release gate" : "main"} red`, brief: `${member} landed as ${run.after} and was reverted automatically because it turned ${kind === "gate" ? "the release gate" : "main"} red. The failing output:\n\n${text}`, fixOf: member }),
    notify: async request => {
      if (!topic) { await wake(`${members(run)} was reverted but no ntfy topic is set (ATELIER_NTFY_TOPIC), so the owner was not notified`); return; }
      const response = await fetch(request, { redirect: "error", signal: AbortSignal.timeout(10_000) });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`the revert notification was refused: ${response.status}`);
    },
    wake,
  };
  return guardLanding({ project: name, members: run.members, head: run.after, io });
}
const members = run => run.members.join(", ");
