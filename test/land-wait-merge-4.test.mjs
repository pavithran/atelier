// Part 4 of 4 of the tests that were in land-wait-merge.test.mjs, split so no file runs for more than about a minute (t771).
import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, landFixture, raiseRouteLevel } from "./land-fixture.mjs";

test("where only the task raised the route level, the merge keeps the task's number", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { seedRouteLevel: 6, mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  raiseRouteLevel(f.workspace("t1"), 7, "Task raises the route level");
  const r = await f.workspaceMerge();
  assert.equal(r.status, 0, r.output);
  assert.doesNotMatch(r.output, /raised the route level/);
  assert.match(readFileSync(join(f.workspace("t1"), "src", "route-level.ts"), "utf8"), /ROUTE_LEVEL = 7;/);
  assert.equal(f.posts("/land").find((x) => x.body.step === "merge").body.routeLevel, undefined);
  assert.equal(f.forkHead("t1"), git(f.workspace("t1"), "rev-parse", "HEAD"));
});


test("a rerun of a conflicted merge resolved by hand still compares and raises the route level", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { seedRouteLevel: 6 });
  // Both sides raise, to different numbers, so the merge stops on the
  // conflict and is left for the owner to resolve.
  raiseRouteLevel(f.workspace("t1"), 8, "Task raises the route level");
  raiseRouteLevel(f.checkout, 9, "Main raises the route level");
  const stopped = await f.workspaceMerge();
  assert.equal(stopped.status, 1, stopped.output);
  assert.match(stopped.output, /stops on conflicts; nothing was regenerated\.\nSource conflicts to resolve:\n  src\/route-level\.ts\n/);
  assert.match(stopped.output, /The merge is left in the workspace for you to resolve/);
  // The owner resolves it by hand, writing main's number — one side's
  // alone, as a hand resolution does — and reruns the landing, which now
  // finds main already merged and would else skip the comparison.
  writeFileSync(join(f.workspace("t1"), "src", "route-level.ts"), "export const ROUTE_LEVEL = 9;\n");
  git(f.workspace("t1"), "add", ".");
  git(f.workspace("t1"), "commit", "-m", "Resolve the merge by hand");
  git(f.workspace("t1"), "push", "-q", "origin", "HEAD");
  f.box.requests.length = 0;
  const r = await f.workspaceMerge();
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /main at [0-9a-f]{8} is already merged into t1's workspace\./);
  assert.match(r.output, /main and t1 each raised the route level from 6 \(main to 9, t1 to 8\), and the merge left it at 9: the merged CLI calls both sides' routes, so the level is raised to 11\. Deploy the server from a checkout at route level 11 or newer/);
  // The raise is its own commit above the hand-resolved merge, measured
  // from the task's head before that merge, and it is what lands.
  assert.match(git(f.workspace("t1"), "log", "--format=%s"), /Raise the route level after merging main into t1/);
  assert.match(readFileSync(join(f.workspace("t1"), "src", "route-level.ts"), "utf8"), /ROUTE_LEVEL = 11;/);
  assert.equal(f.forkHead("t1"), git(f.workspace("t1"), "rev-parse", "HEAD"));
  // The merge step records the skipped merge beside the levels it compared and set.
  const merge = f.posts("/land").find((x) => x.body.step === "merge");
  assert.equal(merge.body.skipped, true);
  assert.deepEqual(merge.body.routeLevel, { base: 6, main: 9, task: 8, was: 9, set: 11 });
});


