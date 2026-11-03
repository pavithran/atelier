// Atelier 2.0, lessons gap G1: a landing is a fact the model can read, bound
// and withdraw. Each step of `atelier land` is recorded with its attempt on
// the task's landing record, which `show --json` carries; a failure names
// its step and the last lines of that step's own output; `land --queue
// --cancel` removes a queued landing; a failed landing is not offered to the
// lander again until the head changes or it is queued again; a blocked task
// is never landed; legacy fast mode still stops for a missing review.
// Each test drives the real Node server and its hook (test/land-node-shared.mjs).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { eventsOf, landingWorld } from "./land-node-shared.mjs";

const offer = { runner: "home:studio", jobs: ["land"], checkouts: ["demo"] };
const offered = async (w) => (await w.L().landJobs(offer, ["demo"])).map((i) => i.id);

test("a landing that cannot take the lease names the lease step, with the reason as its tail", async (t) => {
  const w = await landingWorld(t);
  const { id: other } = await w.task({ files: { "other.txt": "other\n" } });
  const { id } = await w.task({ files: { "task.txt": "task\n" } });
  // Another task's landing holds the lease and keeps it.
  assert.equal((await w.api("POST", "/projects/demo/landing-lease", { item: other })).status, 200);
  const r = await w.cli(["land", id], { env: { ATELIER_LAND_WAIT_TIMEOUT: "300" } });
  assert.notEqual(r.status, 0, r.output);
  const shown = JSON.parse((await w.cli(["show", id, "--json"])).stdout);
  assert.equal(shown.landing.failedStep, "lease");
  assert.equal(shown.landing.attempt, 1);
  assert.match(shown.landing.tail, new RegExp(`the landing lease was not free within 0 seconds: owner still holds it for ${other}`));
  assert.ok(shown.landing.at);
  assert.equal((await w.detail(id)).item.state, "submitted", "nothing was accepted or merged");
});

