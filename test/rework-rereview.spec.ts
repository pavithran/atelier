import { test } from "node:test";
import assert from "node:assert/strict";
import { env } from "./support/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";

// t521, criterion 2: after a rejection sends the task back and the builder
// pushes a new head, the checks and the review run again with no session
// command. The standing review-on-checked instruction is what asks the
// review; the only calls here are the builder's own and the stage tick.

const BUILDER = "claude-code/sonnet-5.5", REVIEWER = "codex/gpt-6-astra";
const H1 = "a".repeat(40), H2 = "b".repeat(40), AT = new Date().toISOString();
const pool: ModelEntry[] = [["claude-code", "sonnet-5.5"], ["codex", "gpt-6-astra"]].map(([harness, id]) => ({
  harness: harness as ModelEntry["harness"], id, family: familyOf(id), where: "home", provider: "subscription", aliases: [], note: "", addedBy: "owner", addedAt: AT,
}));

test("a rejected task reworked at a new head is checked and reviewed again without a session command", async () => {
  const name = "rework-rereview";
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject({ name, repo: name, policy: { checks: ["npm test"], protected: ["src/**"] }, createdAt: AT }, "owner");
  await L.setMode("owner", "fast", "developer instruction", BUILDER, "ask the review at checked");
  await L.recordDecision({ standing: { key: "review-on-checked", value: `anthropic=${REVIEWER}` }, quote: "ask the review at checked" }, "owner");
  await L.poolChanged(pool);
  const { id } = await L.newItem("Rework", ["src/**"], "owner", { accept: ["Works"] });
  await L.claim(id, BUILDER);
  await L.setWorkspace(id, `${name}--${id}`, "0".repeat(40), BUILDER);
  const pushAndCheck = async (head: string) => {
    await L.recordPush(id, BUILDER, head, head, false, { holdsRecorded: true, rebasedFrom: null }, []);
    await L.addEvidence({ itemId: id, claim: "npm test", grade: "observed", passed: true, head, changedPaths: ["src/a.ts"], by: "owner", at: AT });
  };
  await pushAndCheck(H1);
  await L.submit(id, BUILDER);
  await L.stageTick(new Date());
  const requests = async () => (await L.events(id, 1000)).filter((e) => e.kind === "review.requested");
  assert.equal((await requests()).length, 1, "the first head is reviewed by the standing instruction");

  // The reviewer rejects; the runner sends the task back (dispatch), and the builder reclaims it and pushes a new head.
  const claim = await L.claimReview(id, REVIEWER, { runner: "home:review", kind: "home" });
  await L.addReview({ itemId: id, by: REVIEWER, approve: false, note: "One bug.", head: H1, criteria: await L.criteria(id), request: claim.request, at: new Date().toISOString(), findings: [{ file: "src/a.ts", line: 8, severity: "blocking", text: "A lapsed claim is never retried." }] });
  await L.dispatch(id, "owner", { to: "home", agent: "claude-code", model: "sonnet-5.5" });
  await L.claim(id, BUILDER, { runner: "home:studio", kind: "home" });
  await pushAndCheck(H2);
  await L.submit(id, BUILDER);

  // No call by a session: the tick alone asks the review of the new head.
  await L.stageTick(new Date());
  const after = await requests();
  assert.equal(after.length, 2);
  const again = after.find((e) => e.data.head === H2);
  assert.ok(again, "the new head is asked for review");
  assert.equal(again.data.reviewer, REVIEWER);
  assert.equal(again.data.round, 2);
  assert.equal(typeof again.data.standingDecision, "string");
});
