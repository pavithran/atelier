import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewStall } from "../src/landing-verdict.ts";

// The decision a landing's review wait makes each poll with no verdict yet
// (t574): t573 at cc688bac waited 62 minutes on opencode/glm-5.3, whose
// replies had no VERDICT line, until "no verdict from opencode/glm-5.3
// within 1 hours".

const H = "c".repeat(40), OTHER = "d".repeat(40);
const SINCE = "2026-10-13T09:20:00.000Z";
const GLM = "opencode/glm-5.3";
const live = { reviewer: GLM };

test("a live request and no unreadable reply: the wait goes on", () => {
  assert.equal(reviewStall(H, SINCE, GLM, live, []), null);
});

test("a reply with no readable verdict from the reviewer since the ask ends the wait, naming it", () => {
  const reply = { by: GLM, head: H, at: "2026-10-13T09:40:00.000Z", note: "no VERDICT line" };
  assert.deepEqual(reviewStall(H, SINCE, GLM, live, [reply]), { kind: "unparsable", by: GLM, note: "no VERDICT line" });
  // Read whatever the case of the actor.
  assert.deepEqual(reviewStall(H, SINCE, "OpenCode/GLM-5.3", live, [reply])?.kind, "unparsable");
});

test("an unreadable reply before the ask, at another head, or by another reviewer counts for nothing", () => {
  const before = { by: GLM, head: H, at: "2026-10-13T09:00:00.000Z", note: "old" };
  const elsewhere = { by: GLM, head: OTHER, at: "2026-10-13T09:40:00.000Z", note: "other head" };
  const someoneElse = { by: "codex/gpt-6-astra", head: H, at: "2026-10-13T09:40:00.000Z", note: "not asked" };
  assert.equal(reviewStall(H, SINCE, GLM, live, [before, elsewhere, someoneElse]), null);
});

test("no open or claimed request and no verdict ends the wait at once", () => {
  assert.deepEqual(reviewStall(H, SINCE, GLM, null, []), { kind: "no_request" });
});
