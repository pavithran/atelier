import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { guardLanding, revertOnMain } from "../cli/post-merge.mjs";
import { failureKey, newRevertState } from "../src/post-merge.ts";
import { revertNotificationRequest } from "../src/notify.ts";

const RED = "not ok 3 - widget renders\n  duration_ms: 12.5\n  error: expected 1 got 2";
const merge = "c".repeat(40), revertSha = "d".repeat(40);

// A harness whose every effect is recorded, with each result overridable.
function harness(over = {}) {
  const calls = [];
  const state = over.state ?? newRevertState();
  const io = {
    state, topic: "pavi-topic", origin: "https://atelier.test",
    suite: async () => ({ passed: false, output: RED }),
    gate: async () => ({ passed: true, output: "" }),
    revert: async (members, commit) => { calls.push(["revert", members, commit]); return revertSha; },
    check: async (sha) => { calls.push(["check", sha]); return { passed: true, output: "" }; },
    land: async (sha) => { calls.push(["land", sha]); },
    reopen: async (id, output) => { calls.push(["reopen", id, output]); },
    notify: async (request) => { calls.push(["notify", request]); },
    wake: async (reason) => { calls.push(["wake", reason]); },
    ...over,
  };
  const run = () => guardLanding({ project: "p", members: ["t7"], head: merge, io });
  return { calls, io, run, state };
}
const names = (calls) => calls.map((c) => c[0]);

test("red suite on a landed head lands a revert with no session command (criterion 1)", async () => {
  const h = harness();
  const result = await h.run();
  assert.equal(result.action, "reverted");
  assert.deepEqual(h.calls.filter((c) => c[0] !== "notify" && c[0] !== "reopen"), [["revert", ["t7"], merge], ["check", revertSha], ["land", revertSha]]);
  assert.ok(names(h.calls).indexOf("check") < names(h.calls).indexOf("land"), "the revert is checked before it lands");
});

test("the reverted task reopens with the failing output attached (criterion 2)", async () => {
  const h = harness();
  await h.run();
  const reopen = h.calls.find((c) => c[0] === "reopen");
  assert.equal(reopen[1], "t7");
  assert.match(reopen[2], /not ok 3 - widget renders/);
  assert.match(reopen[2], /expected 1 got 2/);
});

test("one notification per revert to the owner's topic; none for a repeat of the same failure (criterion 3)", async () => {
  const h = harness();
  await h.run();
  const sent = h.calls.filter((c) => c[0] === "notify");
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1].url, "https://ntfy.sh/pavi-topic");
  assert.match(await sent[0][1].text(), /t7/);
  // The same failure, with a different timing, on the same landed head again.
  const again = harness({ state: h.state, suite: async () => ({ passed: false, output: RED.replace("12.5", "99.1") }) });
  const second = await again.run();
  assert.equal(second.action, "repeat");
  assert.deepEqual(again.calls, []);
});

test("a revert that fails its checks stops all reverting and wakes a session (criterion 4)", async () => {
  const h = harness({ check: async () => ({ passed: false, output: "revert is red" }) });
  const result = await h.run();
  assert.equal(result.action, "halted");
  assert.deepEqual(names(h.calls), ["revert", "wake"]);
  assert.match(h.calls[1][1], /revert is red/);
  // A later, different failure reverts nothing while halted, and wakes again.
  const later = harness({ state: h.state, suite: async () => ({ passed: false, output: "not ok 1 - other" }) });
  const second = await later.run();
  assert.equal(second.action, "halted");
  assert.deepEqual(names(later.calls), ["wake"]);
});

test("a flaky failure that passes on re-run is not reverted (criterion 5)", async () => {
  let n = 0;
  const h = harness({ suite: async () => (n++ === 0 ? { passed: false, output: RED } : { passed: true, output: "" }) });
  const result = await h.run();
  assert.equal(result.action, "flaky");
  assert.deepEqual(h.calls, []);
});

