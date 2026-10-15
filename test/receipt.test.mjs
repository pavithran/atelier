import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EVENT_PAGE, receiptJson, receiptText } from "../cli/receipt.mjs";

const cli = resolve("cli/atelier.mjs");

const A = "a".repeat(40), B = "b".repeat(40), M = "5af22431".padEnd(40, "0");
const ev = (seq, at, actor, kind, data) => ({ seq, itemId: "t1", at, actor, kind, data });

// A task's whole story, newest first as the detail route answers: two rounds,
// a rejection with findings the owner judged, and the merge that ended it.
const detail = () => ({
  item: { id: "t1", title: "Fix the parser", state: "merged" },
  events: [
    ev(13, "2026-10-07T21:28:44.552Z", "pavi", "item.merged", { mergeCommit: M, head: B, observedOnBaseline: true }),
    ev(12, "2026-10-07T21:28:36.359Z", "pavi", "land.accept", { ms: 656 }),
    ev(11, "2026-10-07T21:28:33.290Z", "opencode/glm-5.3", "review.approved", { note: "The findings hold as fixed.", head: B, findings: [] }),
    ev(10, "2026-10-07T21:24:10.045Z", "claude-code/opus-5.5", "item.submitted", { head: B, summary: "The required checks pass." }),
    ev(9, "2026-10-07T21:21:33.463Z", "claude-code/opus-5.5", "push.observed", { head: B }),
    ev(8, "2026-10-07T21:10:00.000Z", "pavi", "review.finding", { head: A, index: 1, verdict: "fixed", note: "Fixed in the second head", by: "opencode/glm-5.3", finding: { file: "src/parser.ts", line: 12, severity: "blocking", text: "Drops the last row" } }),
    ev(7, "2026-10-07T21:02:06.195Z", "opencode/glm-5.3", "review.rejected", { note: "One blocking defect", head: A, findings: [{ file: "src/parser.ts", line: 12, severity: "blocking", text: "Drops the last row" }] }),
    ev(6, "2026-10-07T20:56:58.510Z", "claude-code/opus-5.5", "item.submitted", { head: A, summary: "Merged with main at 51c0dd47; the required checks pass." }),
    ev(5, "2026-10-07T20:56:55.225Z", "claude-code/opus-5.5", "evidence.observed", { claim: "npm test", passed: true, head: A, where: "runner" }),
    ev(4, "2026-10-07T20:54:04.248Z", "claude-code/opus-5.5", "evidence.observed", { claim: "npm test", passed: false, head: A, where: "sandbox", merged: true, mainHead: M }),
    ev(3, "2026-10-07T20:54:04.000Z", "claude-code/opus-5.5", "push.observed", { head: A }),
    ev(2, "2026-10-07T20:27:16.169Z", "claude-code/opus-5.5", "item.claimed", {}),
    ev(1, "2026-10-07T20:27:11.752Z", "pavi", "item.created", { title: "Fix the parser", scope: ["src/**"] }),
  ],
});

