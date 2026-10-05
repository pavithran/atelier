import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { parsePlan, planHash } from "../src/plans/schema.ts";

const part = () => ({ key: "api", title: "API", kind: "interface", taskKind: "feature", scope: ["src/api.ts"], dependsOn: [], provides: ["API"], uses: [], brief: "Define API", acceptance: ["Typed"], tests: [], size: "S" });
const document = () => ({ schema: "atelier.plan.v1", goal: "Build a feature", parts: [part()] });

test("parses a plan and cleans strings without mutating the input", () => {
  const input = document();
  input.parts[0].title = " API\u0000\u0085title ";
  const result = parsePlan(input);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.parts[0].title, "API  title");
  assert.equal(input.parts[0].title, " API\u0000\u0085title ");
});

const refusals: [string, unknown, string][] = [
  ["object", null, "plan: must be an object"],
  ["schema", { ...document(), schema: "v2" }, "plan.schema: must be one of atelier.plan.v1"],
  ["goal", { ...document(), goal: "\u0000" }, "plan.goal: must be a non-empty string"],
  ["unknown root", { ...document(), extra: true }, "plan.extra: unknown field"],
  ["parts array", { ...document(), parts: {} }, "plan.parts: must be an array"],
  ["part object", { ...document(), parts: [null] }, "part[0]: must be an object"],
  ["part cap", { ...document(), parts: Array.from({ length: 13 }, part) }, "plan.parts: must contain at most 12 parts"],
];
for (const [name, change, error] of [
  ["unknown part", { extra: true }, "part api.extra: unknown field"],
  ["key", { key: null }, "part[0].key: must be a non-empty string"],
  ["title", { title: 1 }, "part api.title: must be a non-empty string"],
  ["kind", { kind: "task" }, "part api.kind: must be one of interface, build, tests, docs"],
  ["task kind", { taskKind: "general" }, "part api.taskKind: must be one of mechanical-edit, feature, refactor, tests, docs, ui, research"],
  ["scope empty", { scope: [] }, "part api.scope: must contain at least one glob"],
  ["scope cap", { scope: Array(7).fill("src/**") }, "part api.scope: must contain at most 6 globs"],
  ["brief empty", { brief: "" }, "part api.brief: must be a non-empty string"],
  ["brief cap", { brief: "a".repeat(2001) }, "part api.brief: must contain at most 2000 characters"],
  ["size", { size: "L" }, "part api.size: must be one of S, M"],
  ["prefer object", { prefer: null }, "part api.prefer: must be an object"],
  ["prefer unknown", { prefer: { actor: "codex/model", reason: "Fit", extra: 1 } }, "part api.prefer.extra: unknown field"],
  ["prefer actor", { prefer: { reason: "Fit" } }, "part api.prefer.actor: must be a non-empty string"],
  ["prefer reason", { prefer: { actor: "codex/model" } }, "part api.prefer.reason: must be a non-empty string"],
] as [string, object, string][]) refusals.push([name, { ...document(), parts: [{ ...part(), ...change }] }, error]);
for (const field of ["scope", "dependsOn", "provides", "uses", "acceptance", "tests"]) {
  refusals.push([`${field} array`, { ...document(), parts: [{ ...part(), [field]: null }] }, `part api.${field}: must be an array of strings`]);
  refusals.push([`${field} entry`, { ...document(), parts: [{ ...part(), [field]: [false] }] }, `part api.${field}[0]: must be a non-empty string`]);
}
for (const [name, input, error] of refusals) test(`refuses ${name}`, () => {
  const result = parsePlan(input);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.includes(error), JSON.stringify(result.errors));
});

test("accepts cap boundaries and optional preference", () => {
  const result = parsePlan({ ...document(), parts: Array.from({ length: 12 }, (_, i) => ({
    ...part(), key: `p${i}`, scope: Array(6).fill("src/**"), brief: "a".repeat(2000), size: "M",
    prefer: { actor: " codex/model\u007f", reason: "Fits\nwell" },
  })) });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.plan.parts[0].prefer, { actor: "codex/model", reason: "Fits well" });
});

test("hash is SHA-256 with recursively sorted object keys", async () => {
  const parsed = parsePlan({ ...document(), parts: [{ ...part(), prefer: { actor: "codex/model", reason: "Fit" } }] });
  assert.ok(parsed.ok);
  const sorted = (value: any): any => Array.isArray(value) ? value.map(sorted) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value;
  const reversed = (value: any): any => Array.isArray(value) ? value.map(reversed) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, v]) => [key, reversed(v)])) : value;
  const hash = await planHash(parsed.plan);
  assert.equal(hash, createHash("sha256").update(JSON.stringify(sorted(parsed.plan))).digest("hex"));
  assert.equal(await planHash(reversed(parsed.plan)), hash);
  assert.notEqual(await planHash({ ...parsed.plan, goal: "Another goal" }), hash);
});
