// Atelier 2.0, task 6 (design section 4.7): a landing pushes its merge with a
// landing grant, minted only to the holder of the project's landing lease for
// a task accepted at H, bound to { project, task, accepted: H }, five minutes,
// one use; the hook holds that push to rule 4 and scans it with the task's
// clearances; and the landing's record of the merge, like record-merge,
// takes only a merge the project's branch holds with H among its parents.
// Every test runs the real Node server, its bare repository and the real
// pre-receive hook (test/land-node-shared.mjs), with `atelier land` and
// `atelier merge` as child processes. Every credential here is a dummy.
import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { criteriaOf } from "../src/criteria.ts";
import { hashToken } from "../src/git/grants.mjs";
import { BUILDER, OWNER, REVIEWER, eventsOf, landingWorld } from "./land-node-shared.mjs";

// Every grant the Git host let in while `during` ran, by kind, and the
// pushes among them (src/git/host.mjs, authorize and guardPush).
async function grantsUsed(w, during) {
  const used = [], pushes = [];
  const { authorize, guardPush } = w.server.git;
  w.server.git.authorize = async (...a) => { const g = await authorize.apply(w.server.git, a); if (g) used.push(g); return g; };
  w.server.git.guardPush = async (g, signal) => { pushes.push(g); return guardPush.call(w.server.git, g, signal); };
  try { return { result: await during(), used, pushes }; }
  finally { Object.assign(w.server.git, { authorize, guardPush }); }
}

// The status info/refs answers a token with, before Git reads a byte.
const refsStatus = async (w, token) => (await fetch(`${w.base}/git/demo.git/info/refs?service=git-receive-pack`, { headers: { authorization: `Basic ${Buffer.from(`x:${token}`).toString("base64")}` } })).status;

const accept = async (w, id) => {
  const r = await w.api("POST", `/projects/demo/items/${id}/accept`, { head: (await w.detail(id)).item.head });
  assert.equal(r.status, 200, r.text);
};
const mintLanding = (w, item, head, token, actor) => w.api("POST", "/projects/demo/git-token", { kind: "landing", item, head }, token, actor);

// A scratch clone holding the project's branch and a task's head, where a
// test makes the merge commits it pushes.
async function scratch(w, name, head) {
  const dir = join(w.root, name);
  assert.equal((await w.netGit(w.root, "clone", "-q", w.remote(OWNER), dir)).status, 0);
  assert.equal((await w.netGit(dir, "fetch", "-q", "origin", head)).status, 0);
  const commit = (message, ...parents) => w.git(dir, "commit-tree", w.git(dir, "rev-parse", `${parents[0]}^{tree}`), "-m", message, ...parents.flatMap((p) => ["-p", p]));
  const push = (token, refspec) => w.netGit(dir, "push", "--porcelain", w.remote(token), refspec);
  return { dir, commit, push };
}

test("atelier land pushes the merge and the notes with a landing grant, never the server token, and the grant is spent once the merge is recorded", async (t) => {
  const w = await landingWorld(t);
  const { id, head } = await w.task({ files: { "task.txt": "task\n" } });
  await w.moveMain({ "other.txt": "unrelated\n" });
  const { result: r, used, pushes } = await grantsUsed(w, () => w.cli(["land", id]));
  assert.equal(r.status, 0, r.output);
  const d = await w.detail(id);
  assert.equal(d.item.state, "merged");
  const merge = await w.tip();
  assert.deepEqual(w.parents(merge)[1], head);
  assert.doesNotMatch(r.output, /Provenance notes were not published/);
  // Every Git request of the landing came with a grant the server minted:
  // reads with read grants, the merge's push and the notes' push with a
  // landing grant for the task at H. The server token was never a Git credential.
  assert.deepEqual(used.filter((g) => g.kind === "owner"), [], "the server token was used for Git");
  assert.deepEqual(pushes.map((g) => [g.kind, g.task, g.accepted]), [["landing", id, head], ["landing", id, head]]);
  // One use: the record of the merge revoked it.
  const spent = pushes[0].id;
  assert.equal(w.server.git.grants.findById(spent), null);
  assert.ok(eventsOf(d, "item.merged").some((e) => e.data.mergeCommit === merge));
});

