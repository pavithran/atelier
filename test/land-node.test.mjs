// Atelier 2.0, lessons gap G2: a landing merges the accepted head into the
// project's branch in the registered checkout, runs the project's checks on
// the merged tree there, and pushes only the merge to the project's branch,
// so the task's branch and its approvals stay as reviewed. Each test drives
// `atelier land` against the real Node server, its bare repository and its
// pre-receive hook (test/land-node-shared.mjs).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { eventsOf, landingWorld } from "./land-node-shared.mjs";

test("a task approved at H lands after main moved, with no new review and no push to its branch", async (t) => {
  const w = await landingWorld(t);
  const { id, head, branch } = await w.task({ files: { "shared.txt": "task line 1\n" + Array.from({ length: 11 }, (_, i) => `line ${i + 2}\n`).join("") } });
  const before = await w.detail(id);
  const reviewsBefore = before.reviews.length;
  // main moves by an unrelated commit, and by one in the file the task
  // changed that still merges cleanly: the checks on the merged tree decide.
  await w.moveMain({ "other.txt": "unrelated\n" }, "unrelated");
  const moved = await w.moveMain({ "shared.txt": Array.from({ length: 11 }, (_, i) => `line ${i + 1}\n`).join("") + "main line 12\n" }, "main edits the same file");
  await w.setPolicy({ checks: ["true", "grep -q 'task line 1' shared.txt && grep -q 'main line 12' shared.txt"] });
  // The new check's evidence at H, as the builder's finish records it.
  await w.L().addEvidence({ itemId: id, claim: "grep -q 'task line 1' shared.txt && grep -q 'main line 12' shared.txt", grade: "observed", head, passed: true, by: "codex/gpt-6", at: new Date().toISOString(), changedPaths: ["shared.txt"] });
  const r = await w.cli(["land", id]);
  if (process.env.SHOW) console.log(r.output);
  assert.equal(r.status, 0, r.output);
  const d = await w.detail(id);
  assert.equal(d.item.state, "merged", r.output);
  const merge = await w.tip();
  assert.deepEqual(w.parents(merge), [moved, head], "the landing push is a merge of the accepted head onto main's tip");
  assert.equal(await w.tip(branch), head, "the task's branch stays at the reviewed head");
  // The provenance notes reached the server on a push of their own.
  assert.doesNotMatch(r.output, /Provenance notes were not published/);
  const notes = await w.tip("refs/notes/atelier");
  assert.ok(notes, "refs/notes/atelier is on the server");
  assert.match(w.git(w.checkout, "notes", "--ref=atelier", "show", merge), new RegExp(`${id}`));
  // No push recorded after the approval, and no new review asked or given.
  const approvedAt = before.reviews.at(-1).at;
  assert.deepEqual([...eventsOf(d, "push.observed"), ...eventsOf(d, "item.pushed")].filter((e) => e.at > approvedAt), []);
  assert.deepEqual(eventsOf(d, "review.requested").filter((e) => e.at > approvedAt), []);
  assert.equal(d.reviews.length, reviewsBefore);
  // The landing record and its steps: the checks ran on the merged tree.
  assert.equal(d.landing.step, "merged");
  assert.equal(d.landing.failedStep, null);
  assert.equal(d.landing.attempt, 1);
  const steps = d.events.filter((e) => e.kind.startsWith("land.")).map((e) => e.kind);
  for (const s of ["land.start", "land.lease", "land.accept", "land.merge-main", "land.checks", "land.push", "land.merged"]) assert.ok(steps.includes(s), `${s} in ${steps.join(", ")}`);
  assert.equal(eventsOf(d, "land.checks")[0].data.mergeCommit, merge);
  // In full mode the review step records the verdict it found, as before (G1, criterion 4's edge).
  assert.equal(eventsOf(d, "land.review")[0].data.verdict, "approve");
  assert.doesNotMatch(r.output, /could not be recorded/);
});

test("a conflict stops the landing before any push: the failure is merge-main with the files, and the approval stands", async (t) => {
  const w = await landingWorld(t);
  const { id, head, branch } = await w.task({ files: { "shared.txt": "task's first line\n" } });
  const moved = await w.moveMain({ "shared.txt": "main's first line\n" }, "main rewrites the same line");
  const r = await w.cli(["land", id]);
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /merge conflicts; nothing was merged/);
  assert.equal(await w.tip(), moved, "nothing was pushed to main");
  assert.equal(await w.tip(branch), head, "nothing was pushed to the task's branch");
  const d = await w.detail(id);
  assert.equal(d.landing.failedStep, "merge-main");
  assert.deepEqual(d.landing.files, ["shared.txt"]);
  assert.match(d.landing.tail, /shared\.txt/);
  // The approval at H stands; whoever resolves the conflict is not the lander's to decide.
  assert.ok(d.reviews.some((rv) => rv.head === head && rv.approve));
  assert.equal(d.item.head, head);
  assert.equal(eventsOf(d, "push.observed").length, 1, "the builder's push is the only one recorded");
  // The checkout is back where the merge began, with nothing left of it.
  assert.equal(w.git(w.checkout, "status", "--porcelain"), "");
  assert.equal(w.git(w.checkout, "rev-parse", "HEAD"), moved);
});