test("the receipt prints the whole story in the order the ledger recorded it", () => {
  const text = receiptText("atelier", "t1", detail(), "https://atelier.zone");
  const lines = text.split("\n");
  assert.equal(lines[0], "atelier/t1  Fix the parser");
  assert.equal(lines[1], "The whole story from the ledger, in order.");
  const stamps = lines.slice(2, -1).map((l) => l.slice(0, 20)).filter((s) => s.trim());
  // The events read newest first come out oldest first: created, claimed,
  // push, checks, submit, rejection with its finding and verdict, push,
  // submit, approval, merged.
  assert.deepEqual(stamps, ["2026-10-07 20:27 UTC", "2026-10-07 20:27 UTC", "2026-10-07 20:54 UTC", "2026-10-07 20:54 UTC", "2026-10-07 20:56 UTC", "2026-10-07 20:56 UTC", "2026-10-07 21:02 UTC", "2026-10-07 21:21 UTC", "2026-10-07 21:24 UTC", "2026-10-07 21:28 UTC", "2026-10-07 21:28 UTC"]);
  assert.match(lines[2], /created by pavi$/);
  assert.match(lines[3], /claimed by claude-code\/opus-5\.5$/);
  assert.match(lines[4], /head aaaaaaaa pushed by claude-code\/opus-5\.5, observed in Artifacts$/);
  assert.match(lines[5], /check failed, observed in a Cloudflare container: npm test at aaaaaaaa, merged with main 5af22431/);
  assert.match(lines[6], /check passed, observed in a clean clone: npm test at aaaaaaaa$/);
  assert.match(lines[7], /submitted by claude-code\/opus-5\.5 at aaaaaaaa: Merged with main at 51c0dd47; the required checks pass\.$/);
  const [rejected, finding, verdict] = lines.slice(8, 11);
  assert.match(rejected, /rejected by opencode\/glm-5\.3 at aaaaaaaa: One blocking defect$/);
  assert.equal(finding, " ".repeat(22) + "1. blocking src/parser.ts:12 Drops the last row");
  // The verdict's event number, which atelier defect --contradicts names (t440).
  assert.equal(verdict, " ".repeat(22) + "developer's verdict: fixed. Fixed in the second head (event 8)");
  assert.match(lines.at(-5), /head bbbbbbbb pushed by/);
  assert.match(lines.at(-3), /approved by opencode\/glm-5\.3 at bbbbbbbb/);
  assert.match(lines.at(-2), /merged by pavi: bbbbbbbb accepted, merge commit 5af22431 on the baseline$/);
  assert.equal(lines.at(-1), "https://atelier.zone/p/atelier/t1");
});

// t346: a review line says who recorded the verdict, as the task page does:
// the reviewer itself when its own agent token proved the event, the owner
// token in the reviewer's name otherwise (and whether it answered a claimed
// request); an event from before the ledger recorded that says nothing.
test("a review line names its recorder: the reviewer itself under its own token, else the owner token", () => {
  const story = { item: detail().item, ownerActor: "pavi", events: [
    ev(4, "2026-10-07T21:30:00.000Z", "antigravity/gemini-3.1-pro", "review.approved", { note: "Named by the owner.", head: B, recordedBy: "pavi" }),
    ev(3, "2026-10-07T21:29:00.000Z", "zcode/glm-5.3", "review.rejected", { note: "Served by a runner under the owner token.", head: B, recordedBy: "pavi", claimed: true }),
    { ...ev(2, "2026-10-07T21:28:33.290Z", "opencode/glm-5.3", "review.approved", { note: "Served by a runner under its own token.", head: B, recordedBy: "opencode/glm-5.3" }), proved: true },
    ev(1, "2026-10-07T21:02:06.195Z", "opencode/glm-5.3", "review.rejected", { note: "Before t215.", head: A }),
  ] };
  const lines = receiptText("atelier", "t1", story).split("\n").slice(2);
  assert.match(lines[0], /rejected by opencode\/glm-5\.3 at aaaaaaaa: Before t215\.$/);
  assert.match(lines[1], /approved by opencode\/glm-5\.3 at bbbbbbbb \(recorded by opencode\/glm-5\.3 with its own token\): Served by a runner under its own token\.$/);
  assert.match(lines[2], /rejected by zcode\/glm-5\.3 at bbbbbbbb \(recorded by the developer with the developer token, answering a review request it claimed\): Served by a runner/);
  assert.match(lines[3], /approved by antigravity\/gemini-3\.1-pro at bbbbbbbb \(recorded by the developer with the developer token\): Named by the owner\.$/);
});