test("a merge by hand takes the landing lease for its grant and lets it go", async (t) => {
  const w = await landingWorld(t);
  const { id, head } = await w.task({ files: { "task.txt": "task\n" } });
  await accept(w, id);
  const { result: r, used, pushes } = await grantsUsed(w, () => w.cli(["merge", id]));
  assert.equal(r.status, 0, r.output);
  assert.equal((await w.detail(id)).item.state, "merged");
  assert.deepEqual(used.filter((g) => g.kind === "owner"), []);
  assert.deepEqual(pushes.map((g) => [g.kind, g.accepted]), [["landing", head], ["landing", head]]);
  assert.equal((await w.api("GET", "/projects/demo/landing-lease")).json.lease, null, "the lease the merge took is free again");
});

test("a landing grant goes only to the lease holder, for an accepted task, at its accepted head; an expired, used or overtaken grant gets 401", async (t) => {
  const w = await landingWorld(t);
  const { id, head } = await w.task({ files: { "task.txt": "task\n" } });
  const { id: other } = await w.task({ files: { "other.txt": "other\n" } });
  const refused = (r, status, code) => {
    assert.equal(r.status, status, r.text);
    assert.equal(r.json.error, code);
    assert.ok(r.json.next, `${code} names a next`);
  };
  // No lease, and a lease held for another task.
  refused(await mintLanding(w, id, head), 409, "no_lease");
  assert.equal((await w.api("POST", "/projects/demo/landing-lease", { item: other })).status, 200);
  refused(await mintLanding(w, id, head), 409, "no_lease");
  assert.equal((await w.api("POST", "/projects/demo/landing-lease", { cancel: true, item: other })).status, 200);
  // Held for the task, which is submitted and not yet accepted.
  assert.equal((await w.api("POST", "/projects/demo/landing-lease", { item: id })).status, 200);
  refused(await mintLanding(w, id, head), 409, "not_accepted");
  await accept(w, id);
  // At a head other than the accepted one.
  refused(await mintLanding(w, id, "f".repeat(40)), 409, "acceptance_changed");
  // An agent's token, whose actor holds no lease.
  const agent = (await w.api("POST", "/tokens", { actor: BUILDER, projects: ["demo"] })).json.token;
  refused(await mintLanding(w, id, head, agent, BUILDER), 403, "not_project_owner");
  // The holder gets one, for five minutes, bound to the task and H.
  const g = await mintLanding(w, id, head);
  assert.equal(g.status, 200, g.text);
  assert.deepEqual([g.json.kind, g.json.branch, g.json.accepted], ["landing", "main", head]);
  const left = Date.parse(g.json.expiresAt) - Date.now();
  assert.ok(left > 4.5 * 60e3 && left <= 5 * 60e3, `lives five minutes, not ${left} ms`);
  const row = w.server.git.grants.db.prepare("SELECT * FROM grants WHERE hash = ?").get(hashToken(g.json.token));
  assert.deepEqual([row.kind, row.task, row.accepted, row.actor], ["landing", id, head, "owner"]);
  assert.equal(await refsStatus(w, g.json.token), 200);
  // Expired.
  w.server.git.grants.db.prepare("UPDATE grants SET expires_at = ? WHERE hash = ?").run(Date.now() - 1, hashToken(g.json.token));
  assert.equal(await refsStatus(w, g.json.token), 401);
  // Overtaken: the lease released, the grant writes no more.
  const second = (await mintLanding(w, id, head)).json.token;
  assert.equal(await refsStatus(w, second), 200);
  assert.equal((await w.api("POST", "/projects/demo/landing-lease", { cancel: true, item: id })).status, 200);
  assert.equal(await refsStatus(w, second), 401);
  // Used: a grant whose landing's merge is recorded is revoked.
  assert.equal((await w.api("POST", "/projects/demo/landing-lease", { item: id })).status, 200);
  const third = (await mintLanding(w, id, head)).json.token;
  const s = await scratch(w, "used", head);
  const main = await w.tip();
  const merge = s.commit(`Merge ${id}`, main, head);
  const pushed = await s.push(third, `${merge}:refs/heads/main`);
  assert.equal(pushed.status, 0, pushed.stderr);
  assert.equal((await w.api("POST", `/projects/demo/items/${id}/landing`, { head })).status, 200);
  const recorded = await w.api("POST", `/projects/demo/items/${id}/merged`, { mergeCommit: merge });
  assert.equal(recorded.status, 200, recorded.text);
  assert.equal(await refsStatus(w, third), 401);
});

