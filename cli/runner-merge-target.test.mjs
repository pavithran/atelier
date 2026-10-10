import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeMainJob, mergeReview } from "./runner.mjs";

const dispatched = "a".repeat(40), current = "b".repeat(40);
const previous = "c".repeat(40), head = "d".repeat(40);
const event = (overrides = {}) => ({
  seq: 1, itemId: "t9", kind: "item.submitted", actor: "codex/gpt-6-astra",
  data: { head, summary: `Merged main at ${current}` }, ...overrides,
});
const claim = (item = {}) => ({
  item: { id: "t9", dispatch: { job: "merge-main", head: dispatched }, ...item },
  head, events: [event()],
});

for (const item of [{}, { dispatch: undefined, partKey: `merge-main-${dispatched.slice(0, 8)}` }]) {
  test(`review uses the recorded claim-time main after dispatch at an older main (${item.partKey ? "part key" : "dispatch"})`, async () => {
    const reviewed = claim(item);
    const io = {
      parents: async () => `${head} ${previous} ${current}`,
      remergeDiff: async () => "conflict resolution",
      diffNames: async () => "resolved.txt\nmain-only.txt\n",
    };
    assert.deepEqual(await mergeReview(io, "/workspace", reviewed), {
      diff: "conflict resolution",
      compare: { from: previous, merge: { main: current, files: ["resolved.txt", "main-only.txt"] } },
    });
    io.parents = async () => `${head} ${previous} ${dispatched}`;
    assert.match((await mergeReview(io, "/workspace", reviewed)).skipped, /second parent/);
  });
}

test("only the latest submission for this item and reviewed head names the target", () => {
  for (const events of [
    [],
    [event({ itemId: "t10" })],
    [event({ data: { head: previous, summary: `Merged main at ${current}` } })],
    [event({ seq: 2, data: { head, summary: "A later summary" } }), event()],
    [event({ data: { head, summary: `Merged main at ${current.slice(0, 8)}` } })],
  ]) {
    assert.deepEqual(mergeMainJob({ ...claim(), events }), { main: dispatched });
  }
  assert.equal(mergeMainJob(claim({ dispatch: undefined })), null);
});