test("a red release gate with a green suite is reverted the same way (criterion 6)", async () => {
  const h = harness({ suite: async () => ({ passed: true, output: "" }), gate: async () => ({ passed: false, output: "gate: verify:visual failed" }) });
  const result = await h.run();
  assert.equal(result.action, "reverted");
  assert.equal(result.kind, "gate");
  assert.deepEqual(names(h.calls), ["revert", "check", "land", "reopen", "notify"]);
  assert.match(h.calls.find((c) => c[0] === "reopen")[2], /verify:visual failed/);
  const green = harness({ suite: async () => ({ passed: true, output: "" }) });
  assert.equal((await green.run()).action, "green");
  assert.deepEqual(green.calls, []);
});

test("a crash before reopen leaves reopened and notified unset, and a retry finishes without a second revert", async () => {
  const h = harness({ reopen: async () => { throw new Error("server down"); } });
  await assert.rejects(h.run(), /server down/);
  const entry = Object.values(h.state.failures)[0];
  assert.equal(entry.landed, revertSha);
  assert.equal(entry.reopened, undefined);
  assert.equal(entry.notified, undefined);
  assert.equal(h.calls.some((c) => c[0] === "notify"), false);
  const retry = harness({ state: h.state });
  assert.equal((await retry.run()).action, "reverted");
  assert.deepEqual(names(retry.calls), ["reopen", "notify"]);
});

test("a crash before landing leaves nothing recorded", async () => {
  const h = harness({ land: async () => { throw new Error("push refused"); } });
  await assert.rejects(h.run(), /push refused/);
  assert.equal(Object.values(h.state.failures)[0].landed, undefined);
});

test("failureKey ignores timings and ANSI colour but not the failing test", () => {
  assert.equal(failureKey("suite", RED), failureKey("suite", "\u001b[31m" + RED.replace("12.5", "7") + "\u001b[0m"));
  assert.notEqual(failureKey("suite", RED), failureKey("suite", "not ok 4 - other"));
  assert.notEqual(failureKey("suite", RED), failureKey("gate", RED));
});

test("the revert notification names the task, kind and revert commit and opens the task page", async () => {
  const r = revertNotificationRequest("pavi-topic", "https://atelier.test/x", "p", { itemId: "t7", kind: "gate", mergeCommit: merge, revertCommit: revertSha });
  assert.equal(r.url, "https://ntfy.sh/pavi-topic");
  assert.equal(r.headers.get("Click"), "https://atelier.test/p/p/t7");
  assert.equal(r.headers.get("Tags"), "rewind");
  const body = await r.text();
  assert.match(body, /t7/);
  assert.match(body, /release gate/);
  assert.ok(body.includes(revertSha.slice(0, 12)));
});

test("revertOnMain makes a first-parent revert commit on a real repository", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-auto-revert-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (args, options = {}) => {
    const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=T", "-c", "user.email=t@example.test", ...args], { cwd: dir, encoding: "utf8" });
    if (options.allowFail) return r;
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git(["init", "-b", "main"]);
  writeFileSync(join(dir, "f"), "before\n"); git(["add", "."]); git(["commit", "-m", "base"]);
  git(["checkout", "-b", "feat"]); writeFileSync(join(dir, "f"), "after\n"); git(["commit", "-am", "feat"]);
  git(["checkout", "main"]); git(["merge", "--no-ff", "feat", "-m", "merge t7"]);
  const mergeSha = git(["rev-parse", "HEAD"]);
  const sha = revertOnMain({ git, merge: mergeSha, ids: ["t7"], actor: "atelier/auto-revert" });
  assert.equal(git(["rev-parse", "HEAD"]), sha);
  assert.equal(readFileSync(join(dir, "f"), "utf8"), "before\n");
  assert.match(git(["log", "-1", "--format=%B"]), /Revert t7[\s\S]*Agent: atelier\/auto-revert$/);
});
