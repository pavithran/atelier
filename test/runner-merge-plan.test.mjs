import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFLICTS_ARGS, mergeMainArgs, runTask } from "../cli/runner.mjs";
import { ROLE_PROMPTS } from "../src/usage.ts";

// A part sent back because its integration conflicted with the plan's
// branch (docs/orchestrator.md, section 5): its dispatch names the branch's
// head (planHead), and after the claim and the workspace's reset the runner
// fetches it through the part's own base token, which reads the plan's
// fork, and merges it, leaving conflicts in place for the harness, whose
// brief lists them; a clean merge is committed and finished with no harness,
// and a workspace that already holds the head is reworked as usual. A
// merge-main part sent back the same way merges main and then the plan's
// branch. Git runs for real, in temporary repositories standing in for the
// plan's fork and main, with a clone of the fork for the workspace; the CLI
// and the server stand in through io, as in the other runner tests.

const entry = { agent: "codex", models: ["gpt-6-astra"], command: ["codex", "exec", "--sandbox", "danger-full-access", "{brief_file}", "{workspace}"] };
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

// The plan's fork with a shared file, and main beside it; the part's
// workspace forks from the plan's fork and changes the file, and another
// part lands on the plan's fork after, in the same line when `conflict`,
// else apart.
function repos(t, conflict) {
  const root = mkdtempSync(join(tmpdir(), "atelier-merge-plan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fork = join(root, "plan-fork"), main = join(root, "main"), workspace = join(root, "t9");
  git(root, "init", "-q", "-b", "main", fork);
  commit(fork, "a.txt", "one\ntwo\nthree\n", "base");
  git(root, "clone", "-q", fork, main);
  git(root, "clone", "-q", fork, workspace);
  const partHead = commit(workspace, "a.txt", "ONE (part)\ntwo\nthree\n", "the part's change");
  const planHead = commit(fork, conflict ? "a.txt" : "b.txt", conflict ? "ONE (other part)\ntwo\nthree\n" : "the other part's file\n", "the other part, integrated");
  return { root, fork, main, workspace, partHead, planHead };
}

function fixture(t, { conflict, harness, dispatch = {}, setup }) {
  const r = repos(t, conflict);
  setup?.(r);
  const calls = [], logs = [];
  const job = {
    project: "atelier", agent: "codex", model: "gpt-6-astra", actor: ACTOR,
    item: { id: "t9", kind: "part", plan: "t1", partKey: "b", title: "Part b", scope: ["a.txt"], dispatch: { to: "home", agent: "codex", model: "gpt-6-astra", by: "atelier/orchestrator", at: "", note: "", planHead: r.planHead, ...(typeof dispatch === "function" ? dispatch(r) : dispatch) } },
  };
  const io = {
    log: (s) => logs.push(s), stopped: () => false, env: {}, ownerTokens: () => [],
    workspacePath: () => r.workspace,
    async cli(argv) {
      calls.push({ argv });
      // A part's base token reads the plan's fork; the plan item's reads main.
      if (argv[0] === "base-token") return JSON.stringify({ remote: argv[1] === "t9" ? r.fork : r.main, token: `read-${argv[1]}`, defaultBranch: "main" });
      return "";
    },
    async head(cwd, { ref = "HEAD" } = {}) { return git(cwd, "rev-parse", ref); },
    async reset(cwd) { calls.push({ reset: true }); git(cwd, "reset", "-q", "--hard", "HEAD"); git(cwd, "clean", "-ffdq"); },
    async fetch(cwd, remote, token, head) { calls.push({ fetch: [remote, token, head] }); git(cwd, "fetch", "-q", remote, head); },
    async mergeMain(cwd, head, message) { calls.push({ mergeMain: [head, message] }); return run(cwd, mergeMainArgs(head, message)); },
    async conflicts(cwd) { return run(cwd, CONFLICTS_ARGS).output.split("\n").filter(Boolean); },
    async jobBrief() { calls.push({ jobBrief: true }); return { job: "rework", text: "SERVER BRIEF", hash: "h" }; },
    async brief(workspace, text) { calls.push({ brief: text }); return { file: join(r.root, "brief.txt") }; },
    async harness(argv, cwd) { calls.push({ harness: argv }); return harness(cwd); },
    async removeBrief() {},
  };
  return { r, job, io, calls, logs };
}

test("a part sent back after a conflict merges the plan's branch into the workspace and leaves the conflicts for the harness, whose brief lists them", async (t) => {
  let seen;
  const { r, job, io, calls, logs } = fixture(t, {
    conflict: true,
    harness: (cwd) => {
      // What the harness finds: the merge in progress, the markers in place.
      seen = { merging: existsSync(join(cwd, ".git", "MERGE_HEAD")), text: readFileSync(join(cwd, "a.txt"), "utf8"), conflicts: run(cwd, CONFLICTS_ARGS).output };
      writeFileSync(join(cwd, "a.txt"), "ONE (part, other part)\ntwo\nthree\n");
      git(cwd, "add", "a.txt");
      git(cwd, "commit", "-q", "--no-edit");
      return { code: 0 };
    },
  });
  const state = await runTask(job, config, "home:studio", io);
  assert.equal(state.phase, "submitted", JSON.stringify(state));
  // The plan's branch is read through the part's own base token, after the claim and the reset.
  const order = calls.map((c) => c.argv?.[0] ?? Object.keys(c)[0]);
  assert.deepEqual(order.slice(0, 4), ["claim", "reset", "base-token", "fetch"]);
  assert.deepEqual(calls.find((c) => c.argv?.[0] === "base-token").argv, ["base-token", "t9", "--project", "atelier", "--as", ACTOR]);
  assert.deepEqual(calls.find((c) => c.fetch).fetch, [r.fork, "read-t9", r.planHead]);
  assert.equal(seen.merging, true);
  assert.match(seen.text, /^<<<<<<< HEAD\nONE \(part\)\n=======\nONE \(other part\)\n>>>>>>> /);
  assert.equal(seen.conflicts, "a.txt");
  // Nothing reset the workspace between the merge and the harness.
  assert.ok(order.indexOf("harness") > order.indexOf("mergeMain") && !order.slice(order.indexOf("mergeMain")).includes("reset"));
  const brief = calls.find((c) => c.brief).brief;
  assert.equal(brief, `${ROLE_PROMPTS.build.trimEnd()}\n\nSERVER BRIEF\n\n## Conflicts in this workspace\n\nThe merge of the plan's branch at ${r.planHead.slice(0, 8)} is in progress and left conflicts in this file:\n\`\`\`\na.txt\n\`\`\`\n`);
  // The harness committed the merge unedited: the plan's head is a parent, and the message ends with the Agent line.
  const head = git(r.workspace, "rev-parse", "HEAD");
  assert.deepEqual(git(r.workspace, "rev-list", "--parents", "-n", "1", head).split(" ").slice(1), [r.partHead, r.planHead]);
  assert.ok(git(r.workspace, "log", "-1", "--format=%B").startsWith(`Merge the plan's branch at ${r.planHead.slice(0, 8)} into part t9\n\nAgent: ${ACTOR}`));
  assert.ok(logs.some((l) => l === `the plan's branch at ${r.planHead.slice(0, 8)} merged with conflicts in a.txt`));
  assert.ok(calls.some((c) => c.argv?.[0] === "finish"));
});

test("a clean merge of the plan's branch is committed by the runner and finished with no harness", async (t) => {
  const { r, job, io, calls, logs } = fixture(t, { conflict: false, harness: () => assert.fail("no harness runs for a clean merge") });
  const state = await runTask(job, config, "home:studio", io);
  assert.equal(state.phase, "submitted", JSON.stringify(state));
  const head = git(r.workspace, "rev-parse", "HEAD");
  assert.equal(state.head, head);
  assert.deepEqual(git(r.workspace, "rev-list", "--parents", "-n", "1", head).split(" ").slice(1), [r.partHead, r.planHead]);
  assert.match(git(r.workspace, "log", "-1", "--format=%B"), new RegExp(`Agent: ${ACTOR}$`));
  assert.ok(!calls.some((c) => c.harness || c.brief));
  assert.deepEqual(calls.filter((c) => c.argv).map((c) => c.argv[0]), ["claim", "base-token", "finish"]);
  assert.ok(logs.some((l) => l.includes("merged cleanly as")));
});

test("a workspace that already holds the plan's head is reworked by the harness, and a malformed plan head is skipped before any claim", async (t) => {
  const { r, job, io, calls } = fixture(t, {
    conflict: false,
    setup: (r) => { git(r.workspace, "fetch", "-q", r.fork, "main"); git(r.workspace, "merge", "-q", "--no-ff", "-m", "earlier", "FETCH_HEAD"); },
    harness: (cwd) => { commit(cwd, "c.txt", "fix\n", "fix"); return { code: 0 }; },
  });
  const before = git(r.workspace, "rev-parse", "HEAD");
  const state = await runTask(job, config, "home:studio", io);
  assert.equal(state.phase, "submitted");
  assert.notEqual(state.head, before);
  assert.ok(calls.find((c) => c.brief).brief.endsWith(`The workspace already holds the plan's branch at ${r.planHead.slice(0, 8)}; no merge was left in progress.\n`));
  for (const change of [{ planHead: "not-a-hash" }, { planHead: "" }]) {
    const bad = { ...job, item: { ...job.item, dispatch: { ...job.item.dispatch, ...change } } };
    const { io: io2, calls: calls2 } = fixture(t, { conflict: false, harness: () => assert.fail("no harness") });
    assert.equal((await runTask(bad, config, "home:studio", io2)).skipped, true);
    assert.equal(calls2.length, 0);
  }
  // A dispatch with no plan head merges nothing.
  const plain = { ...job, item: { ...job.item, dispatch: { ...job.item.dispatch, planHead: undefined } } };
  const { io: io3, calls: calls3 } = fixture(t, { conflict: true, harness: (cwd) => { commit(cwd, "c.txt", "fix\n", "fix"); return { code: 0 }; } });
  assert.equal((await runTask(plain, config, "home:studio", io3)).phase, "submitted");
  assert.ok(!calls3.some((c) => c.argv?.[0] === "base-token" || c.fetch || c.mergeMain));
  assert.equal(calls3.find((c) => c.brief).brief, `${ROLE_PROMPTS.build.trimEnd()}\n\nSERVER BRIEF`);
});

test("a merge-main part sent back after a conflict merges main, then the plan's branch, and lists both in its brief", async (t) => {
  let mainHead;
  const { r, job, io, calls } = fixture(t, {
    conflict: true,
    setup: (r) => {
      // Main moved apart from the plan, and the earlier attempt committed its merge.
      mainHead = commit(r.main, "m.txt", "main's file\n", "main's change");
      git(r.workspace, "fetch", "-q", r.main, mainHead);
      git(r.workspace, "merge", "-q", "--no-ff", "-m", "earlier merge of main", mainHead);
    },
    dispatch: () => ({ job: "merge-main", head: mainHead }),
    harness: (cwd) => {
      assert.ok(existsSync(join(cwd, ".git", "MERGE_HEAD")));
      writeFileSync(join(cwd, "a.txt"), "ONE (part, other part)\ntwo\nthree\n");
      git(cwd, "add", "a.txt");
      git(cwd, "commit", "-q", "--no-edit");
      return { code: 0 };
    },
  });
  const state = await runTask(job, config, "home:studio", io);
  assert.equal(state.phase, "submitted", JSON.stringify(state));
  // Main through the plan item's base token, then the plan's branch through the part's.
  assert.deepEqual(calls.filter((c) => c.argv?.[0] === "base-token").map((c) => c.argv[1]), ["t1", "t9"]);
  assert.deepEqual(calls.filter((c) => c.mergeMain).map((c) => c.mergeMain[0]), [mainHead, r.planHead]);
  const brief = calls.find((c) => c.brief).brief;
  assert.equal(brief, `${ROLE_PROMPTS.build.trimEnd()}\n\nSERVER BRIEF\n\n## Conflicts in this workspace\n\nThe workspace already holds main at ${mainHead.slice(0, 8)}; no merge was left in progress.\n\nThe merge of the plan's branch at ${r.planHead.slice(0, 8)} is in progress and left conflicts in this file:\n\`\`\`\na.txt\n\`\`\`\n`);
  const head = git(r.workspace, "rev-parse", "HEAD");
  assert.equal(git(r.workspace, "rev-list", "--parents", "-n", "1", head).split(" ")[2], r.planHead);
});

test("a merge-main part whose merge of main conflicts fetches the plan's branch but does not merge it", async (t) => {
  let mainHead;
  const { r, job, io, calls } = fixture(t, {
    conflict: false,
    setup: (r) => { mainHead = commit(r.main, "a.txt", "ONE (main)\ntwo\nthree\n", "main's change"); },
    dispatch: () => ({ job: "merge-main", head: mainHead }),
    harness: () => ({ code: 1 }),
  });
  await runTask(job, config, "home:studio", io);
  assert.deepEqual(calls.filter((c) => c.mergeMain).map((c) => c.mergeMain[0]), [mainHead]);
  assert.deepEqual(calls.filter((c) => c.fetch).map((c) => c.fetch[2]), ["refs/heads/main", r.planHead]);
  assert.ok(calls.find((c) => c.brief).brief.includes(`The plan's branch at ${r.planHead.slice(0, 8)} is fetched but not merged, since the merge of main is in progress`));
});
