import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlan, type Plan, type PlanPart } from "../src/plans/schema.ts";
import { validatePlan } from "../src/plans/validate.ts";

const part = (key: string, change: Partial<PlanPart> = {}): PlanPart => ({
  key, title: key, kind: "build", taskKind: "feature", scope: [`src/${key}/**`], dependsOn: [],
  provides: [], uses: [], brief: "Implement the part", acceptance: ["Works"], tests: [], size: "S", ...change,
});
const plan = (...parts: PlanPart[]): Plan => ({ schema: "atelier.plan.v1", goal: "A feature", parts });

test("valid multi-part plan with transitive uses and ordered overlap", () => {
  const input = plan(
    part("api", { kind: "interface", provides: ["API"] }),
    part("build", { dependsOn: ["api"], uses: ["API"], scope: ["src/**"] }),
    part("tests", { kind: "tests", taskKind: "tests", dependsOn: ["build"], uses: ["API"], scope: ["src/build/test.ts"] }),
    part("docs", { kind: "docs", taskKind: "docs", dependsOn: ["tests"], scope: ["docs/**"] }),
  );
  assert.ok(parsePlan(input).ok);
  assert.deepEqual(validatePlan(input), []);
});

test("duplicate keys and caps", () => {
  assert.deepEqual(validatePlan(plan(part("a"), part("a"))), ["part a.key: duplicate key"]);
  assert.deepEqual(validatePlan(plan(...Array.from({ length: 13 }, (_, i) => part(`p${i}`)))), ["plan.parts: must contain at most 12 parts"]);
  assert.deepEqual(validatePlan(plan(part("a", { scope: Array(7).fill("src/a/**") }))), ["part a.scope: must contain at most 6 globs"]);
});

test("unknown dependency", () => {
  assert.deepEqual(validatePlan(plan(part("a", { dependsOn: ["missing"] }))), ["part a.dependsOn: unknown part missing"]);
});

test("cycle names its members, excluding a blocked descendant", () => {
  assert.deepEqual(validatePlan(plan(part("tail", { dependsOn: ["a"] }), part("a", { dependsOn: ["b"] }), part("b", { dependsOn: ["a"] }))),
    ["part a.dependsOn: cycle a -> b -> a"]);
  assert.deepEqual(validatePlan(plan(part("a", { dependsOn: ["a"] }))), ["part a.dependsOn: cycle a -> a"]);
});

test("overlap requires dependency ordering in either direction", () => {
  const a = part("a", { scope: ["src/**"] });
  const b = part("b");
  assert.deepEqual(validatePlan(plan(a, b)), ["part a.scope: overlaps part b.scope without dependency ordering"]);
  assert.deepEqual(validatePlan(plan(a, { ...b, dependsOn: ["a"] })), []);
  assert.deepEqual(validatePlan(plan({ ...a, dependsOn: ["b"] }, b)), []);
});

test("uses requires a provider in the transitive dependencies", () => {
  const a = part("a", { uses: ["API"] });
  const error = ["part a.uses: API has no provider reachable through dependsOn"];
  assert.deepEqual(validatePlan(plan(a)), error);
  assert.deepEqual(validatePlan(plan(a, part("b", { provides: ["API"] }))), error);
  assert.deepEqual(validatePlan(plan({ ...a, provides: ["API"] })), error);
  assert.deepEqual(validatePlan(plan(a, part("b", { provides: ["API"], dependsOn: ["a"] }))), error);
});

test("interfaces depend only on interfaces", () => {
  const a = part("a", { kind: "interface", dependsOn: ["b"] });
  assert.deepEqual(validatePlan(plan(a, part("b"))), ["part a.dependsOn: interface parts may depend only on interface parts (b)"]);
  assert.deepEqual(validatePlan(plan(a, part("b", { kind: "interface" }))), []);
});

test("duplicate dependency edges do not create a cycle and validation does not mutate", () => {
  const input = plan(part("a", { dependsOn: ["b", "b"], size: "M" }), part("b"));
  const before = structuredClone(input);
  assert.deepEqual(validatePlan(input), []);
  assert.deepEqual(input, before);
});
