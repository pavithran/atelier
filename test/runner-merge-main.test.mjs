import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFLICTS_ARGS, conflictsSection, mergeMainArgs, mergeMainSection, rescueWork, runTask } from "../cli/runner.mjs";

// A merge-main part's build (docs/orchestrator.md, section 5): after the
// claim and the workspace's reset, the runner fetches main at the dispatch's
// head through the plan item's base token and merges it, leaving conflicts
// in place for the harness, whose brief lists them; a clean merge is
// committed and finished with no harness. Git runs for real, in a temporary
// repository standing in for the baseline and a clone of it for the
// workspace; the CLI and the server stand in through io, as in the other
// runner tests. A task sent back after a conflicted landing (t243) runs the
// same job on its own fork: the base token is the task's own, whose base is
// the baseline, and the brief is the local one with the job's instructions
// and the conflicting files after it.

const entry = { agent: "codex", models: ["gpt-6-astra"], command: ["codex", "{brief_file}", "{workspace}"] };
const config = { agents: [entry] };
const ACTOR = "codex/gpt-6-astra";
const ID = { name: "Test", email: "test@example.com" };

const git = (cwd, ...args) => execFileSync("git", ["-c", `user.name=${ID.name}`, "-c", `user.email=${ID.email}`, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const run = (cwd, argv) => {
  try {
    return { code: 0, output: execFileSync(argv[0], argv.slice(1), { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: ID.name, GIT_AUTHOR_EMAIL: ID.email, GIT_COMMITTER_NAME: ID.name, GIT_COMMITTER_EMAIL: ID.email } }).trim() };
  } catch (error) { return { code: error.status ?? 1, output: String(error.stdout ?? "").trim(), stderr: String(error.stderr ?? "").trim() }; }
};
const commit = (cwd, file, text, message) => { writeFileSync(join(cwd, file), text); git(cwd, "add", file); git(cwd, "commit", "-q", "-m", message); return git(cwd, "rev-parse", "HEAD"); };

// The baseline with a shared file; the plan's branch (the workspace) and
// main each change it, in the same line when `conflict`, else apart.
function repos(t, conflict) {
  const root = mkdtempSync(join(tmpdir(), "atelier-merge-main-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const baseline = join(root, "baseline"), workspace = join(root, "t9");
  git(root, "init", "-q", "-b", "main", baseline);
  commit(baseline, "a.txt", "one\ntwo\nthree\n", "base");
  git(root, "clone", "-q", baseline, workspace);
  commit(workspace, "a.txt", "ONE (plan)\ntwo\nthree\n", "the plan's change");
  const main = commit(baseline, conflict ? "a.txt" : "b.txt", conflict ? "ONE (main)\ntwo\nthree\n" : "main's file\n", "main's change");
  return { root, baseline, workspace, main };
}

function fixture(t, { conflict, harness, kind = "part", findings = null, rescueReset = false }) {
  const r = repos(t, conflict);
  const calls = [], logs = [];
  const job = {
    project: "atelier", agent: "codex", model: "gpt-6-astra", actor: ACTOR,
    item: {
      id: "t9", kind, ...(kind === "part" ? { plan: "t1", partKey: "merge-main-xxxxxxxx" } : {}), title: "Merge main", scope: ["a.txt"],
      ...(kind === "task" ? { head: git(r.workspace, "rev-parse", "HEAD"), base: git(r.baseline, "rev-parse", "main~1") } : {}),
      dispatch: { to: "home", agent: "codex", model: "gpt-6-astra", by: "pavi/owner", at: "", note: "", job: "merge-main", head: r.main },
    },
  };
  const io = {
    log: (s) => logs.push(s), stopped: () => false, env: {}, ownerTokens: () => [],
    workspacePath: () => r.workspace,
    async cli(argv) {
      calls.push({ argv });
      if (argv[0] === "base-token") return JSON.stringify({ remote: r.baseline, token: "read-token", defaultBranch: "main" });
      return "";
    },
    async head(cwd) { return git(cwd, "rev-parse", "HEAD"); },
    // The real runner's reset (resetTo in cli/runner.mjs): the uncommitted
    // work — a conflicted merge a landing left, say — is saved under
    // refs/atelier/rescue, then the workspace is reset hard and cleaned.
    async reset(cwd) {
      calls.push({ reset: true });
      if (rescueReset) {
        const gitIn = (args) => run(cwd, ["git", ...args]);
        await rescueWork(cwd, async (args) => gitIn(args).output, (text) => logs.push(text));
      }
      git(cwd, "reset", "-q", "--hard", "HEAD");
      git(cwd, "clean", "-ffdq");
    },
    async fetch(cwd, remote, token, head) { calls.push({ fetch: [remote, token, head] }); git(cwd, "fetch", "-q", remote, head); },
    async mergeMain(cwd, head, message) { calls.push({ mergeMain: [head, message] }); return run(cwd, mergeMainArgs(head, message)); },
    async conflicts(cwd) { return run(cwd, CONFLICTS_ARGS).output.split("\n").filter(Boolean); },
    // A part's server brief; an ordinary task's job-brief answer, which
    // carries only the findings of a rejecting review, or nothing.
    async jobBrief() { calls.push({ jobBrief: true }); return { job: findings ? "rework" : "build", text: kind === "part" ? "SERVER BRIEF" : findings ?? "", hash: "h" }; },
    async brief(workspace, text) { calls.push({ brief: text }); return { file: join(r.root, "brief.txt") }; },
    async harness(argv, cwd) { calls.push({ harness: argv }); return harness(cwd); },
    async removeBrief() {},
  };
  return { r, job, io, calls, logs };
}

test("a merge-main build merges main into the workspace and leaves the conflicts for the harness, whose brief lists them", async (t) => {
  let seen;
  const { r, job, io, calls } = fixture(t, {
    conflict: true,
    harness: (cwd) => {
      // What the harness finds: the merge in progress, the markers in place.
      seen = { merging: existsSync(join(cwd, ".git", "MERGE_HEAD")), text: readFileSync(join(cwd, "a.txt"), "utf8"), conflicts: run(cwd, CONFLICTS_ARGS).output };
      writeFileSync(join(cwd, "a.txt"), "ONE (plan, main)\ntwo\nthree\n");
      git(cwd, "add", "a.txt");
      git(cwd, "commit", "-q", "--no-edit");
      return { code: 0 };
    },
  });
  const before = git(r.workspace, "rev-parse", "HEAD");
  const state = await runTask(job, config, "home:studio", io);
  assert.equal(state.phase, "submitted", JSON.stringify(state));
  // Main is read through the plan item's base token, after the claim and the reset.
  const order = calls.map((c) => c.argv?.[0] ?? Object.keys(c)[0]);
  assert.deepEqual(order.slice(0, 4), ["claim", "reset", "base-token", "fetch"]);
  assert.deepEqual(calls.find((c) => c.argv?.[0] === "base-token").argv, ["base-token", "t1", "--project", "atelier", "--as", ACTOR]);
  assert.deepEqual(calls.find((c) => c.fetch).fetch, [r.baseline, "read-token", r.main]);
  assert.equal(seen.merging, true);
  assert.match(seen.text, /^<<<<<<< HEAD\nONE \(plan\)\n=======\nONE \(main\)\n>>>>>>> /);
  assert.equal(seen.conflicts, "a.txt");
  // Nothing reset the workspace between the merge and the harness.
  assert.ok(order.indexOf("harness") > order.indexOf("mergeMain") && !order.slice(order.indexOf("mergeMain")).includes("reset"));
  // The brief is the server's, with the conflicting files after it.
  const brief = calls.find((c) => c.brief).brief;
  assert.ok(brief.startsWith("SERVER BRIEF\n\n## Conflicts in this workspace\n"), brief);
  assert.ok(brief.includes("left conflicts in this file:\n```\na.txt\n```"), brief);
  // The harness committed the merge unedited: main is a parent, and the message ends with the Agent line.
  const head = git(r.workspace, "rev-parse", "HEAD");
  assert.deepEqual(git(r.workspace, "rev-list", "--parents", "-n", "1", head).split(" ").slice(1), [before, r.main]);
  assert.match(git(r.workspace, "log", "-1", "--format=%B"), new RegExp(`^Merge main at ${r.main.slice(0, 8)} into the plan's branch\\n\\nAgent: ${ACTOR}`));
  assert.ok(calls.some((c) => c.argv?.[0] === "finish"));
});

test("a clean merge of main is committed by the runner and finished with no harness", async (t) => {
  const { r, job, io, calls, logs } = fixture(t, { conflict: false, harness: () => assert.fail("no harness runs for a clean merge") });
  const before = git(r.workspace, "rev-parse", "HEAD");
  const state = await runTask(job, config, "home:studio", io);
  assert.equal(state.phase, "submitted", JSON.stringify(state));
  const head = git(r.workspace, "rev-parse", "HEAD");
  assert.equal(state.head, head);
  assert.deepEqual(git(r.workspace, "rev-list", "--parents", "-n", "1", head).split(" ").slice(1), [before, r.main]);
  assert.match(git(r.workspace, "log", "-1", "--format=%B"), new RegExp(`Agent: ${ACTOR}$`));
  assert.ok(!calls.some((c) => c.harness || c.brief));
  assert.deepEqual(calls.filter((c) => c.argv).map((c) => c.argv[0]), ["claim", "base-token", "finish"]);
  assert.ok(logs.some((l) => l.includes("merged cleanly as")));
});

test("a workspace that already holds main runs the harness on what came back, and a malformed dispatch is skipped before any claim", async (t) => {
  const { r, job, io, calls } = fixture(t, { conflict: false, harness: (cwd) => { commit(cwd, "c.txt", "fix\n", "fix"); return { code: 0 }; } });
  git(r.workspace, "fetch", "-q", r.baseline, r.main);
  git(r.workspace, "merge", "-q", "--no-ff", "-m", "earlier", r.main);
  const state = await runTask(job, config, "home:studio", io);
  assert.equal(state.phase, "submitted");
  assert.ok(calls.find((c) => c.brief).brief.endsWith("The workspace already holds main at " + r.main.slice(0, 8) + "; no merge was left in progress.\n"));
  for (const change of [{ head: "not-a-hash" }, { head: undefined }]) {
    const bad = { ...job, item: { ...job.item, dispatch: { ...job.item.dispatch, ...change } } };
    const { io: io2, calls: calls2 } = fixture(t, { conflict: false, harness: () => assert.fail("no harness") });
    const skipped = await runTask(bad, config, "home:studio", io2);
    assert.equal(skipped.skipped, true);
    assert.equal(calls2.length, 0);
  }
  const noPlan = { ...job, item: { ...job.item, plan: undefined } };
  assert.equal((await runTask(noPlan, config, "home:studio", fixture(t, { conflict: false, harness: () => ({ code: 0 }) }).io)).skipped, true);
});

test("the conflicts section fences file names so none can close it", () => {
  assert.equal(conflictsSection({ state: "conflicts", mainHead: "1".repeat(40), files: ["a.txt", "b```c"] }),
    "## Conflicts in this workspace\n\nThe merge of main at 11111111 is in progress and left conflicts in these 2 files:\n````\na.txt\nb```c\n````");
});

// A task sent back after a conflicted landing (t243): the job runs on the
// task's own fork, main is read through the task's own base token (the
// baseline), and the brief is the local one with the job's instructions and
// the conflicting files after it.
test("a merge-main task build reads main through its own base token, and its brief carries the job's instructions", async (t) => {
  let seen;
  const { r, job, io, calls, logs } = fixture(t, {
    kind: "task",
    conflict: true,
    rescueReset: true,
    harness: (cwd) => {
      seen = { merging: existsSync(join(cwd, ".git", "MERGE_HEAD")), text: readFileSync(join(cwd, "a.txt"), "utf8"), conflicts: run(cwd, CONFLICTS_ARGS).output };
      writeFileSync(join(cwd, "a.txt"), "ONE (task, main)\ntwo\nthree\n");
      git(cwd, "add", "a.txt");
      git(cwd, "commit", "-q", "--no-edit");
      return { code: 0 };
    },
  });
  // The landing stopped here: its merge of main is in the workspace with the
  // conflicts unresolved, as atelier land leaves them.
  git(r.workspace, "fetch", "-q", r.baseline, r.main);
  run(r.workspace, ["git", "merge", "--no-ff", "-m", "Merge main into t9", r.main]);
  assert.ok(existsSync(join(r.workspace, ".git", "MERGE_HEAD")));
  const before = git(r.workspace, "rev-parse", "HEAD");
  const state = await runTask(job, config, "home:studio", io);
  assert.equal(state.phase, "submitted", JSON.stringify(state));
  // The reset saved the conflicted merge's files under a rescue ref and
  // cleared the merge, so the job's own merge is what the harness finds.
  assert.ok(logs.some((l) => l.startsWith("uncommitted work saved as refs/atelier/rescue/")), logs.join("\n"));
  assert.ok(git(r.workspace, "for-each-ref", "--format=%(refname)", "refs/atelier/rescue/").startsWith("refs/atelier/rescue/"));
  // Main is read through the task's own base token, whose base is the baseline.
  assert.deepEqual(calls.find((c) => c.argv?.[0] === "base-token").argv, ["base-token", "t9", "--project", "atelier", "--as", ACTOR]);
  assert.deepEqual(calls.find((c) => c.fetch).fetch, [r.baseline, "read-token", r.main]);
  assert.equal(seen.merging, true);
  assert.match(seen.text, /^<<<<<<< HEAD\nONE \(plan\)\n=======\nONE \(main\)\n>>>>>>> /);
  assert.equal(seen.conflicts, "a.txt");
  // The brief keeps the local rules and adds the job's instructions, the
  // findings of any rejecting review, and the conflicting files.
  const brief = calls.find((c) => c.brief).brief;
  assert.ok(brief.startsWith("Rules:\nStay in scope."), brief);
  assert.ok(brief.includes("## Resolve the merge of main\n\nMain at " + r.main.slice(0, 8) + " conflicts with this task's work."), brief);
  assert.ok(brief.includes("keeping both sides' behaviour"), brief);
  assert.ok(brief.includes("## Conflicts in this workspace\n"), brief);
  assert.ok(brief.includes("left conflicts in this file:\n```\na.txt\n```"), brief);
  // The harness committed the merge unedited: main is a parent, and the
  // message names the task, not a plan's branch, and ends with the Agent line.
  const head = git(r.workspace, "rev-parse", "HEAD");
  assert.deepEqual(git(r.workspace, "rev-list", "--parents", "-n", "1", head).split(" ").slice(1), [before, r.main]);
  assert.match(git(r.workspace, "log", "-1", "--format=%B"), new RegExp(`^Merge main at ${r.main.slice(0, 8)} into t9\\n\\nAgent: ${ACTOR}`));
  assert.ok(calls.some((c) => c.argv?.[0] === "finish"));
});

test("a merge-main task's brief carries a rejecting review's findings beside the job's instructions", async (t) => {
  const { job, io, calls } = fixture(t, {
    kind: "task", conflict: true, findings: "## Rework: the review's findings\n\ncodex rejected it.",
    harness: (cwd) => { writeFileSync(join(cwd, "a.txt"), "ONE (task, main)\ntwo\nthree\n"); git(cwd, "add", "a.txt"); git(cwd, "commit", "-q", "--no-edit"); return { code: 0 }; },
  });
  const state = await runTask(job, config, "home:studio", io);
  assert.equal(state.phase, "submitted", JSON.stringify(state));
  const brief = calls.find((c) => c.brief).brief;
  assert.ok(brief.includes("## Rework: the review's findings"), brief);
  assert.ok(brief.indexOf("## Rework: the review's findings") < brief.indexOf("## Resolve the merge of main"), brief);
  assert.ok(brief.includes("## Conflicts in this workspace"), brief);
});

test("a merge-main task whose workspace already holds main runs the harness on what came back", async (t) => {
  const { r, job, io, calls } = fixture(t, {
    kind: "task", conflict: false,
    harness: (cwd) => { commit(cwd, "c.txt", "fix\n", "fix"); return { code: 0 }; },
  });
  git(r.workspace, "fetch", "-q", r.baseline, r.main);
  git(r.workspace, "merge", "-q", "--no-ff", "-m", "earlier", r.main);
  const state = await runTask(job, config, "home:studio", io);
  assert.equal(state.phase, "submitted");
  const brief = calls.find((c) => c.brief).brief;
  assert.ok(brief.endsWith("The workspace already holds main at " + r.main.slice(0, 8) + "; no merge was left in progress.\n"));
  assert.ok(brief.includes("## Resolve the merge of main"), brief);
});

test("a merge-main task dispatch with a malformed head is skipped before any claim, and a part still needs its plan", async (t) => {
  // A task whose dispatch names no full hash is skipped, claiming nothing.
  const one = fixture(t, { kind: "task", conflict: false, harness: () => assert.fail("no harness") });
  const skipped = await runTask({ ...one.job, item: { ...one.job.item, dispatch: { ...one.job.item.dispatch, head: "not-a-hash" } } }, config, "home:studio", one.io);
  assert.equal(skipped.skipped, true);
  assert.equal(one.calls.length, 0);
  // A part without its plan item cannot read main; a task needs no plan.
  const two = fixture(t, { kind: "part", conflict: false, harness: () => ({ code: 0 }) });
  const partless = await runTask({ ...two.job, item: { ...two.job.item, plan: undefined } }, config, "home:studio", two.io);
  assert.equal(partless.skipped, true);
  assert.equal(two.calls.length, 0);
});

test("the merge-main section for a task states the job beside the rules", () => {
  const text = mergeMainSection({ state: "conflicts", mainHead: "1".repeat(40), files: ["a.txt"] });
  assert.ok(text.startsWith("## Resolve the merge of main\n\nMain at 11111111 conflicts with this task's work."));
  assert.ok(text.includes("- Resolve each conflict keeping both sides' behaviour"));
  assert.ok(text.includes("- Commit the merge with git commit, keeping the merge message as it stands"));
});
