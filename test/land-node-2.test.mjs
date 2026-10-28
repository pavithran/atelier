// Atelier 2.0, lessons gap G1: a landing is a fact the model can read, bound
// and withdraw. Each step of `atelier land` is recorded with its attempt on
// the task's landing record, which `show --json` carries; a failure names
// its step and the last lines of that step's own output; `land --queue
// --cancel` removes a queued landing; a failed landing is not offered to the
// lander again until the head changes or it is queued again; a blocked task
// is never landed; the fast-mode review step records without a warning.
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
  const landing = w.cli(["land", id]);
  for (let i = 0; i < 600 && !existsSync(entered); i++) await new Promise((ok) => setTimeout(ok, 100));
  assert.ok(existsSync(entered), "the check on the merged tree started");
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

test("in fast mode the landing's review step records without a warning", async (t) => {
  const w = await landingWorld(t);
  await w.L().setMode("owner", "fast", "the test lands on its checks", "claude-code/opus-5.5", "land on the checks");
  const { id } = await w.task({ files: { "task.txt": "task\n" }, approve: false });
  const r = await w.cli(["land", id]);
  assert.equal(r.status, 0, r.output);
  assert.doesNotMatch(r.output, /could not be recorded/);
  const d = await w.detail(id);
  assert.equal(d.item.state, "merged");
  assert.deepEqual(eventsOf(d, "land.review").map((e) => [e.data.skipped, e.data.fast]), [[true, true]]);
});
