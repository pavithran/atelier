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
  assert.equal(verdict, " ".repeat(22) + "owner's verdict: fixed. Fixed in the second head");
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
  assert.match(lines[2], /rejected by zcode\/glm-5\.3 at bbbbbbbb \(recorded by the project owner with the owner token, answering a review request it claimed\): Served by a runner/);
  assert.match(lines[3], /approved by antigravity\/gemini-3\.1-pro at bbbbbbbb \(recorded by the project owner with the owner token\): Named by the owner\.$/);
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
