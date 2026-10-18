// Part 3 of 4 of the tests that were in land-wait-merge.test.mjs, split so no file runs for more than about a minute (t771).
import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, landFixture, raiseRouteLevel, declareGenerated, sameMergeStep } from "./land-fixture.mjs";

// Finding (t344 round 2): the legacy settlement staged only the conflicts, so
// a file the command also wrote stayed dirty and tripped the regenerate step's
// refusal of a dirty workspace.
test("the legacy settlement commits every file the regenerate command wrote, not only the conflicts (t344)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { mainChange: { file: "gen-fixtures.txt", text: "from main\n", message: "Main regenerates the fixture" } });
  f.box.regen = "echo generated > gen-fixtures.txt; echo extra > extra-gen.txt";
  writeFileSync(join(f.workspace("t1"), "gen-fixtures.txt"), "from task\n");
  git(f.workspace("t1"), "add", "."); git(f.workspace("t1"), "commit", "-m", "Task regenerates the fixture"); git(f.workspace("t1"), "push", "-q", "origin", "main");
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.equal(git(f.workspace("t1"), "status", "--porcelain"), "");
  assert.equal(git(f.workspace("t1"), "ls-files", "extra-gen.txt"), "extra-gen.txt");
});


// Finding (t344 round 3): another agent's file that appears after the
// preflight, before the legacy settlement runs the command, was staged with
// the command's output and committed.
test("the legacy settlement refuses a file that became dirty before the command ran, naming it, and commits nothing of it (t344)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { mainChange: { file: "gen-fixtures.txt", text: "from main\n", message: "Main regenerates the fixture" } });
  writeFileSync(join(f.workspace("t1"), "gen-fixtures.txt"), "from task\n");
  git(f.workspace("t1"), "add", "."); git(f.workspace("t1"), "commit", "-m", "Task regenerates the fixture"); git(f.workspace("t1"), "push", "-q", "origin", "main");
  // The second token request comes after the preflight's clean-tree check and before the merge.
  let tokens = 0;
  f.box.holdOn = (url) => { if (url.endsWith("/base-token") && ++tokens === 2) { writeFileSync(join(f.workspace("t1"), "video.md"), "half-finished\n"); } return false; };
  const r = await f.run(f.checkout, "land", "t1");
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /since the landing began \(video\.md\)/);
  assert.equal(git(f.workspace("t1"), "log", "--all", "--format=", "--name-only", "-S", "half-finished"), "");
  assert.notEqual(f.box.states.t1, "merged");
});


test("a conflict that also touches a file the regenerate command does not rewrite still stops, naming what regeneration left", async (t) => {
  const f = await landFixture(t, { mainChange: { file: "work.txt", text: "from main\n", message: "Main edits work" } });
  // Both sides also regenerate the fixture, so one conflict is generated and one is not.
  writeFileSync(join(f.checkout, "gen-fixtures.txt"), "from main\n");
  git(f.checkout, "add", "."); git(f.checkout, "commit", "-m", "Main regenerates the fixture"); git(f.checkout, "push", "-q", "origin", "main");
  writeFileSync(join(f.workspace("t1"), "gen-fixtures.txt"), "from task\n");
  git(f.workspace("t1"), "add", "."); git(f.workspace("t1"), "commit", "-m", "Task regenerates the fixture"); git(f.workspace("t1"), "push", "-q", "origin", "main");
  const before = { fork: f.forkHead("t1"), baseline: git(f.p, "--git-dir", f.baseline, "rev-parse", "main") };
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /stops on conflicts; nothing was regenerated\.\nSource conflicts to resolve:\n  gen-fixtures\.txt\n  work\.txt\nTaking either side and regenerating did not settle them: /);
  assert.match(r.output, /the regenerate command left work\.txt as either side had it/);
  // The conflicted merge is back in the workspace, markers and all; nothing moved on.
  assert.ok(existsSync(join(f.workspace("t1"), ".git", "MERGE_HEAD")));
  assert.match(readFileSync(join(f.workspace("t1"), "work.txt"), "utf8"), /^<{7} /m);
  assert.equal(f.forkHead("t1"), before.fork);
  assert.equal(git(f.p, "--git-dir", f.baseline, "rev-parse", "main"), before.baseline);
  assert.equal(f.box.states.t1, "submitted");
  assert.deepEqual(f.posts("/push"), []); assert.deepEqual(f.posts("/merged"), []);
  const merge = f.posts("/land").find((x) => x.body.step === "merge");
  assert.equal(merge.body.failed, true);
  assert.deepEqual(merge.body.conflicts, ["gen-fixtures.txt", "work.txt"]);
  assert.equal(merge.body.resolvedBy, "the developer, by hand");
  assert.equal(merge.body.reason, "the regenerate command left work.txt as either side had it");
});