test("checks that fail on the merged tree push nothing and do not reject the task; the tail is the failing check's own, and a flaky pass is not counted", async (t) => {
  const w = await landingWorld(t);
  const flaky = `${w.root}/flaky`;
  // The first check prints a preamble and passes; the second fails on the
  // merged tree only (main added main-only.txt), and would pass if run again.
  const checks = ["echo build preamble one; echo build preamble two", `if [ -f main-only.txt ] && [ ! -f ${flaky} ]; then touch ${flaky}; echo FAILING CHECK LINE A; echo FAILING CHECK LINE B; exit 1; fi`];
  await w.setPolicy({ checks });
  const { id, head } = await w.task({ files: { "task.txt": "task\n" } });
  const moved = await w.moveMain({ "main-only.txt": "main\n" }, "main adds a file");
  const r = await w.cli(["land", id]);
  assert.notEqual(r.status, 0, r.output);
  assert.equal(await w.tip(), moved, "nothing was pushed to main");
  const d = await w.detail(id);
  assert.equal(d.landing.failedStep, "checks");
  assert.match(d.landing.tail, /FAILING CHECK LINE A\nFAILING CHECK LINE B/);
  assert.doesNotMatch(d.landing.tail, /preamble/);
  const failed = eventsOf(d, "land.checks").at(-1).data;
  assert.equal(failed.failedCheck, checks[1]);
  // Not rejected: still accepted at H, its approval standing, and no rejection recorded.
  assert.equal(d.item.state, "accepted");
  assert.equal(d.item.acceptedHead, head);
  assert.ok(!d.reviews.some((rv) => !rv.approve));
  assert.equal(w.git(w.checkout, "rev-parse", "HEAD"), moved, "the checkout is back where the merge began");
  assert.equal(w.git(w.checkout, "status", "--porcelain"), "");
});

// A check that moves main the first `times` times it runs, as another
// landing or a direct push would between the checks and the push.
function mover(w, times) {
  const script = `${w.root}/move.sh`, count = `${w.root}/moves`;
  const url = w.remote("atl_00112233445566778899aabbccddeeff");
  const body = `#!/bin/sh
export HOME=${w.root} GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
n=$(cat ${count} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${count}
if [ $n -le ${times} ]; then
  d=$(mktemp -d) && git clone -q ${url} $d && cd $d && echo $n > moved-$n.txt && git add . && git -c user.name=Demo -c user.email=t@example.test commit -q -m "main moves during the landing ($n)" && git push -q origin HEAD:refs/heads/main
  cd / && rm -rf $d
fi
exit 0
`;
  return { script, count, body };
}

test("main moving between the checks and the push is refused; the merge and checks are made again, and the push happens once", async (t) => {
  const w = await landingWorld(t);
  const m = mover(w, 1);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(m.script, m.body, { mode: 0o700 });
  // A test double that moves main, declared by the developer so init takes it.
  await w.setPolicy({ checks: [`sh ${m.script}`], checkClasses: [{ command: `sh ${m.script}`, by: "owner", note: "a test double that moves main" }] });
  const { id, head } = await w.task({ files: { "task.txt": "task\n" } });
  const r = await w.cli(["land", id]);
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /main moved from [0-9a-f]{8} to [0-9a-f]{8} after t\d+'s merge was checked/);
  const d = await w.detail(id);
  assert.equal(d.item.state, "merged");
  const merge = await w.tip();
  const [first, second] = w.parents(merge);
  assert.equal(second, head);
  assert.match(w.log().find((l) => l.startsWith(first)), /main moves during the landing \(1\)/, "the landing merged onto the commit that moved main");
  // One merge of the task reached main: the first, refused, never did.
  assert.equal(w.log().filter((l) => / Merge t\d+:/.test(l)).length, 1);
  const pushes = eventsOf(d, "land.push");
  assert.equal(pushes.length, 2);
  assert.equal(pushes[0].data.rounds, 1);
  assert.match(pushes[0].data.reason, /^refused: main moved/);
  assert.equal(pushes[1].data.mergeCommit, merge);
  assert.equal(eventsOf(d, "land.checks").length, 2, "the checks ran once on each merge");
  assert.equal(d.landing.step, "merged");
});

test("main that keeps moving is merged and checked at most three times, then reported as a fact with nothing pushed", async (t) => {
  const w = await landingWorld(t);
  const m = mover(w, 10);
  const { writeFileSync, readFileSync } = await import("node:fs");
  writeFileSync(m.script, m.body, { mode: 0o700 });
  // A test double that moves main, declared by the developer so init takes it.
  await w.setPolicy({ checks: [`sh ${m.script}`], checkClasses: [{ command: `sh ${m.script}`, by: "owner", note: "a test double that moves main" }] });
  const { id, head } = await w.task({ files: { "task.txt": "task\n" } });
  const r = await w.cli(["land", id]);
  assert.notEqual(r.status, 0, r.output);
  assert.equal(readFileSync(m.count, "utf8").trim(), "3", "the checks ran on three merges");
  const d = await w.detail(id);
  assert.equal(d.item.state, "accepted");
  assert.equal(d.landing.failedStep, "push");
  assert.match(d.landing.tail, /between the checks and the push, 3 times in a row/);
  assert.equal(eventsOf(d, "land.push").at(-1).data.rounds, 3);
  assert.equal(w.log().filter((l) => / Merge t\d+:/.test(l)).length, 0, "no merge of the task reached main");
  assert.ok(!w.log().some((l) => l.includes(head)), "main does not hold the task's head");
});