test("with a landing grant, the hook refuses a push of the project's branch whose parents lack H or whose first parent is not the tip", async (t) => {
  const w = await landingWorld(t);
  const { id, head, branch } = await w.task({ files: { "task.txt": "task\n" } });
  const { head: unreviewed } = await w.task({ files: { "other.txt": "not this task\n" }, approve: false });
  await accept(w, id);
  assert.equal((await w.api("POST", "/projects/demo/landing-lease", { item: id })).status, 200);
  const token = (await mintLanding(w, id, head)).json.token;
  const s = await scratch(w, "shapes", head);
  assert.equal((await w.netGit(s.dir, "fetch", "-q", "origin", unreviewed)).status, 0);
  const main = await w.tip();
  const no = (r, text) => { assert.notEqual(r.status, 0, r.stdout); assert.match(r.stderr, text); };
  no(await s.push(token, `${s.commit("merges another head", main, unreviewed)}:refs/heads/main`), /merges the accepted head [0-9a-f]{12}, which this commit's parents do not include/);
  no(await s.push(token, `${s.commit("H first", head, main)}:refs/heads/main`), /first parent is main's tip/);
  no(await s.push(token, `${s.commit("not a merge", main)}:refs/heads/main`), /parents do not include/);
  no(await s.push(token, `${s.commit("merge", main, head)}:${branch}`), /this credential writes main and refs\/notes\/atelier only/);
  assert.equal(await w.tip(), main, "main did not move");
  const merge = s.commit(`Merge ${id}`, main, head);
  const ok = await s.push(token, `${merge}:refs/heads/main`);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(await w.tip(), merge);
});

test("the landing push is scanned with the task's clearances: a line the owner cleared on the task lands in the merged history", async (t) => {
  const w = await landingWorld(t);
  const KEY = ["sk", "proj", "TESTONLY", "e".repeat(28)].join("-");
  const r = await w.api("POST", "/projects/demo/items", { title: "carries a cleared key-shaped line" });
  const id = (r.json.item ?? r.json).id;
  const agent = (await w.api("POST", "/tokens", { actor: BUILDER, projects: ["demo"] })).json.token;
  assert.equal((await w.cli(["claim", id, "--as", BUILDER], { token: agent, cwd: w.root })).status, 0);
  const work = join(w.root, "cache", "work", "demo", id);
  writeFileSync(join(work, "fixture.env"), `OPENAI_API_KEY=${KEY}\n`);
  w.git(work, "add", ".");
  w.git(work, "commit", "-q", "-m", "a fixture with a key-shaped line");
  const head = w.git(work, "rev-parse", "HEAD");
  // The hook refuses the task's push, and the owner clears the line on the task.
  const first = await w.cli(["push", id, "--as", BUILDER], { token: agent, cwd: work });
  assert.notEqual(first.status, 0, first.output);
  assert.match(first.output, /key-shaped line: fixture\.env:1/);
  await w.L().clearSecret(id, "owner", "a test fixture, not a key");
  const again = await w.cli(["push", id, "--as", BUILDER], { token: agent, cwd: work });
  assert.equal(again.status, 0, again.output);
  assert.equal((await w.L().item(id)).head, head);
  for (const claim of (await w.L().project()).policy.checks) await w.L().addEvidence({ itemId: id, claim, grade: "observed", head, passed: true, by: BUILDER, at: new Date().toISOString(), changedPaths: ["fixture.env"] });
  await w.L().submit(id, BUILDER);
  await w.L().addReview({ itemId: id, by: REVIEWER, head, approve: true, criteria: criteriaOf(await w.L().item(id)), note: "Fine", at: new Date().toISOString() }, undefined, true);
  // The control: the same merge pushed with a credential that names no
  // task (the server token) is refused for that line.
  const s = await scratch(w, "control", head);
  const main = await w.tip();
  const control = await s.push(OWNER, `${s.commit("merge without the task", main, head)}:refs/heads/main`);
  assert.notEqual(control.status, 0, control.stdout);
  assert.match(control.stderr, /key-shaped line: fixture\.env:1/);
  // The landing's grant carries the task, so its clearance applies.
  const landed = await w.cli(["land", id]);
  assert.equal(landed.status, 0, landed.output);
  assert.equal((await w.detail(id)).item.state, "merged");
  const merge = await w.tip();
  assert.deepEqual(w.parents(merge), [main, head]);
  assert.match(w.git(join(w.reposDir ?? join(w.root, "data", "repos"), "demo.git"), "show", `${merge}:fixture.env`), /^OPENAI_API_KEY=/);
});

test("the landing's record and record-merge refuse a merge the project's branch does not hold, or one whose parents lack H", async (t) => {
  const w = await landingWorld(t);
  const { id, head } = await w.task({ files: { "task.txt": "task\n" } });
  const { head: unreviewed } = await w.task({ files: { "other.txt": "not this task\n" }, approve: false });
  await accept(w, id);
  const s = await scratch(w, "records", head);
  assert.equal((await w.netGit(s.dir, "fetch", "-q", "origin", unreviewed)).status, 0);
  const main = await w.tip();
  // A merge of H the repository holds on a developer branch only.
  const aside = s.commit(`Merge ${id} aside`, main, head);
  assert.equal((await s.push(OWNER, `${aside}:refs/heads/dev/aside`)).status, 0);
  // A merge on main whose parents lack H, put there by the owner.
  const wrong = s.commit("merge of another head", main, unreviewed);
  assert.equal((await s.push(OWNER, `${wrong}:refs/heads/main`)).status, 0);
  const refused = (r, code, text) => {
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.error, code);
    assert.match(r.json.detail, text);
    assert.ok(r.json.next, `${code} names a next`);
  };
  // record-merge, the record of a merge made outside a landing.
  const record = (mergeCommit) => w.api("POST", `/projects/demo/items/${id}/record-merge`, { mergeCommit, head, reviews: [{ by: REVIEWER, verdict: "approve", head }] });
  refused(await record(aside), "merge_not_on_main", /main does not hold/);
  refused(await record("e".repeat(40)), "merge_not_on_main", /the baseline has no commit/);
  refused(await record(wrong), "second_parent_differs", /second parent is/);
  // The landing's own record.
  assert.equal((await w.api("POST", "/projects/demo/landing-lease", { item: id })).status, 200);
  assert.equal((await w.api("POST", `/projects/demo/items/${id}/landing`, { head })).status, 200);
  const merged = (mergeCommit) => w.api("POST", `/projects/demo/items/${id}/merged`, { mergeCommit });
  refused(await merged(aside), "merge_not_on_main", /the project's branch does not hold/);
  refused(await merged(wrong), "not_a_merge", /parents do not include/);
  assert.equal((await w.detail(id)).item.state, "accepted", "nothing was recorded");
  // A merge of H on the branch, now the tip's ancestor, is recorded.
  const good = s.commit(`Merge ${id}`, wrong, head);
  assert.equal((await s.push(OWNER, `${good}:refs/heads/main`)).status, 0);
  await w.moveMain({ "later.txt": "later\n" });
  const ok = await merged(good);
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await w.detail(id)).item.state, "merged");
});

test("the landing Workflow is gone: atelier land --workflow is refused before anything is asked, and the server has no landing-workflow route", async (t) => {
  const w = await landingWorld(t);
  const { id } = await w.task({ files: { "task.txt": "task\n" } });
  const before = await w.detail(id);
  const r = await w.cli(["land", id, "--workflow"]);
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /land does not take --workflow/);
  const after = await w.detail(id);
  assert.equal(after.events.length, before.events.length, "nothing was recorded");
  assert.equal((await w.api("GET", "/projects/demo/landing-lease")).json.lease, null);
  for (const method of ["GET", "POST"]) assert.equal((await w.api(method, `/projects/demo/items/${id}/landing-workflow`, method === "POST" ? {} : undefined)).status, 404);
});
