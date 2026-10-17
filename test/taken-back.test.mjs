import { test } from "node:test";
import assert from "node:assert/strict";
import { takenBackNotice } from "../cli/atelier.mjs";

// t391: on t389 the holder's finish was refused with only "this task must be
// live and held by you", after the owner's dispatch had ended its claim. The
// holder's next push or finish now reads that the dispatch took the task back.

const HOLDER = "deepseek/v4";
const released = (from, note) => ({ kind: "item.released", data: { from, note } });

test("a holder whose claim the developer's dispatch ended is told so", () => {
  const d = { item: { owner: null, state: "open" }, events: [{ kind: "item.claimed" }, released(HOLDER, "taken back by the developer's dispatch (atelier dispatch --release)")] };
  assert.match(takenBackNotice(d, HOLDER, "t389"), /^t389 was taken back by the developer's dispatch .*no longer yours/);
});

test("any other release, another holder's, or a task still held says nothing", () => {
  const taken = "taken back by the developer's dispatch (atelier dispatch --release)";
  assert.equal(takenBackNotice({ item: { owner: null }, events: [released(HOLDER, "out of time")] }, HOLDER, "t1"), null);
  assert.equal(takenBackNotice({ item: { owner: null }, events: [released("codex/gpt", taken)] }, HOLDER, "t1"), null);
  assert.equal(takenBackNotice({ item: { owner: HOLDER }, events: [released(HOLDER, taken)] }, HOLDER, "t1"), null);
  assert.equal(takenBackNotice({ item: { owner: null } }, HOLDER, "t1"), null);
});