test("a regenerate command that fails while settling conflicts stops the landing with the failure named", async (t) => {
  const f = await landFixture(t, { mainChange: { file: "gen-fixtures.txt", text: "from main\n", message: "Main regenerates the fixture" } });
  writeFileSync(join(f.workspace("t1"), "gen-fixtures.txt"), "from task\n");
  git(f.workspace("t1"), "add", "."); git(f.workspace("t1"), "commit", "-m", "Task regenerates the fixture"); git(f.workspace("t1"), "push", "-q", "origin", "main");
  f.box.regen = "echo boom >&2; exit 3";
  const before = f.forkHead("t1");
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /Taking either side and regenerating did not settle them: the regenerate command `echo boom >&2; exit 3` failed \(exit 3\)/);
  assert.match(r.output, /boom/);
  // The merge is left in the workspace, still conflicted, and nothing landed.
  assert.ok(existsSync(join(f.workspace("t1"), ".git", "MERGE_HEAD")));
  assert.equal(f.forkHead("t1"), before);
  assert.equal(f.box.states.t1, "submitted");
  const merge = f.posts("/land").find((x) => x.body.step === "merge");
  assert.equal(merge.body.failed, true);
  assert.deepEqual(merge.body.conflicts, ["gen-fixtures.txt"]);
  assert.equal(merge.body.reason, "the regenerate command `echo boom >&2; exit 3` failed (exit 3)");
});


test("a conflict only in a declared generated output is regenerated by its generator once the sources merge, and the landing goes on", async (t) => {
  const f = await landFixture(t);
  declareGenerated(f.checkout, "main");
  declareGenerated(f.workspace("t1"), "task");
  // The policy's own regenerate command would overwrite the output; it is off here.
  f.box.regen = null;
  const before = { checkout: git(f.checkout, "rev-parse", "HEAD") };
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /Regenerating gen-fixtures\.txt with sh -c cat in\/\*\.txt > gen-fixtures\.txt \(fixtures\)…/);
  assert.match(r.output, /Regenerated gen-fixtures\.txt \(matches neither side\) with sh -c .*; its log is .*merge-logs/);
  // The workspace's merge holds the regenerated output and its provenance.
  const ws = f.workspace("t1");
  assert.equal(readFileSync(join(ws, "gen-fixtures.txt"), "utf8"), "main\ntask\n");
  assert.match(git(ws, "log", "-1", "--format=%B"), /^Merge main into t1\n\nAtelier land: main at [0-9a-f]+\n\nAtelier-Regenerated: fixtures \(sh -c cat in\/\*\.txt > gen-fixtures\.txt\): gen-fixtures\.txt matches neither side; log sha256 [0-9a-f]{64}$/m);
  // The pushed head carries it, so the checks and the review are of the regenerated output.
  assert.equal(f.forkHead("t1"), git(ws, "rev-parse", "HEAD"));
  assert.equal(git(f.checkout, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")[1], before.checkout);
  assert.equal(f.box.states.t1, "merged");
  const events = f.posts("/land");
  assert.deepEqual(events.map((x) => x.body.step), ["merge", "push", "check", "submit", "review", "lease", "accept", "merged", "release"]);
  const merge = events.find((x) => x.body.step === "merge");
  assert.deepEqual(merge.body.conflicts, ["gen-fixtures.txt"]);
  assert.equal(merge.body.resolvedBy, "atelier land, through the merge pipeline");
  assert.equal(merge.body.regenerated[0].name, "fixtures");
  assert.match(merge.body.regenerated[0].logSha, /^[0-9a-f]{64}$/);
  assert.equal(merge.body.failed, undefined);
  sameMergeStep("regenerated", merge.body);
});


test("a source conflict beside a generated one stops the landing before anything is generated, telling the two apart", async (t) => {
  const f = await landFixture(t);
  declareGenerated(f.checkout, "main", { also: { "work.txt": "from main\n" } });
  declareGenerated(f.workspace("t1"), "task");
  const before = { fork: f.forkHead("t1"), baseline: git(f.p, "--git-dir", f.baseline, "rev-parse", "main") };
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /stops on conflicts; nothing was regenerated\.\nSource conflicts to resolve:\n  work\.txt\nRegenerable outputs, not to be edited by hand \(regenerate them once the sources merge\):\n  gen-fixtures\.txt \(sh -c cat in\/\*\.txt > gen-fixtures\.txt\)\n/);
  // The merge is left in the workspace: the source with its markers, the
  // output unmerged with no markers and not regenerated.
  const ws = f.workspace("t1");
  assert.ok(existsSync(join(ws, ".git", "MERGE_HEAD")));
  assert.match(readFileSync(join(ws, "work.txt"), "utf8"), /^<{7} /m);
  assert.equal(readFileSync(join(ws, "gen-fixtures.txt"), "utf8"), "task\n");
  assert.deepEqual(git(ws, "diff", "--name-only", "--diff-filter=U").split("\n"), ["gen-fixtures.txt", "work.txt"]);
  assert.equal(f.forkHead("t1"), before.fork);
  assert.equal(git(f.p, "--git-dir", f.baseline, "rev-parse", "main"), before.baseline);
  assert.deepEqual(f.posts("/push"), []); assert.deepEqual(f.posts("/merged"), []);
  const merge = f.posts("/land").find((x) => x.body.step === "merge");
  assert.equal(merge.body.failed, true);
  assert.deepEqual([merge.body.source, merge.body.generated], [["work.txt"], ["gen-fixtures.txt"]]);
  assert.equal(merge.body.resolvedBy, "the developer, by hand");
  assert.match(merge.body.mainHead, /^[0-9a-f]{40}$/);
  sameMergeStep("stopped", merge.body);
});


