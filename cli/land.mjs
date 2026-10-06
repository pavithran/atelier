import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkEnv } from "./check-env.mjs";
import { runCommand } from "./ship.mjs";

// atelier land (t187): the project owner lands one task whole, taking the
// project's landing lease on the server so two sessions never race main.
// In the task's workspace it merges main (stopping on conflicts, which it
// leaves for the owner to resolve, naming the files), regenerates the
// project's fixtures when its policy declares how, then pushes and runs the
// required checks through the CLI's own commands, each as a child process so
// a failure can still release the lease and record the step. It asks the
// server for the independent review the gate needs and waits for the verdict,
// then accepts and merges. Every step, its duration and the commits that came
// from main are recorded on the ledger as land.* events (t186 reads them for
// the integration cost), and the server must hold a main commit this CLI can
// see, or the landing refuses before it starts, saying to deploy.

const CLI_DIR = dirname(fileURLToPath(import.meta.url));
const POLL_MS = Number(process.env.ATELIER_LAND_POLL_MS ?? 5000);
const REVIEW_TIMEOUT_MS = Number(process.env.ATELIER_LAND_REVIEW_TIMEOUT ?? 30 * 60_000);
const CHECK_TIMEOUT_MS = Number(process.env.ATELIER_CHECK_TIMEOUT ?? 20 * 60_000);

const short = (sha) => (sha ? sha.slice(0, 8) : "—");

// The checkout this CLI runs from and its head, or null when it is not in a
// Git checkout: the server's version is compared against this commit, since
// the routes a landing needs are the ones this CLI's own code was built with.
function cliCheckout(git) {
  const top = git(["rev-parse", "--show-toplevel"], { cwd: CLI_DIR, allowFail: true });
  if (top.status !== 0) return null;
  const head = git(["rev-parse", "HEAD"], { cwd: top.stdout.trim(), allowFail: true });
  return head.status === 0 && head.stdout.trim() ? { top: top.stdout.trim(), head: head.stdout.trim() } : null;
}

// A step that failed carries its own event data beside the failure: the files
// a conflict stopped on, or which check failed.
class StepError extends Error {
  constructor(message, data = {}) { super(message); this.data = data; }
}