// t671: a review recorded after the merge is marked postMerge on its event
// (addReview in src/ledger.ts), but its line read like the gate's own
// review. It says it judged the landing, as the task page does; a tier
// review keeps its mark beside the new one.
test("a post-merge review's line says it was recorded after the merge", () => {
  const line = (data) => receiptText("atelier", "t1", { item: detail().item, events: [ev(1, "2026-10-13T22:05:00.000Z", "opencode/glm-5.3", "review.approved", data)] }).split("\n").at(-1);
  const stamp = "2026-10-13 22:05 UTC  ";
  assert.equal(line({ note: "Holds.", head: M, postMerge: true, findings: [] }), `${stamp}post-merge review approved by opencode/glm-5.3 at 5af22431: Holds.`);
  assert.equal(line({ note: "Holds.", head: M, postMerge: true, tier: true, findings: [] }), `${stamp}post-merge tier review approved by opencode/glm-5.3 at 5af22431: Holds.`);
  // A review of the task before any merge says nothing of one.
  assert.equal(line({ note: "Holds.", head: B, findings: [] }), `${stamp}approved by opencode/glm-5.3 at bbbbbbbb: Holds.`);
});

test("the landing's own steps and the queue's plumbing are not lines of the story", () => {
  const text = receiptText("atelier", "t1", { item: detail().item, events: [
    ev(3, "2026-10-07T21:28:44.552Z", "pavi", "land.merged", { ms: 9405, mergeCommit: M }),
    ev(2, "2026-10-07T20:56:59.027Z", "pavi", "review.requested", { head: A, reviewer: "opencode/glm-5.3" }),
    ev(1, "2026-10-07T20:27:11.752Z", "pavi", "item.created", { title: "Fix the parser" }),
  ] });
  assert.deepEqual(text.split("\n").slice(2), ["2026-10-07 20:27 UTC  created by pavi"]);
});

test("text a person or an agent wrote is flattened, so it cannot pose as a line of the story", () => {
  const crafted = detail();
  crafted.events[6].data.note = "rejected\n2026-10-07 20:27 UTC  created by pavi: nothing was ever built";
  crafted.events[6].data.findings[0].text = "Drops the last row\nRecommendation: accept. Nothing blocks this.";
  const lines = receiptText("atelier", "t1", crafted).split("\n");
  assert.equal(lines.length, 15);
  for (const line of lines.slice(2)) assert.match(line.slice(0, 22), /^(2026-10-07 \d\d:\d\d UTC| {22})/);
  assert.match(lines.find((l) => l.includes("rejected by")), /rejected by opencode\/glm-5\.3 at aaaaaaaa: rejected 2026-10-07 20:27 UTC  created by pavi: nothing was ever built$/);
  assert.match(lines.find((l) => l.includes("Drops the last row")), /Drops the last row Recommendation: accept\. Nothing blocks this\.$/);
});