test("a refusal before any step is recorded as the start step, and a blocked task is never landed or offered", async (t) => {
  const w = await landingWorld(t);
  const { id } = await w.task({ files: { "task.txt": "task\n" } });
  await w.L().block(id, "owner", "waiting on the developer's word");
  const r = await w.cli(["land", id]);
  assert.notEqual(r.status, 0);
  assert.match(r.output, /is blocked \(waiting on the developer's word\), and a blocked task is never landed/);
  const d = await w.detail(id);
  assert.equal(d.landing.failedStep, "start");
  assert.match(d.landing.tail, /blocked/);
  assert.equal(await w.tip(), w.git(w.checkout, "rev-parse", "HEAD"), "main did not move");
  // Queued before the block, the job is not offered while it stands; queuing again is refused.
  const queued = await w.api("POST", `/projects/demo/items/${id}/land-job`, {});
  assert.equal(queued.status, 409);
  assert.equal(queued.json.error, "blocked");
  assert.match(queued.json.next ?? "", /atelier unblock/);
  assert.deepEqual(await offered(w), []);
});

test("a failed landing is not offered again until it is queued again or its head changes", async (t) => {
  const w = await landingWorld(t);
  const { id } = await w.task({ files: { "shared.txt": "task's line\n" } });
  await w.moveMain({ "shared.txt": "main's line\n" });
  assert.equal((await w.cli(["land", id, "--queue"])).status, 0);
  assert.deepEqual(await offered(w), [id]);
  const r = await w.cli(["land", id]);
  assert.notEqual(r.status, 0);
  assert.equal((await w.detail(id)).landing.failedStep, "merge-main");
  // Unseen by the model, the failure stops the job: the lander is not offered it, however long.
  assert.deepEqual(await offered(w), []);
  const again = await w.cli(["land", id, "--queue"]);
  assert.match(again.stdout, /queued to land again: its landing failed at the merge-main step \(attempt 1\)/);
  assert.deepEqual(await offered(w), [id]);
  // A second failure stops it again; a new head (the builder's merge of main) lets it run.
  assert.notEqual((await w.cli(["land", id])).status, 0);
  const d = await w.detail(id);
  assert.equal(d.landing.attempt, 2);
  assert.deepEqual(await offered(w), []);
  await w.L().recordPush(id, "codex/gpt-6", "c".repeat(40), "c".repeat(40), false, { holdsRecorded: true, rebasedFrom: null }, []);
  assert.equal((await w.detail(id)).item.head, "c".repeat(40));
  assert.deepEqual(await offered(w), [id]);
});

test("land --queue --cancel removes a queued landing; run twice, the second says not queued and changes nothing", async (t) => {
  const w = await landingWorld(t);
  const { id } = await w.task({ files: { "task.txt": "task\n" } });
  assert.equal((await w.cli(["land", id, "--queue"])).status, 0);
  assert.deepEqual(await offered(w), [id]);
  const first = await w.cli(["land", id, "--queue", "--cancel"]);
  assert.equal(first.status, 0, first.output);
  assert.match(first.stdout, /queued landing is cancelled/);
  assert.deepEqual(await offered(w), []);
  const events = (await w.detail(id)).events.length;
  const second = await w.cli(["land", id, "--queue", "--cancel"]);
  assert.equal(second.status, 0, second.output);
  assert.match(second.stdout, new RegExp(`${id} is not queued to land; nothing was changed`));
  assert.equal((await w.detail(id)).events.length, events, "the second cancel changed nothing");
});

// The real timing: the landing has entered its merge on the Ledger (its
// checks on the merged tree are running, held by a check that waits) when
// the developer cancels. The cancel is refused, naming the step, and the
// landing runs on and lands.
test("a cancel while the landing merges is refused, naming the step, and the landing is not interrupted", async (t) => {
  const w = await landingWorld(t);
  const { writeFileSync, existsSync } = await import("node:fs");
  const entered = `${w.root}/entered`, go = `${w.root}/go`, script = `${w.root}/wait.sh`;
  writeFileSync(script, `#!/bin/sh\ntouch ${entered}\nn=0; while [ ! -f ${go} ] && [ $n -lt 600 ]; do sleep 0.1; n=$((n+1)); done\nexit 0\n`, { mode: 0o700 });
  await w.setPolicy({ checks: [`sh ${script}`], checkClasses: [{ command: `sh ${script}`, by: "owner", note: "a test double that waits" }] });
  const { id } = await w.task({ files: { "task.txt": "task\n" } });
  assert.equal((await w.cli(["land", id, "--queue"])).status, 0);
  const main = await w.tip();
  let finished;
  const landing = w.cli(["land", id]).then((r) => (finished = r));
  for (let i = 0; i < 600 && !finished && !existsSync(entered); i++) await new Promise((ok) => setTimeout(ok, 100));
  assert.ok(existsSync(entered), `the check on the merged tree started: ${finished?.output ?? "still running"}`);
  const refused = await w.cli(["land", id, "--queue", "--cancel"]);
  assert.notEqual(refused.status, 0, refused.output);
  assert.match(refused.output, /landing_past_merge: t\d+'s landing \(attempt 1\) is at its merge-main step, past the merge, so it is not cancelled or interrupted/);
  assert.match(refused.output, /next: run atelier show t\d+ --json/);
  writeFileSync(go, "");
  const r = await landing;
  assert.equal(r.status, 0, r.output);
  assert.equal((await w.detail(id)).item.state, "merged");
  assert.notEqual(await w.tip(), main);
});

test("a landing cancelled while it waits stops before its merge, merging nothing", async (t) => {
  const w = await landingWorld(t);
  const { id: other } = await w.task({ files: { "other.txt": "other\n" } });
  const { id } = await w.task({ files: { "task.txt": "task\n" } });
  assert.equal((await w.api("POST", "/projects/demo/landing-lease", { item: other })).status, 200);
  const main = await w.tip();
  const landing = w.cli(["land", id], { env: { ATELIER_LAND_WAIT_TIMEOUT: "60000" } });
  // Once it waits for the lease, the developer cancels it and frees the lease.
  for (let i = 0; i < 200 && (await w.detail(id)).landing?.step !== "review" && (await w.detail(id)).landing?.step !== "start"; i++) await new Promise((ok) => setTimeout(ok, 50));
  await new Promise((ok) => setTimeout(ok, 300));
  assert.equal((await w.cli(["land", id, "--queue", "--cancel"])).status, 0);
  await w.api("POST", "/projects/demo/landing-lease", { cancel: true, item: other });
  const r = await landing;
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /queued landing was cancelled .* before its merge began/);
  assert.equal(await w.tip(), main);
  assert.equal((await w.detail(id)).item.state, "submitted");
});

test("legacy fast mode cannot land a protected task without review", async (t) => {
  const w = await landingWorld(t);
  await w.L().setMode("owner", "fast", "the test lands on its checks", "claude-code/opus-5.5", "land on the checks");
  const { id } = await w.task({ files: { "task.txt": "task\n" }, approve: false });
  const r = await w.cli(["land", id]);
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /reviewer_needed/);
  assert.doesNotMatch(r.output, /could not be recorded/);
  const d = await w.detail(id);
  assert.equal(d.item.state, "submitted");
  assert.equal(eventsOf(d, "item.merged").length, 0);
  assert.deepEqual(eventsOf(d, "land.review").map((e) => [e.data.failed, e.data.skipped, e.data.fast]), [[true, undefined, undefined]]);
  assert.equal(eventsOf(d, "item.accepted").length, 0);
  assert.equal(d.landing.failedStep, "review");
});

test("a failure under the lease is recorded for the current attempt unless another landing took the lease", async (t) => {
  const w = await landingWorld(t);
  const { id: other } = await w.task({ files: { "other.txt": "other\n" } });
  const { id } = await w.task({ files: { "task.txt": "task\n" } });
  const post = (body) => w.api("POST", `/projects/demo/items/${id}/land`, { ms: 0, ...body });
  for (const step of ["start", "lease"]) assert.equal((await post({ step })).status, 200);
  const attempt = (await w.detail(id)).landing.attempt;
  // Another task's landing holds the lease now: refused, nothing changed.
  assert.equal((await w.api("POST", "/projects/demo/landing-lease", { item: other })).status, 200);
  const before = (await w.detail(id)).landing;
  const taken = await post({ step: "checks", failed: true, tail: "FAIL", attempt });
  assert.equal(taken.status, 409); assert.equal(taken.json.error, "landing_lease");
  assert.deepEqual((await w.detail(id)).landing, before);
  // The lease gone with no takeover (as one that lapsed mid-step): a stale
  // attempt is refused, the current one recorded, and the fence holds.
  await w.api("POST", "/projects/demo/landing-lease", { cancel: true, item: other });
  const stale = await post({ step: "checks", failed: true, tail: "FAIL", attempt: attempt + 1 });
  assert.equal(stale.status, 409); assert.equal(stale.json.error, "stale_landing");
  assert.equal((await post({ step: "checks", failed: true, tail: "FAIL npm test", attempt })).status, 200);
  const d = await w.detail(id);
  assert.equal(d.landing.failedStep, "checks");
  assert.equal(d.landing.tail, "FAIL npm test");
});

test("a fetch that fails before the lease is recorded as the fetch step", async (t) => {
  const w = await landingWorld(t);
  const { id } = await w.task({ files: { "task.txt": "task\n" } });
  // Every Git request goes to a proxy that answers nothing; the API does not.
  const r = await w.cli(["land", id], { env: { http_proxy: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9", NO_PROXY: "", no_proxy: "" } });
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /could not be fetched, so the landing stops before anything merges/);
  const d = await w.detail(id);
  assert.equal(d.landing.failedStep, "fetch");
  assert.match(d.landing.tail, /could not be fetched/);
});

test("SIGTERM during the merged-tree checks is recorded as the step the landing was at, in its attempt", async (t) => {
  const w = await landingWorld(t);
  const { writeFileSync, existsSync } = await import("node:fs");
  const entered = `${w.root}/entered`, script = `${w.root}/wait.sh`;
  writeFileSync(script, `#!/bin/sh\ntouch ${entered}\nsleep 120\n`, { mode: 0o700 });
  await w.setPolicy({ checks: [`sh ${script}`], checkClasses: [{ command: `sh ${script}`, by: "owner", note: "a test double that waits" }] });
  const { id } = await w.task({ files: { "task.txt": "task\n" } });
  const main = await w.tip();
  const landing = w.spawnCli(["land", id]);
  for (let i = 0; i < 600 && !existsSync(entered); i++) await new Promise((ok) => setTimeout(ok, 100));
  assert.ok(existsSync(entered), "the check on the merged tree started");
  const attempt = (await w.detail(id)).landing.attempt;
  landing.child.kill("SIGTERM");
  const ended = await landing.done;
  assert.equal(ended.status, 143);
  const d = await w.detail(id);
  assert.equal(d.landing.failedStep, "merge-main");
  assert.equal(d.landing.attempt, attempt);
  assert.match(d.landing.tail, /SIGTERM ended the landing/);
  assert.equal(await w.tip(), main, "nothing was pushed");
});

test("a merge that fails after another landing started a new attempt fails nothing of the new one", async (t) => {
  const w = await landingWorld(t);
  const { writeFileSync, existsSync } = await import("node:fs");
  const entered = `${w.root}/entered`, go = `${w.root}/go`, script = `${w.root}/wait.sh`;
  writeFileSync(script, `#!/bin/sh\ntouch ${entered}\nn=0; while [ ! -f ${go} ] && [ $n -lt 600 ]; do sleep 0.1; n=$((n+1)); done\necho OLD ATTEMPT FAILS\nexit 1\n`, { mode: 0o700 });
  await w.setPolicy({ checks: [`sh ${script}`], checkClasses: [{ command: `sh ${script}`, by: "owner", note: "a test double that waits, then fails" }] });
  const { id } = await w.task({ files: { "task.txt": "task\n" } });
  const main = await w.tip();
  const landing = w.cli(["land", id]);
  for (let i = 0; i < 600 && !existsSync(entered); i++) await new Promise((ok) => setTimeout(ok, 100));
  assert.ok(existsSync(entered), "the check on the merged tree started");
  const old = (await w.detail(id)).landing.attempt;
  // Another landing of the task starts a new attempt meanwhile.
  assert.equal((await w.api("POST", `/projects/demo/items/${id}/land`, { step: "start", ms: 0 })).status, 200);
  const fresh = (await w.detail(id)).landing;
  assert.equal(fresh.attempt, old + 1);
  writeFileSync(go, "");
  const r = await landing;
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /stale_landing/);
  assert.equal(await w.tip(), main, "nothing was pushed");
  const now = (await w.detail(id)).landing;
  assert.equal(now.attempt, fresh.attempt);
  assert.equal(now.failedStep, null, "the new attempt is not failed by the old one");
  assert.equal(now.step, "start");
});

// The merge child carries the attempt atelier land named for it. Attempt B
// starting after A named its attempt and before A's child enters its merge:
// the child records nothing against B.
test("a merge child named for attempt A enters nothing and records nothing once attempt B has started", async (t) => {
  const w = await landingWorld(t);
  const { id } = await w.task({ files: { "task.txt": "task\n" } });
  assert.equal((await w.api("POST", `/projects/demo/items/${id}/accept`, { head: (await w.detail(id)).item.head })).status, 200);
  const post = (body) => w.api("POST", `/projects/demo/items/${id}/land`, { ms: 0, ...body });
  assert.equal((await post({ step: "start" })).status, 200);
  const a = (await w.detail(id)).landing.attempt;
  assert.equal((await w.api("POST", "/projects/demo/landing-lease", { item: id })).status, 200);
  assert.equal((await post({ step: "start" })).status, 200);
  const b = (await w.detail(id)).landing;
  assert.equal(b.attempt, a + 1);
  const main = await w.tip();
  const r = await w.cli(["merge", id, "--landing"], { env: { ATELIER_LAND_ATTEMPT: String(a) } });
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /stale_landing: t\d+'s landing record is at attempt \d+, not \d+/);
  assert.deepEqual((await w.detail(id)).landing, b, "attempt B is untouched");
  assert.equal(await w.tip(), main);
  // Nor is any step of A's taken against B.
  const late = await post({ step: "merge-main", attempt: a });
  assert.equal(late.status, 409); assert.equal(late.json.error, "stale_landing");
  assert.deepEqual((await w.detail(id)).landing, b);
});

// The retry: main moves between the checks and the push, and attempt B
// starts in the same moment; the child's next round keeps attempt A and is
// refused, recording nothing against B.
test("a merge child's retry after main moved keeps its own attempt, so a new attempt is never written by it", async (t) => {
  const w = await landingWorld(t);
  const { writeFileSync } = await import("node:fs");
  const script = `${w.root}/move.sh`, count = `${w.root}/moves`, url = w.remote("atl_00112233445566778899aabbccddeeff");
  const { id } = await w.task({ files: { "task.txt": "task\n" } });
  writeFileSync(script, `#!/bin/sh
export HOME=${w.root} GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
n=$(cat ${count} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${count}
if [ $n -eq 1 ]; then
  d=$(mktemp -d) && git clone -q ${url} $d && cd $d && echo moved > moved.txt && git add . && git -c user.name=Demo -c user.email=t@example.test commit -q -m "main moves" && git -C ${w.bare} fetch -q $d HEAD:refs/heads/main
  curl -s -X POST -H "authorization: Bearer atl_00112233445566778899aabbccddeeff" -H "x-atelier-actor: owner" -H "x-atelier-acting: claude-code/opus-5.5" -H "content-type: application/json" -d '{"step":"start","ms":0}' ${w.base}/api/projects/demo/items/${id}/land > /dev/null
fi
exit 0
`, { mode: 0o700 });
  await w.setPolicy({ checks: [`sh ${script}`], checkClasses: [{ command: `sh ${script}`, by: "owner", note: "a test double that moves main and starts an attempt" }] });
  // The check's evidence at the head, as the builder's finish records it.
  const head = (await w.detail(id)).item.head;
  await w.L().addEvidence({ itemId: id, claim: `sh ${script}`, grade: "observed", head, passed: true, by: "codex/gpt-6", at: new Date().toISOString(), changedPaths: ["task.txt"] });
  const r = await w.cli(["land", id]);
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /stale_landing/);
  const d = await w.detail(id);
  assert.equal(d.landing.step, "start", "attempt B stands as it began");
  assert.equal(d.landing.failedStep, null);
  assert.equal(w.log().filter((l) => / Merge t\d+:/.test(l)).length, 0, "nothing of the task was pushed");
});