test("--dry-run previews the merge of main, telling source conflicts from regenerable outputs, and changes nothing", async (t) => {
  const f = await landFixture(t);
  declareGenerated(f.checkout, "main", { also: { "work.txt": "from main\n" } });
  declareGenerated(f.workspace("t1"), "task");
  const ws = f.workspace("t1"), head = git(ws, "rev-parse", "HEAD");
  const r = await f.run(f.checkout, "land", "t1", "--dry-run");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /\n {5}Preview: main at [0-9a-f]{8} would stop the merge, generating nothing\.\n {5}Source conflicts to resolve:\n {5}  work\.txt\n {5}Regenerable outputs, not to be edited by hand \(regenerate them once the sources merge\):\n {5}  gen-fixtures\.txt\n/);
  assert.equal(git(ws, "rev-parse", "HEAD"), head);
  assert.equal(existsSync(join(ws, ".git", "MERGE_HEAD")), false);
  assert.equal(git(ws, "status", "--porcelain"), "");

  // With the source conflict gone, the preview says the merge is clean and names the generator it runs.
  const g = await landFixture(t);
  declareGenerated(g.checkout, "main");
  declareGenerated(g.workspace("t1"), "task");
  const clean = await g.run(g.checkout, "land", "t1", "--dry-run");
  assert.match(clean.output, /\n {5}Preview: main at [0-9a-f]{8} merges cleanly\.\n {5}Regenerable outputs[^\n]*\n {5}  gen-fixtures\.txt\n {5}It would regenerate with fixtures\.\n/);
});


test("a declared generator that fails stops the landing with the merge aborted and the failure named", async (t) => {
  const f = await landFixture(t);
  const command = ["sh", "-c", "echo boom >&2; exit 3"];
  declareGenerated(f.checkout, "main", { command });
  declareGenerated(f.workspace("t1"), "task", { command });
  const before = { fork: f.forkHead("t1"), head: git(f.workspace("t1"), "rev-parse", "HEAD") };
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /stopped: the generator fixtures \(sh -c echo boom >&2; exit 3\) failed on run 1 \(exit 3\); its log is (\S+merge-logs\S+\.log)\nNothing was merged; the merge was aborted/);
  const log = /its log is (\S+\.log)/.exec(r.output)[1];
  assert.match(readFileSync(log, "utf8"), /--- run 1: exit 3\nboom/);
  assert.equal(existsSync(join(f.workspace("t1"), ".git", "MERGE_HEAD")), false);
  assert.equal(git(f.workspace("t1"), "rev-parse", "HEAD"), before.head);
  assert.equal(f.forkHead("t1"), before.fork);
  assert.equal(f.box.states.t1, "submitted");
  const merge = f.posts("/land").find((x) => x.body.step === "merge");
  assert.equal(merge.body.failed, true);
  assert.match(merge.body.reason, /^the generator fixtures .* failed on run 1 \(exit 3\)/);
});


