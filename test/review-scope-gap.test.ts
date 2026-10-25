import { test } from "node:test";
import assert from "node:assert/strict";
import type { Finding, Review } from "../src/rules.ts";
import { findingScopeGap, reviewScopeGap, scopeGapText } from "../src/review/scope-gap.ts";

// t264 went to round 2 on 2026-10-25 with its blocker in cli/land-queue.mjs,
// which its scope lacked; the builder could not edit it and astra rejected
// again. A blocking finding on a file outside the scope now says so.

const scope = ["cli/land.mjs", "test/land*.test.*"];
const blocking = (file: string): Finding => ({ file, line: 3, severity: "blocking", text: "Wrong." });

test("a blocking finding inside the scope names no gap", () => {
  assert.equal(findingScopeGap({ id: "t264", scope }, [blocking("cli/land.mjs"), blocking("test/land-queue.test.mjs")]), null);
});

test("a blocking finding outside the scope names the file and the edit that keeps the other globs", () => {
  const gap = findingScopeGap({ id: "t264", scope }, [blocking("cli/land.mjs"), blocking("./cli/land-queue.mjs"), blocking("cli/land-queue.mjs")]);
  assert.deepEqual(gap?.files, ["cli/land-queue.mjs"]);
  assert.equal(gap?.edit, "atelier edit t264 --scope cli/land.mjs --scope 'test/land*.test.*' --scope cli/land-queue.mjs");
  assert.ok(scopeGapText({ id: "t264" }, gap!).includes("cli/land-queue.mjs"));
});

test("a follow-up, a labelled finding and an unscoped task name no gap", () => {
  assert.equal(findingScopeGap({ id: "t1", scope }, [{ ...blocking("x.ts"), severity: "follow-up" }, { ...blocking("y.ts"), severity: "follow-up", label: "pre-existing" }]), null);
  assert.equal(findingScopeGap({ id: "t1", scope: [] }, [blocking("x.ts")]), null);
});

test("only the rejections at the item's head count", () => {
  const review = (head: string, approve: boolean, file: string): Review => ({ itemId: "t264", by: "codex/gpt-6-astra", head, approve, note: "", at: "2026-10-25T00:00:00Z", findings: [blocking(file)] });
  const item = { id: "t264", scope, head: "b".repeat(40) };
  assert.equal(reviewScopeGap(item, [review("a".repeat(40), false, "cli/land-queue.mjs"), review(item.head, true, "cli/other.mjs")]), null);
  assert.deepEqual(reviewScopeGap(item, [review(item.head, false, "cli/land-queue.mjs")])?.files, ["cli/land-queue.mjs"]);
});
