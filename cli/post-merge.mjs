import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentStep, hash, redactedOutput } from "../src/post-merge.ts";
import { matchesFolded } from "../src/rules.ts";
import { checkEnv } from "./check-env.mjs";
import { runGroup } from "./group.mjs";
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

// The standing instruction deploy-on-landing (src/standing.ts), read the way
// atelier decisions reads it: the newest recorded value that has not been
// withdrawn. A server that cannot be read says off, never on.
async function deployOnLandingIsOn(request, name) {
  const { decisions } = await request("GET", `/projects/${encodeURIComponent(name)}/decisions`);
  const values = (Array.isArray(decisions) ? decisions : []).filter(d => d.status === "standing" && d.standing?.key === "deploy-on-landing").map(d => d.standing.value);
  return values.at(-1) === "on";
}

// Starts the deploy of a landed head in a process of its own, which outlives
// this one: the merge still holds the checkout, and a ship waits for it.
// `atelier ship` with ATELIER_AUTO_DEPLOY set is that process
// (cli/commands/ship.mjs); it writes its progress to auto-deploy.log beside
// the state it shares with the next one, not to a terminal that is gone.
function startAutoDeploy({ name, head, since, cwd, env }) {
  const cli = fileURLToPath(new URL("./atelier.mjs", import.meta.url));
  const child = spawn(process.execPath, [cli, "ship", "--project", name], {
    cwd, detached: true, stdio: "ignore", env: { ...env, ATELIER_AUTO_DEPLOY: JSON.stringify({ head, since: since ?? null }) },
  });
  child.on("error", () => {});
  child.unref();
}

// After a merge whose landing checks passed: when the project's standing
// instruction says so, a deploy of the new head starts, with no command from a
// session. It never fails the landing: whatever goes wrong is said and left.
export async function deployOnLanding({ request, name, env = process.env, cwd = process.cwd(), print = console.log, start = startAutoDeploy }) {
  try {
    if (!await deployOnLandingIsOn(request, name)) return "off";
    const base = `/projects/${encodeURIComponent(name)}`;
    const { head } = await request("GET", `${base}/baseline-head`);
    if (!hash(head)) throw new Error("the baseline has no head to deploy");
    let since = null;
    try { since = (await request("GET", `${base}/deploys`)).deploys?.find(d => d.result === "shipped")?.head ?? null; } catch { /* the deploy then waits: nothing to compare with */ }
    start({ name, head, since, cwd, env });
    print(`Deploy on landing: deploying ${head.slice(0, 8)} in the background; its record is the deploy list in atelier show.`);
    return "started";
  } catch (error) {
    print(`Deploy on landing was not started: ${error.message}. Run atelier ship to deploy by hand.`);
    return "unavailable";
  }
}

export async function executePostMerge({ request, name, id, env = process.env, print = console.log, group = runGroup, cwd, deploy = deployOnLanding }) {
  const path = `/projects/${encodeURIComponent(name)}/post-merge/${encodeURIComponent(id)}`;
  let { run } = await request("GET", path);
  if (!run || run.state === "complete") { await deploy({ request, name, env, print, cwd }); return run; }
  if (run.paths === null) ({ run } = await request("POST", path, { run: run.id, action: "prepare" }));
  while (run.state !== "complete") {
    if (run.state !== "pending") throw new Error(`post-merge run ${run.id} is ${run.state}; inspect with land ${id} --post-merge status`);
    ({ run } = await request("POST", path, { run: run.id, action: "start" }));
    const state = currentStep(run), step = run.policy.steps.find(s => s.name === state.name), attempt = state.attempts.at(-1);
    print(`Post-merge ${run.id} @ ${run.after}: ${step.name}, attempt ${attempt.number}`);
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
      const base = await readGrant(request, name);
      await git(["-c", "core.hooksPath=/dev/null", "clone", "--no-checkout", "--no-local", base.remote, dir], { token: base.token });
      await git(["-c", "core.hooksPath=/dev/null", "checkout", "--detach", run.after], { cwd: dir });
      if ((await git(["rev-parse", "HEAD"], { cwd: dir })).trim() !== run.after) throw new Error("clone does not hold the pinned merge");
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
    // Keep the command outcome even if deployment observation or its response
    // is lost. A command report never resolves the reservation on its own.
    await request("POST", path, { run: run.id, action: "command", attempt: attempt.id, passed, publication });
    try {
      ({ run } = await request("POST", path, { run: run.id, action: "finish", attempt: attempt.id, passed, commandOutcome, output: redactedOutput(output, [...Object.values(env).filter(value => typeof value === "string" && value.length >= 8), ...(step.privacy?.patterns ?? [])]) }));
    } catch (error) {
      // A successful deploy command and a wrong /version are different facts.
      // Re-submit failure only for a definite verification refusal; a lost
      // response is uncertain, never permission to replay an external effect.
      if (passed && step.class === "deploy" && error.message.includes("deployment_unverified")) {
        ({ run } = await request("POST", path, { run: run.id, action: "finish", attempt: attempt.id, passed: false, commandOutcome, output: "deployment verification failed" }));
      } else throw error;
    }
    if (run.state === "failed") throw new Error(`post-merge ${step.name} failed; ${id} remains merged; later merges are blocked`);
  }
  print(`Post-merge run ${run.id} complete at ${run.after}.`);
  await deploy({ request, name, env, print, cwd });
  return run;
}