test("a merge that brought main in through a side branch still compares and raises the route level", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { seedRouteLevel: 6 });
  // Both sides raise 6 to 7, so every merge below is clean at 7.
  raiseRouteLevel(f.workspace("t1"), 7, "Task raises the route level");
  raiseRouteLevel(f.checkout, 7, "Main raises the route level");
  // Main reaches the task's head through a side branch: main merged into
  // the side branch, the side branch into the task's line. The merge that
  // brought main in is no merge of HEAD's first-parent line at all, so a
  // --first-parent rev-list finds nothing and the comparison would be
  // skipped exactly where both sides raised the level.
  const w = f.workspace("t1");
  git(w, "checkout", "-q", "-b", "side");
  git(w, "fetch", "-q", f.baseline, "main");
  git(w, "merge", "-q", "--no-ff", "-m", "Merge main into the side branch", "FETCH_HEAD");
  git(w, "checkout", "-q", "t/1");
  git(w, "merge", "-q", "--no-ff", "-m", "Merge the side branch into the task", "side");
  git(w, "push", "-q", "origin", "HEAD");
  // The premise of the regression: this topology leaves the --first-parent
  // rev-list empty, so the merge that brought main in must be found another way.
  const mainHead = git(f.checkout, "rev-parse", "HEAD");
  assert.equal(git(w, "rev-list", "--first-parent", "--ancestry-path", `${mainHead}..HEAD`), "");
  const r = await f.workspaceMerge();
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /main at [0-9a-f]{8} is already merged into t1's workspace\./);
  assert.match(r.output, /main and t1 each raised the route level from 6 \(main to 7, t1 to 7\), and the merge left it at 7: the merged CLI calls both sides' routes, so the level is raised to 8\. Deploy the server from a checkout at route level 8 or newer/);
  // The raise is its own commit above the side branch's merge, measured
  // from the task's head before that merge, and it is what lands.
  const subjects = git(w, "log", "--format=%s").split("\n");
  assert.ok(subjects.includes("Merge the side branch into the task"));
  assert.equal(subjects.filter((s) => /^Raise the route level/.test(s)).length, 1);
  assert.match(readFileSync(join(w, "src", "route-level.ts"), "utf8"), /ROUTE_LEVEL = 8;/);
  assert.equal(f.forkHead("t1"), git(w, "rev-parse", "HEAD"));
  // The merge step records the skipped merge beside the levels it compared and set.
  const merge = f.posts("/land").find((x) => x.body.step === "merge");
  assert.equal(merge.body.skipped, true);
  assert.deepEqual(merge.body.routeLevel, { base: 6, main: 7, task: 7, was: 7, set: 8 });
});


test("a repo with no route-level file skips the comparison and the merge goes on", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  const r = await f.workspaceMerge();
  assert.equal(r.status, 0, r.output);
  assert.doesNotMatch(r.output, /route level/);
  assert.ok(!existsSync(join(f.workspace("t1"), "src", "route-level.ts")));
  assert.equal(f.posts("/land").find((x) => x.body.step === "merge").body.routeLevel, undefined);
  assert.equal(f.forkHead("t1"), git(f.workspace("t1"), "rev-parse", "HEAD"));
});


