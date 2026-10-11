// `atelier status` and `atelier inbox` against the fixed portfolio of
// test/fixtures/attention.ts: both say, per project, exactly the tasks the
// rule places under the owner, in its order, once each; the pages say the
// same in test/attention-views.spec.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatInbox, formatStatus, inboxJson, statusJson } from "../cli/status.mjs";
import { ALL_ENTRIES, ALPHA_ITEMS, BETA_ITEMS, EXPECTED, NOW, OFFERS } from "./fixtures/attention.ts";

const views = () => [
  { name: "alpha", title: "Alpha", items: ALPHA_ITEMS, inbox: ALL_ENTRIES },
  { name: "beta", title: "Beta", items: BETA_ITEMS, inbox: ALL_ENTRIES },
];
const waiting = { offers: OFFERS, now: NOW, server: "https://atelier.test" };
const ownerIds = (name) => EXPECTED[name].owner.map(([id]) => id);

// The ids listed under a heading: lines indented four spaces, up to the next
// line indented two (the next heading) or less.
function listedUnder(lines, from, heading) {
  const start = lines.indexOf(heading, from);
  if (start < 0) return [];
  const ids = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("    ")) break;
    const m = /^ {4}(\S+) {2}/.exec(line);
    if (m) ids.push(m[1]);
  }
  return ids;
}

test("atelier status lists exactly the rule's owner tasks per project, each once, and counts the rest", () => {
  const lines = formatStatus(views(), waiting).split("\n");
  const alpha = lines.indexOf("Alpha (alpha)"), beta = lines.indexOf("Beta (beta)");
  assert.deepEqual(listedUnder(lines, alpha, "  Waiting for you"), ownerIds("alpha"));
  assert.equal(lines[beta + 1], "  Nothing waiting on you.");
  assert.deepEqual(listedUnder(lines.slice(beta), 0, "  Waiting for you"), []);
  // Each owner task names its call, says what to do, and links the action.
  const at = lines.indexOf("    a1  Accept  Task a1");
  assert.ok(at > 0);
  assert.equal(lines[at + 1], "      Accept the revision, whose required checks all passed at its head.");
  assert.ok(lines.slice(at, at + 6).includes("      https://atelier.test/p/alpha/a1"));
  assert.ok(lines.includes("      https://atelier.test/p/alpha/ship"));
  // The pipeline is counted, overlapping scopes are counted, neither listed inline.
  assert.ok(lines.includes("  In the pipeline: 5 tasks: 1 in review, 1 accepted, 1 building, 1 queued for a runner, 1 not yet dispatched; none waits on you."));
  assert.ok(lines.some((l) => l.startsWith("  Overlapping scopes: 1 pair;")));
  assert.ok(!lines.some((l) => /a2 and a3/.test(l)));
  // A task waiting on the owner is not listed again as in progress or queued.
  for (const id of ownerIds("alpha")) assert.equal(lines.filter((l) => l.startsWith(`    ${id}  `)).length, 1, id);
});

test("atelier status --json and atelier inbox --json carry the same placement", () => {
  const status = statusJson(views(), waiting.server, OFFERS, NOW);
  const inbox = inboxJson(views(), waiting);
  for (const name of ["alpha", "beta"]) {
    const s = status.find((p) => p.name === name), i = inbox.find((p) => p.project === name);
    assert.deepEqual(s.attention.owner.map((t) => [t.id, t.call]), EXPECTED[name].owner);
    assert.deepEqual(i.owner.map((t) => [t.id, t.call]), EXPECTED[name].owner);
    assert.deepEqual(i.pipeline.map((t) => [t.id, t.stage]), EXPECTED[name].pipeline);
    assert.deepEqual(s.overlaps, EXPECTED[name].overlaps);
    assert.deepEqual(i.overlaps, EXPECTED[name].overlaps);
  }
  assert.equal(inbox[0].owner[0].url, "https://atelier.test/p/alpha/a10");
});

test("atelier inbox prints only what waits on the owner, by project, and what was not read", () => {
  const out = formatInbox(views(), waiting);
  const lines = out.split("\n");
  assert.equal(lines[0], "Alpha (alpha): 7 waiting on you");
  assert.deepEqual(listedUnder(["h", ...lines.slice(1)], 0, "h").filter((id) => id.startsWith("a")), ownerIds("alpha"));
  assert.ok(!out.includes("Beta (beta)"), "a project with nothing waiting is left out");
  assert.ok(!out.includes("a2 and a3"));
  assert.equal(formatInbox([{ name: "beta", items: BETA_ITEMS, inbox: ALL_ENTRIES }], waiting), "Nothing needs you.");
  // Unread data is labelled, and a project not read is never said to be clear.
  const unread = formatInbox([{ name: "alpha", items: null, inbox: ALL_ENTRIES }], waiting);
  assert.match(unread, /^alpha: 0 waiting on you, and more may be\n {4}Not read: The project's tasks could not be read/);
  const noOffers = formatStatus(views(), { now: NOW }).split("\n");
  assert.ok(noOffers.includes("  Not read"));
  assert.ok(!listedUnder(noOffers, 0, "  Waiting for you").includes("a8"), "no runner is judged missing without the offers");
});
