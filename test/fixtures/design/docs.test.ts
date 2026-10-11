import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// The design documents (t499) hold to one another: every finding the
// critique raises is answered by a proposal in the plan, every proposal
// names its scope, dependencies, the findings it traces to and criteria of
// at most 300 characters, and every mockup the plan links exists.

const read = (p: string) => readFileSync(resolve("docs/design", p), "utf8");
const critique = read("critique.md");
const plan = read("plan.md");

const findings = [...new Set([...critique.matchAll(/^### (F\d+)\./gm)].map((m) => m[1]))];
const proposals = [...plan.matchAll(/^\*\*(P\d+)\. ([^*]+)\*\*\n((?:- .*\n)+)/gm)].map((m) => ({ id: m[1], title: m[2], body: m[3] }));

test("each proposal has a title, scope, dependencies, traced findings and criteria of at most 300 characters", () => {
  assert.ok(proposals.length >= 10, `${proposals.length} proposals`);
  for (const p of proposals) {
    for (const field of ["Scope", "Depends on", "Traces", "Criteria"]) assert.match(p.body, new RegExp(`^- ${field}: \\S`, "m"), `${p.id} has no ${field}`);
    const criteria = /^- Criteria: (.*)$/m.exec(p.body)![1];
    assert.ok([...criteria].length <= 300, `${p.id}'s criteria are ${[...criteria].length} characters`);
  }
});

test("every finding in the critique is traced by a proposal, or kept as a strength", () => {
  assert.ok(findings.length >= 15);
  const traced = new Set(proposals.flatMap((p) => [.../F\d+/g[Symbol.matchAll](/^- Traces: (.*)$/m.exec(p.body)![1])].map((m) => m[0])));
  const kept = findings.filter((f) => new RegExp(`^### ${f}\\. What is strong`, "m").test(critique));
  assert.deepEqual(findings.filter((f) => !traced.has(f) && !kept.includes(f)), []);
});

test("every proposal the critique cites exists in the plan", () => {
  const ids = new Set(proposals.map((p) => p.id));
  const cited = [...new Set([...critique.matchAll(/\bP(\d+)\b/g)].map((m) => `P${m[1]}`))];
  assert.deepEqual(cited.filter((c) => !ids.has(c)), []);
});

test("every mockup the plan links exists and links the shared stylesheet", () => {
  const linked = [...new Set([...plan.matchAll(/\]\((mockups\/[a-z-]+\.html)\)/g)].map((m) => m[1]))];
  assert.ok(linked.length >= 12, `${linked.length} mockups linked`);
  for (const file of linked) {
    assert.ok(existsSync(resolve("docs/design", file)), `${file} is missing`);
    assert.match(read(file), /<link rel="stylesheet" href="mockup\.css">/, `${file} does not use mockup.css`);
    assert.doesNotMatch(read(file), /<script|https?:\/\/fonts\./, `${file} loads script or remote fonts`);
  }
});