test("where main and the task each raised the route level from one base, the landing raises the merged level past both", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { seedRouteLevel: 6 });
  // Both sides raise 6 to 7, so the merge is clean at the number they share.
  raiseRouteLevel(f.workspace("t1"), 7, "Task raises the route level");
  raiseRouteLevel(f.checkout, 7, "Main raises the route level");
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /main and t1 each raised the route level from 6 \(main to 7, t1 to 7\), and the merge left it at 7: the merged CLI calls both sides' routes, so the level is raised to 8\. Deploy the server from a checkout at route level 8 or newer/);
  // The raise is its own commit in the workspace, and it is what lands.
  assert.match(git(f.workspace("t1"), "log", "--format=%s"), /Raise the route level after merging main into t1/);
  assert.match(readFileSync(join(f.workspace("t1"), "src", "route-level.ts"), "utf8"), /ROUTE_LEVEL = 8;/);
  assert.match(readFileSync(join(f.checkout, "src", "route-level.ts"), "utf8"), /ROUTE_LEVEL = 8;/);
  assert.match(git(f.p, "--git-dir", f.baseline, "show", "main:src/route-level.ts"), /ROUTE_LEVEL = 8;/);
  assert.equal(f.box.states.t1, "merged");
  // The merge step records the levels it compared and the one it set.
  const merge = f.posts("/land").find((x) => x.body.step === "merge");
  assert.deepEqual(merge.body.routeLevel, { base: 6, main: 7, task: 7, was: 7, set: 8 });
  sameMergeStep("routeLevel", merge.body);
});


// Since t522 the route level is frozen and a new capability declares no level
// (t584). 2026-10-12: t396's merge-main job failed twice on this comparison
// with no level added by either side, and stranded its claim.
const named = (f, levels) => {
  for (const dir of [f.workspace("t1"), f.checkout]) {
    writeFileSync(join(dir, "src", "route-level.ts"), 'export const CAPABILITIES = buildCapabilities(CAPABILITY_DECLARATIONS);\nexport const ROUTE_LEVEL = 7;\n');
    if (levels && dir === f.workspace("t1")) writeFileSync(join(dir, "src", "capability-declarations.ts"), 'export const CAPABILITY_DECLARATIONS = [\n  { name: "items.task.v1", level: 7, summary: "x" },\n];\n');
    git(dir, "add", "."); git(dir, "commit", "-m", "Raise with a named declaration"); git(dir, "push", "-q", "origin", "main");
  }
};


test("named legacy mappings with a level a side added stop automatic renumbering until the builder resolves them", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { seedRouteLevel: 6 });
  named(f, true);
  const r = await f.run(f.checkout, "land", "t1");
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /named capability legacy mappings need manual resolution/);
  assert.match(r.output, /Move the task's new capability declaration levels above main's 7, set ROUTE_LEVEL to 8/);
  assert.match(readFileSync(join(f.workspace("t1"), "src", "route-level.ts"), "utf8"), /ROUTE_LEVEL = 7;/);
  assert.notEqual(f.box.states.t1, "merged");
  assert.doesNotMatch(git(f.workspace("t1"), "log", "--format=%s"), /Raise the route level after merging/);
});


test("named capabilities declared without levels are no failure where both sides raised the route level (t584)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { seedRouteLevel: 6 });
  named(f, false);
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.doesNotMatch(r.output, /manual resolution/);
  assert.match(r.output, /neither added a capability declaration with a level, so the merged level 7 stands/);
  assert.match(readFileSync(join(f.workspace("t1"), "src", "route-level.ts"), "utf8"), /ROUTE_LEVEL = 7;/);
  assert.doesNotMatch(git(f.workspace("t1"), "log", "--format=%s"), /Raise the route level after merging/);
  assert.equal(f.box.states.t1, "merged");
});


test("where only main raised the route level, the merge takes main's number and nothing is raised past it", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { seedRouteLevel: 6 });
  raiseRouteLevel(f.checkout, 7, "Main raises the route level");
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.doesNotMatch(r.output, /raised the route level/);
  assert.match(readFileSync(join(f.workspace("t1"), "src", "route-level.ts"), "utf8"), /ROUTE_LEVEL = 7;/);
  assert.match(git(f.p, "--git-dir", f.baseline, "show", "main:src/route-level.ts"), /ROUTE_LEVEL = 7;/);
  assert.doesNotMatch(git(f.workspace("t1"), "log", "--format=%s"), /Raise the route level/);
  assert.equal(f.posts("/land").find((x) => x.body.step === "merge").body.routeLevel, undefined);
  assert.equal(f.box.states.t1, "merged");
});