test("--dry-run prints the steps and the refusals without changing anything", async (t) => {
  const f = await landFixture(t, { mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  const before = { workspace: git(f.workspace("t1"), "rev-parse", "HEAD"), fork: f.forkHead("t1"), baseline: git(f.p, "--git-dir", f.baseline, "rev-parse", "main"), checkout: git(f.checkout, "rev-parse", "HEAD") };
  f.box.requests.length = 0;
  const r = await f.run(f.checkout, "land", "t1", "--dry-run");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /Dry run: atelier land t1 in proj would land t1 at [0-9a-f]{8}, the head recorded for it, pushing nothing to its branch:/);
  assert.match(r.output, /merge [0-9a-f]{8} into main in .* through the merge pipeline; a conflict stops here with the files named \(failed step merge-main\), nothing pushed and the approval standing/);
  assert.match(r.output, /regenerate with `echo generated > gen-fixtures\.txt` on the merged tree, folding what changes into the merge commit, then run the required checks \(exit 0\) once on the merged tree/);
  assert.match(r.output, /push the merge commit to main alone; if main moved since the merge, the push is refused and the merge and checks are made again on the new main, twice at most/);
  assert.match(r.output, /Nothing was changed\./);
  // Reads only: the lease is read, never taken, and nothing that changes
  // state was posted; the POSTs are the read tokens the preview reads with.
  assert.ok(f.box.requests.some((x) => x.method === "GET" && x.path.endsWith("/landing-lease")));
  assert.deepEqual([...new Set(f.box.requests.filter((x) => x.method === "POST").map((x) => x.path))].sort(), ["/api/projects/proj/git-token"]);
  assert.match(r.output, /Preview: [0-9a-f]{8} merges cleanly into main at [0-9a-f]{8}\./);
  assert.equal(f.box.lease, null);
  assert.equal(git(f.workspace("t1"), "rev-parse", "HEAD"), before.workspace);
  assert.equal(f.forkHead("t1"), before.fork);
  assert.equal(git(f.p, "--git-dir", f.baseline, "rev-parse", "main"), before.baseline);
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), before.checkout);
  // The order (t550, G2): the review without the lease, then the lease for
  // the merge, its checks and the push.
  assert.match(r.output, /Without the landing lease \(t550\), beside any other task's landing:/);
  assert.match(r.output, /2\. ask the server for the independent review the gate needs at [0-9a-f]{8} and record a land request, without waiting for the verdict/);
  assert.match(r.output, /3\. take the project's landing lease for t1 \(one merge at a time in proj/);
  assert.match(r.output, /4\. accept t1 at [0-9a-f]{8}/);
  // A held lease no longer refuses the dry run: it says where the merge would wait.
  f.box.lease = { item: "t2", holder: "owner", at: "2026-10-06T09:30:00.000Z", renewedAt: new Date().toISOString() };
  const held = await f.run(f.checkout, "land", "t1", "--dry-run");
  assert.equal(held.status, 0, held.output); assert.match(held.output, /3\. wait behind owner's landing of t2 \(since 2026-10-06 09:30 UTC\) \(as the lease stands now\), then take/);
});


test("a server at the CLI's route level passes whatever commit it runs", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  f.box.version = "f".repeat(40);
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.equal(f.box.states.t1, "merged");
  assert.ok(f.posts("/landing-lease").some((x) => x.body.cancel === true));
});


test("a server a route level lower than the CLI's refuses, naming both levels and saying to deploy", async (t) => {
  const f = await landFixture(t);
  f.box.routeLevel = 13;
  const before = git(f.workspace("t1"), "rev-parse", "HEAD");
  f.box.requests.length = 0;
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /lacks capabilities projects\.commit-identity\.v1, items\.brief-criteria\.v1/);
  assert.match(r.output, /route level 13/);
  assert.match(r.output, /Deploy the server/);
  assert.deepEqual(f.box.requests.filter((x) => x.method === "POST"), []);
  assert.equal(git(f.workspace("t1"), "rev-parse", "HEAD"), before);
  assert.equal(f.box.lease, null);
});


// The queued ask is the route whose meaning changed (t249), so --wait is
// where an older server would bite: a level 9 server, which lacks the
// queue, would read `{ item, queued: true }` as a take and refuse it, so
// the wait would crash on the 409 instead of waiting. The start refusal
// above must reach --wait too, before any queued ask is made of it.
test("a server a route level lower than the CLI's refuses --wait at start, saying to deploy, before any queued ask", async (t) => {
  const f = await landFixture(t);
  f.box.routeLevel = 13;
  f.box.lease = { item: "t2", holder: "owner", at: "2026-10-07T09:00:00.000Z", renewedAt: new Date().toISOString() };
  f.box.waiting = [{ item: "t3", holder: "owner", at: "2026-10-07T09:14:00.000Z", renewedAt: new Date().toISOString() }];
  f.box.requests.length = 0;
  const r = await f.run(f.checkout, "land", "t1", "--wait");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /lacks capabilities projects\.commit-identity\.v1, items\.brief-criteria\.v1/);
  assert.match(r.output, /Deploy the server/);
  // Nothing was asked of the lease — no queued ask, no take — and the lease
  // and the queue stand exactly as they were.
  assert.deepEqual(f.box.requests.filter((x) => x.method === "POST"), []);
  assert.equal(f.box.lease?.item, "t2");
  assert.deepEqual(f.box.waiting.map((w) => w.item), ["t3"]);
});


test("a server that reports no route level refuses, saying to deploy", async (t) => {
  const f = await landFixture(t);
  f.box.routeLevel = null;
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /neither capabilities nor a route level/);
  assert.match(r.output, /Deploy the server/);
  assert.deepEqual(f.box.requests.filter((x) => x.method === "POST"), []);
  assert.equal(f.box.lease, null);
});