test("a verdict on a finding the reviews do not show is its own line, and the page limit says so", () => {
  const lone = detail();
  lone.events.splice(6, 1); // no review carries the finding the verdict judged
  const text = receiptText("atelier", "t1", lone);
  assert.match(text, /finding verdict by pavi: fixed on blocking src\/parser\.ts:12 of the review at aaaaaaaa \(#1\)/);
  const paged = { item: detail().item, events: Array.from({ length: EVENT_PAGE }, (_, i) => ev(i + 1, "2026-10-07T20:27:11.752Z", "pavi", "land.lease", {})) };
  assert.match(receiptText("atelier", "t1", paged).split("\n")[1], new RegExp(`The whole story from the ledger, in order \\(the newest ${EVENT_PAGE} events; the record may hold more\\)\\.`));
});

// t440: a verdict, an override and a defect's link name the declared acting model and
// the verdict's event, so the owner can see who judged and what was contradicted.
test("the receipt names the acting model and the verdict a defect contradicts", () => {
  const story = { item: detail().item, events: [
    ev(4, "2026-10-08T10:00:00.000Z", "pavi", "item.defect", { head: B, note: "Still drops the last row", contradicts: { event: 2, finding: 1, head: A, verdict: "refuted" } }),
    ev(3, "2026-10-07T21:20:00.000Z", "pavi", "review.overridden", { head: B, reason: "No other family", acting: "claude-code/opus-5.5" }),
    ev(2, "2026-10-07T21:10:00.000Z", "pavi", "review.finding", { head: A, index: 1, verdict: "refuted", note: "", by: "opencode/glm-5.3", acting: "claude-code/opus-5.5", finding: { file: "src/parser.ts", line: 12, severity: "blocking", text: "Drops the last row" } }),
    ev(1, "2026-10-07T21:02:06.195Z", "opencode/glm-5.3", "review.rejected", { note: "One blocking defect", head: A, findings: [{ file: "src/parser.ts", line: 12, severity: "blocking", text: "Drops the last row" }] }),
  ] };
  const lines = receiptText("atelier", "t1", story).split("\n").slice(2);
  assert.equal(lines[2], " ".repeat(22) + "developer's verdict: refuted (event 2, declared acting claude-code/opus-5.5)");
  assert.match(lines[3], /independent review overridden by pavi, declared acting claude-code\/opus-5\.5: No other family$/);
  assert.match(lines[4], /defect recorded by pavi at bbbbbbbb: Still drops the last row; contradicts the refuted verdict, event 2, on finding 1$/);
});

// t629: an override on the developer's direction says whose words and which
// model relayed them, so every such override says afterwards who asked and why.
test("the receipt names the developer's words an override was made on", () => {
  const story = { item: detail().item, events: [
    ev(1, "2026-10-13T21:20:00.000Z", "pavi", "review.overridden", { head: B, reason: "No other family", confirmed: "direction", quote: "override it, nobody else can review", acting: "claude-code/opus-5.5" }),
  ] };
  const text = receiptText("atelier", "t1", story);
  assert.match(text, /independent review overridden by pavi, declared acting claude-code\/opus-5\.5: No other family; on the developer's words: “override it, nobody else can review”/);
});

// t629 review (codex/gpt-6-astra): a fast landing was dropped from the text
// receipt, so the developer's words fast mode was switched on, and the model
// that relayed them, did not show though the stored receipt held them.
test("the receipt names a fast landing with its receipt and the developer's words fast mode was switched on", () => {
  const story = { item: detail().item, events: [
    ev(2, "2026-10-13T22:00:01.000Z", "pavi", "item.merged", { mergeCommit: M, head: B, observedOnBaseline: false, fast: true }),
    ev(1, "2026-10-13T22:00:00.000Z", "pavi", "item.landed_fast", { commit: B, mergeCommit: M, builder: "claude-code/opus-5.5", tests: { command: "npm test", sha256: "f".repeat(64), where: "clean clone" }, reason: "forks fail", at: "2026-10-13T22:00:00.000Z", by: "pavi", quote: "go to fast mode", acting: "claude-code/opus-5.5" }),
  ] };
  const text = receiptText("atelier", "t1", story);
  assert.match(text, /landed in fast mode by pavi: bbbbbbbb built by claude-code\/opus-5\.5, merge commit 5af22431; npm test passed in a clean clone, output sha256 ffffffffffff; fast mode: forks fail; on the developer's words: “go to fast mode”, relayed by claude-code\/opus-5\.5/);
  // A fast landing switched on the page's permission names no words.
  const paged = receiptText("atelier", "t1", { item: detail().item, events: [ev(1, "2026-10-13T22:00:00.000Z", "pavi", "item.landed_fast", { commit: B, mergeCommit: M, builder: "claude-code/opus-5.5", tests: { command: "npm test", sha256: "f".repeat(64) }, reason: "forks fail" })] });
  assert.match(paged, /landed in fast mode by pavi: bbbbbbbb built by claude-code\/opus-5\.5, merge commit 5af22431; npm test passed, output sha256 ffffffffffff; fast mode: forks fail$/m);
});

// t653: a merge made outside Atelier and recorded afterwards is told as
// that, with the reviews as given, and never as an accepted head merged on
// the baseline, the line a gated landing gets.
test("the receipt names a merge recorded after the fact as made outside Atelier, with the reviews as given", () => {
  const story = { item: detail().item, events: [
    ev(2, "2026-10-14T10:00:00.000Z", "pavi", "item.merged", { mergeCommit: M, head: B, observedOnBaseline: true, outside: true }),
    ev(1, "2026-10-14T10:00:00.000Z", "pavi", "item.merge_recorded", { mergeCommit: M, commit: B, reviews: [{ by: "codex/gpt-6-astra", verdict: "approve", head: B, at: "2026-10-13" }, { by: "antigravity/gemini-4-argon", verdict: "reject", head: A }], note: "merged under the freeze", outside: true }),
  ] };
  const text = receiptText("atelier", "t1", story);
  assert.match(text, /merged outside Atelier, recorded afterwards by pavi: bbbbbbbb merged as 5af22431 on main; no checks or test receipt recorded: merged under the freeze/);
  assert.match(text, /review as given: approved by codex\/gpt-6-astra at bbbbbbbb \(2026-10-13\)/);
  assert.match(text, /review as given: rejected by antigravity\/gemini-4-argon at aaaaaaaa$/m);
  assert.doesNotMatch(text, /accepted, merge commit/);
});

// t660 (follow-up from t653): a fast landing's merge printed "bbbbbbbb
// accepted, merge commit 5af22431 on the baseline", though a fast landing
// records no acceptance and the server had not observed the merge on the
// baseline (landedFast records observedOnBaseline: false). The line says
// what happened instead, in the task page's words for the review.
test("a fast landing's merge never says accepted or on the baseline, and says whether its post-merge review is recorded", () => {
  const landed = ev(1, "2026-10-13T22:00:00.000Z", "pavi", "item.landed_fast", { commit: B, mergeCommit: M, builder: "claude-code/opus-5.5", tests: { command: "npm test", sha256: "f".repeat(64), where: "clean clone" }, reason: "forks fail" });
  const merged = ev(2, "2026-10-13T22:00:00.000Z", "pavi", "item.merged", { mergeCommit: M, head: B, observedOnBaseline: false, fast: true });
  const mergeLine = (...later) => receiptText("atelier", "t1", { item: detail().item, events: [landed, merged, ...later] }).split("\n").find((l) => l.includes("merged in fast mode") || l.includes("merged by"));
  const stamp = "2026-10-13 22:00 UTC  ";
  assert.equal(mergeLine(), `${stamp}merged in fast mode by pavi: bbbbbbbb merged as 5af22431, no baseline observation recorded; it skipped the gate, and no post-merge review was requested`);
  const requested = ev(3, "2026-10-13T22:01:00.000Z", "pavi", "review.requested", { head: M });
  assert.equal(mergeLine(requested), `${stamp}merged in fast mode by pavi: bbbbbbbb merged as 5af22431, no baseline observation recorded; it skipped the gate; a post-merge review was requested and is not recorded yet`);
  const review = ev(4, "2026-10-13T22:05:00.000Z", "opencode/glm-5.3", "review.approved", { note: "Holds.", head: M, postMerge: true, findings: [] });
  assert.equal(mergeLine(requested, review), `${stamp}merged in fast mode by pavi: bbbbbbbb merged as 5af22431, no baseline observation recorded; it skipped the gate; its post-merge review is recorded`);
  // Only a baseline observation recorded on the event lets the line say so.
  const seen = receiptText("atelier", "t1", { item: detail().item, events: [landed, ev(2, merged.at, "pavi", "item.merged", { ...merged.data, observedOnBaseline: true })] });
  assert.match(seen, /merged in fast mode by pavi: bbbbbbbb merged as 5af22431, on the baseline; it skipped the gate/);
  assert.doesNotMatch(seen, /accepted/);
  // A fast merge event without its flag is still told as fast when the
  // landing it records sits before it with the same merge commit.
  const unflagged = receiptText("atelier", "t1", { item: detail().item, events: [landed, ev(2, merged.at, "pavi", "item.merged", { mergeCommit: M, head: B, observedOnBaseline: false })] });
  assert.match(unflagged, /merged in fast mode by pavi: bbbbbbbb merged as 5af22431/);
  for (const text of [receiptText("atelier", "t1", { item: detail().item, events: [landed, merged] }), unflagged]) {
    assert.doesNotMatch(text, /accepted/);
    assert.doesNotMatch(text, /on the baseline/);
  }
});

// A gated landing prints exactly as before t660: the accepted head, the
// merge commit, on the baseline. t671: a merge event that recorded no
// baseline observation never says the observation, so a plan's part, marked
// merged through its plan when the plan lands (its item.merged carries via
// and no observedOnBaseline, Ledger.merged), and an older event from before
// the field was, do not print "on the baseline".
test("a gated landing's merge line is unchanged; a merge with no recorded baseline observation does not say on the baseline", () => {
  const line = (data) => receiptText("atelier", "t1", { item: detail().item, events: [ev(1, "2026-10-07T21:28:44.552Z", "pavi", "item.merged", data)] }).split("\n").at(-1);
  const gated = "2026-10-07 21:28 UTC  merged by pavi: bbbbbbbb accepted, merge commit 5af22431 on the baseline";
  assert.equal(line({ mergeCommit: M, head: B, observedOnBaseline: true }), gated);
  assert.equal(receiptText("atelier", "t1", detail()).split("\n").at(-1), gated);
  assert.equal(line({ mergeCommit: M, head: B }), "2026-10-07 21:28 UTC  merged by pavi: bbbbbbbb accepted, merge commit 5af22431");
  // A plan's part took no acceptance (integratePart): its line says only
  // what the event records, the integration and the plan it landed through.
  assert.equal(line({ mergeCommit: M, head: B, via: "t0" }), "2026-10-07 21:28 UTC  merged by pavi through plan t0: bbbbbbbb integrated onto the plan's branch, no acceptance recorded on the part; merge commit 5af22431");
  assert.match(line({ mergeCommit: M, via: "t0" }), /through plan t0: integrated onto the plan's branch, no acceptance recorded on the part; merge commit 5af22431$/);
});

test("the receipt as JSON carries the item's events in the ledger's order, whole", () => {
  const json = receiptJson("atelier", "t1", detail());
  assert.deepEqual(json, { project: "atelier", id: "t1", title: "Fix the parser", state: "merged", events: [...detail().events].sort((a, b) => a.seq - b.seq) });
  assert.equal(json.events.at(-1).kind, "item.merged");
  assert.ok(json.events.some((e) => e.kind === "land.accept"), "the JSON keeps events the text leaves out");
});

// The command: `atelier receipt ID` reads the item's detail route and prints
// the receipt; before it existed the command was refused as unknown.
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "atelier-receipt-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const served = detail();
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(served));
  });
  t.after(() => server.close());
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  writeFileSync(join(root, "config.json"), JSON.stringify({ projects: { proj: { path: join(root, "proj") } } }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function run(argv) {
    const child = spawn(process.execPath, [cli, ...argv], { cwd: root, env: { ...process.env, ATELIER_CONFIG_DIR: root, ATELIER_SERVER: origin, ATELIER_TOKEN: "fake", ATELIER_ACTOR: "pavi" } });
    let output = ""; child.stdout.on("data", (s) => output += s); child.stderr.on("data", (s) => output += s);
    const status = await new Promise((done) => child.on("close", done));
    return { status, output };
  }
  return { run, requests, origin, served };
}

test("atelier receipt ID prints the task's story from the item's detail route", async (t) => {
  const f = await fixture(t);
  const r = await f.run(["receipt", "t1", "--project", "proj"]);
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(f.requests, ["/api/projects/proj/items/t1"]);
  assert.equal(r.output, receiptText("proj", "t1", f.served, f.origin) + "\n");
});

test("atelier receipt ID --json prints the events in order", async (t) => {
  const f = await fixture(t);
  const r = await f.run(["receipt", "t1", "--project", "proj", "--json"]);
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(JSON.parse(r.output), receiptJson("proj", "t1", f.served));
});

test("atelier receipt refuses a flag it does not take", async (t) => {
  const f = await fixture(t);
  const r = await f.run(["receipt", "t1", "--project", "proj", "--reviews"]);
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /receipt does not take --reviews; see atelier receipt --help/);
  assert.deepEqual(f.requests, []);
});