export async function runLand(io) {
  const { args, name, id, p, request, git, die, print } = io;
  const dryRun = args["dry-run"] === true;
  const noReview = args["no-review"] === true;
  const reviewer = args.reviewer;
  if (reviewer !== undefined && (typeof reviewer !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(reviewer))) {
    die(`--reviewer needs harness/model, such as codex/gpt-6-astra: atelier land ${id} --reviewer H/M`);
  }
  if (noReview && reviewer !== undefined) die("--reviewer and --no-review together say two things; name the reviewer, or give --no-review to leave the task submitted");

  const itemPath = `/projects/${encodeURIComponent(name)}/items/${encodeURIComponent(id)}`;
  const leasePath = `/projects/${encodeURIComponent(name)}/landing-lease`;
  const dir = io.workspacePath(name, id);

  // The server's version and this CLI's own commit: a server older than the
  // CLI may lack the routes this command needs, so the landing refuses here,
  // saying to deploy, before the lease or any workspace changes.
  let version = null;
  try { version = await request("GET", "/version"); } catch { /* a server with no version route is one that predates it */ }
  const cli = cliCheckout(git);
  const deploy = (why) => `the server runs main at ${short(version?.commit)}, this CLI at ${short(cli?.head)}: ${why}. Deploy the server from a checkout that holds this CLI (npm run deploy, which records the commit it deploys), then run atelier land ${id} again`;
  if (!version || typeof version.commit !== "string" || !/^[0-9a-f]{40,64}$/.test(version.commit)) die(deploy(version ? "the server reports no deployed main commit" : "the server does not answer GET /api/version"));
  if (!cli) die(`this CLI, running from ${CLI_DIR}, is not inside a Git checkout, so the server's version cannot be compared with it; run atelier land from a checkout of atelier`);
  if (version.commit !== cli.head) {
    const known = git(["cat-file", "-e", `${version.commit}^{commit}`], { cwd: cli.top, allowFail: true }).status === 0;
    const holds = known && git(["merge-base", "--is-ancestor", cli.head, version.commit], { cwd: cli.top, allowFail: true }).status === 0;
    if (!holds) die(deploy("the server's main does not hold this CLI's commit"));
  }

  // The lease is read, not taken, so the checks that only refuse are asked
  // before anything changes. A lease held for another live task refuses the
  // landing with who holds it and since when.
  const { lease } = await request("GET", leasePath);
  if (lease && lease.item !== id) {
    die(`a landing is already in progress: ${lease.holder} has been landing ${lease.item} since ${String(lease.at).slice(0, 16).replace("T", " ")} UTC. One landing runs at a time in ${name}; wait for it, or run atelier land ${lease.item} again to finish or release that landing`);
  }

  const d0 = await request("GET", itemPath);
  if (["merged", "abandoned"].includes(d0.item.state)) die(`${id} is ${d0.item.state}; there is nothing to land`);
  if (d0.item.state === "accepted") die(`${id} is accepted at ${short(d0.item.acceptedHead)}; merge it with: atelier merge ${id}`);
  if (!existsSync(join(dir, ".git"))) die(`${id} has no workspace on this Mac (${dir}); it has nothing to land. Run atelier claim ${id} --as H/M first, or land a task that has one`);
  const held = { project: git(["config", "--local", "atelier.project"], { cwd: dir, allowFail: true }).stdout?.trim(), item: git(["config", "--local", "atelier.item"], { cwd: dir, allowFail: true }).stdout?.trim() };
  if (held.project !== name || held.item !== id) die(`${dir} is not ${id}'s workspace (its Git config names ${held.project ?? "no project"}/${held.item ?? "no item"}); land ${id} from the machine holding its workspace`);
  if (existsSync(join(dir, ".git", "MERGE_HEAD"))) die(`a Git merge is already in progress in ${id}'s workspace; resolve and commit it (or git merge --abort), then run atelier land ${id} again`);
  if (git(["status", "--porcelain"], { cwd: dir })) die(`${id}'s workspace has uncommitted changes; commit or set them aside before landing`);
  const regenerate = typeof d0.policy?.regenerate === "string" ? d0.policy.regenerate : null;

  if (dryRun) {
    print(`Dry run: atelier land ${id} in ${name} would:`);
    print(`  1. take the project's landing lease for ${id} (one landing at a time in ${name})`);
    print(`  2. merge main into ${id}'s workspace (${dir}); on conflicts, stop and leave them for you to resolve, naming the files`);
    print(`  3. ${regenerate ? `regenerate the project's fixtures with \`${regenerate}\` and commit what changes` : "regenerate nothing (the project declares no regenerate command)"}`);
    print(`  4. push the merged head to ${id}'s fork`);
    print(`  5. run the required checks (${d0.policy?.checks?.join(", ") || "none"}) in a clean clone of the pushed head`);
    print(`  6. submit ${id} with a summary of the merge`);
    print(noReview
      ? "  7. skip the review (--no-review): leave the task submitted for you to settle by hand"
      : `  7. ${reviewer ? `ask ${reviewer} to review` : "ask the server for the independent review the gate needs and wait for"} the verdict at the pushed head`);
    print(`  8. accept ${id} at the pushed head`);
    print(`  9. merge ${id} in ${p.path} and publish the merge to the baseline`);
    print(" 10. record each step, its duration and the commits from main as land.* events; release the lease");
    print("Nothing was changed.");
    return;
  }

  // From here every failure throws rather than dying, so the lease is
  // released and the step recorded before the command ends.
  const record = async (step, ms, data = {}) => {
    try { await request("POST", `${itemPath}/land`, { step, ms: Math.max(0, Math.round(ms)), ...data }); }
    catch (error) { print(`Warning: the landing's ${step} step could not be recorded: ${error.message}`); }
  };
  let leased = false;
  const release = async () => {
    if (!leased) return;
    try { await request("POST", leasePath, { cancel: true }); }
    catch (error) { print(`Warning: the landing lease could not be released; a later landing of ${id} takes it over: ${error.message}`); }
  };
  try {
    let t0 = Date.now();
    try {
      const { item } = await request("POST", leasePath, { item: id });
      leased = true;
      print(`Landing lease taken for ${id} (${item.state}); one landing at a time in ${name}.`);
    } catch (error) {
      throw new StepError(error.message.replace(/^landing_lease: /, "") || `the landing lease could not be taken: ${error.message}`);
    }
    await record("lease", Date.now() - t0);

    // Merge main into the workspace, no-ff, so the task carries main's
    // commits as a merge of their own.
    t0 = Date.now();
    const base = await request("POST", `${itemPath}/base-token`, { scope: "read" });
    git(["fetch", "--quiet", base.remote, base.defaultBranch], { cwd: dir, token: base.token });
    const mainHead = git(["rev-parse", "FETCH_HEAD"], { cwd: dir });
    let fromMain = [], mergedIn = false;
    if (git(["merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD"], { cwd: dir, allowFail: true }).status === 0) {
      print(`main at ${short(mainHead)} is already merged into ${id}'s workspace.`);
    } else {
      const forkPoint = git(["merge-base", "HEAD", "FETCH_HEAD"], { cwd: dir });
      fromMain = git(["rev-list", "--max-count=200", `${forkPoint}..FETCH_HEAD`], { cwd: dir }).split("\n").filter(Boolean);
      const r = git(["merge", "--no-ff", "--no-edit", "-m", `Merge main into ${id}\n\nAtelier land: main at ${mainHead}`, "FETCH_HEAD"], { cwd: dir, allowFail: true });
      if (r.status !== 0) {
        const conflicts = git(["diff", "--name-only", "--diff-filter=U", "-z"], { cwd: dir, raw: true }).split("\0").filter(Boolean);
        const data = { fromMain, ...(conflicts.length ? { conflicts, resolvedBy: "the project owner, by hand" } : {}) };
        await record("merge", Date.now() - t0, { failed: true, ...data });
        throw new StepError(conflicts.length
          ? `the merge of main at ${short(mainHead)} into ${id}'s workspace stops on conflicts in:\n${conflicts.join("\n")}\nThe merge is left in the workspace for you to resolve: cd ${JSON.stringify(dir)}, fix the files, git add, git commit. Then run atelier land ${id} again.`
          : `the merge of main at ${short(mainHead)} into ${id}'s workspace failed:\n${(r.stderr || r.stdout).trim()}\nNothing was merged; git left the workspace as it was.`, data);
      }
      mergedIn = true;
      print(`Merged main at ${short(mainHead)} into ${id}'s workspace (${fromMain.length} commit${fromMain.length === 1 ? "" : "s"} from main).`);
    }
    await record("merge", Date.now() - t0, { fromMain, ...(mergedIn ? {} : { skipped: true }) });

    // The project's fixtures, regenerated now that both lines sit in one
    // tree, so the checks below see fixtures current with them. The command
    // runs in the workspace as a check runs, and what it changes is
    // committed before the push.
    if (regenerate) {
      t0 = Date.now();
      print(`Regenerating with \`${regenerate}\`…`);
      const r = spawnSync("/bin/sh", ["-c", regenerate], { cwd: dir, env: checkEnv(), timeout: CHECK_TIMEOUT_MS, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      const output = io.redact(`${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n[atelier] ${r.error.message}` : ""}`, io.secrets());
      if (output.trim()) process.stdout.write(output.slice(-4000) + "\n");
      if (r.status !== 0) {
        await record("regenerate", Date.now() - t0, { command: regenerate, failed: true });
        throw new StepError(`the fixture regeneration command \`${regenerate}\` failed (${r.error ? r.error.message : `exit ${r.status}`}); the merge is left in the workspace. Fix the command (the project's policy declares it: atelier init --regenerate), then run atelier land ${id} again`);
      }
      let changed = false;
      if (git(["status", "--porcelain"], { cwd: dir })) {
        git(["add", "-A"], { cwd: dir });
        git(["commit", "--quiet", "-m", `Regenerate after merging main into ${id}`], { cwd: dir });
        changed = true;
        print("Committed what the regeneration changed.");
      }
      await record("regenerate", Date.now() - t0, { command: regenerate, changed });
    }

    // Push, checks and submission run as this CLI's own commands in the
    // workspace, so their output is their own and a failure still ends the
    // landing here, with the lease released and the step recorded.
    const step = async (kind, argv, cwd, data = {}) => {
      const t = Date.now();
      const r = await runCommand([process.execPath, io.atelier, ...argv, "--project", name], { cwd, env: io.env });
      if (!r.passed) {
        await record(kind, r.durationMs, { failed: true, reason: r.output.split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 500) });
        throw new StepError(`atelier ${argv[0]} failed (exit ${r.status ?? "ended by a signal"}):\n${r.output.split("\n").filter(Boolean).slice(-12).join("\n")}`);
      }
      // A function names fields only the finished step knows, such as the
      // merge commit the checkout now holds.
      await record(kind, r.durationMs, typeof data === "function" ? data() : data);
      return r;
    };
    const head = git(["rev-parse", "HEAD"], { cwd: dir });
    await step("push", ["push"], dir, { head });
    print(`Pushed ${short(head)} to ${id}'s fork.`);
    await step("check", ["check"], dir);
    await step("submit", ["submit", "--summary", mergedIn ? `Merged with main at ${short(mainHead)}; the required checks pass.` : "The required checks pass."], dir);

    // The review: the server says whether the gate needs one and who reviews;
    // --no-review leaves the task submitted for the owner to settle by hand.
    t0 = Date.now();
    if (noReview) {
      print(`${id} is submitted and left for you to settle the review by hand (--no-review): atelier review ${id} --approve --as H/M --note "…", then atelier accept ${id} and atelier merge ${id} (main is already merged; run atelier land ${id} again if the head moves).`);
      await record("review", Date.now() - t0, { skipped: true });
    } else {
      const ask = await request("POST", `${itemPath}/review-request`, reviewer ? { reviewer } : {});
      if (!ask.needed) {
        print(`No independent review is needed (${ask.reason}); accepting.`);
        await record("review", Date.now() - t0, { verdict: "none-needed", reason: String(ask.reason ?? "").slice(0, 500) });
      } else {
        const head = ask.head, since = ask.at;
        print(`${ask.requested === false ? "A review request is already open" : "Review requested"}${ask.reviewer ? ` for ${ask.reviewer}` : ""}: ${ask.reason}. Waiting for the verdict…`);
        for (let waited = 0; ; waited += POLL_MS) {
          const d = await request("GET", itemPath);
          const verdict = (d.reviews ?? []).filter((v) => v.head === head && Date.parse(v.at) >= Date.parse(since)).at(-1);
          if (verdict) {
            if (!verdict.approve) {
              await record("review", Date.now() - t0, { verdict: "reject", reviewer: verdict.by, resolvedBy: verdict.by });
              throw new StepError(`${verdict.by} rejected ${id} at ${short(head)}: ${verdict.note || "(no note)"}. The task goes back to its holder with the findings; the merge of main stays in its workspace`);
            }
            print(`${verdict.by} approved ${id} at ${short(head)}.`);
            await record("review", Date.now() - t0, { verdict: "approve", reviewer: verdict.by, resolvedBy: verdict.by });
            break;
          }
          if (d.item.head !== head) throw new StepError(`${id}'s head moved to ${short(d.item.head)} while waiting for the review; start the landing again`);
          if (waited >= REVIEW_TIMEOUT_MS) {
            await record("review", Date.now() - t0, { verdict: "timeout", reviewer: ask.reviewer ?? undefined });
            throw new StepError(`no verdict${ask.reviewer ? ` from ${ask.reviewer}` : ""} within ${Math.round(REVIEW_TIMEOUT_MS / 60000)} minutes; the review request stays open and ${id} stays submitted. Review by hand (atelier review ${id} --approve --as ${ask.reviewer ?? "H/M"} --note "…"), then atelier accept ${id} and atelier merge ${id}, or run atelier land ${id} again to wait once more`);
          }
          await new Promise((ok) => setTimeout(ok, POLL_MS));
        }
      }
    }

    // Accept and merge, again as this CLI's own commands. merge runs in the
    // registered checkout's project, publishes the merge to the baseline and
    // records it on the ledger.
    await step("accept", ["accept", id], p.path);
    const landed = await step("merged", ["merge", id], p.path, () => ({ mergeCommit: git(["rev-parse", `refs/heads/${p.branch}`], { cwd: p.path }) }));
    print(`${id} landed: ${landed.output.split("\n").filter(Boolean).at(-1) ?? "merged"}`);
  } catch (error) {
    await release();
    die(error.message);
  }
  await release();
  print(`The landing lease for ${name} is released; another task may land.`);
}
