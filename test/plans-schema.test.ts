import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { parsePlan, planHash, PLAN_LIMITS, type Plan } from "../src/plans/schema.ts";
import { PLAN_ERROR_LIMIT } from "../src/plans/errors.ts";

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
  ["acceptance empty", { acceptance: [] }, "part api.acceptance: must contain at least one criterion"],
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

const textFields = ["goal", "title", "brief", "prefer.actor", "prefer.reason", "scope", "dependsOn", "provides", "uses", "acceptance", "tests"] as const;
const listFields = ["scope", "dependsOn", "provides", "uses", "acceptance", "tests"] as const;
function withText(field: string, value: unknown) {
  const input = { ...document(), parts: [{ ...part(), prefer: { actor: "codex/model", reason: "Fit" } }] };
  if (field === "goal" || field === "schema") return { ...input, [field]: value };
  if (field.startsWith("prefer.")) return { ...input, parts: [{ ...input.parts[0], prefer: { ...input.parts[0].prefer, [field.slice(7)]: value } }] };
  return { ...input, parts: [{ ...input.parts[0], [field]: value }] };
}
function readText(plan: Plan, field: string): unknown {
  if (field === "goal") return plan.goal;
  if (field.startsWith("prefer.")) return plan.parts[0].prefer![field.slice(7) as "actor" | "reason"];
  return plan.parts[0][field as keyof Plan["parts"][number]];
}

for (const control of ["\u202e", "\u200b", "\u00ad", "\u061c", "\ufeff", "\u2067", "\u034f", "\u{e0100}"]) {
  for (const field of textFields) test(`cleans ${JSON.stringify(control)} in ${field} and refuses it alone`, () => {
    const isList = listFields.includes(field as typeof listFields[number]);
    const value = `a${control}b`;
    const result = parsePlan(withText(field, isList ? [value] : value));
    assert.ok(result.ok);
    assert.deepEqual(readText(result.plan, field), isList ? ["a b"] : "a b");
    const empty = parsePlan(withText(field, isList ? [control] : control));
    assert.ok(!empty.ok);
    assert.ok(empty.errors.some((error) => error.includes(`${field}${isList ? "[0]" : ""}: must be a non-empty string`)));
  });
  test(`cleans ${JSON.stringify(control)} around size and refuses it alone`, () => {
    const result = parsePlan(withText("size", `${control}S${control}`));
    assert.ok(result.ok);
    assert.equal(result.plan.parts[0].size, "S");
    assert.ok(!parsePlan(withText("size", control)).ok);
  });
  for (const field of ["key", "schema", "kind", "taskKind"]) test(`refuses embedded ${JSON.stringify(control)} in ${field}`, () => {
    const original = field === "schema" ? "atelier.plan.v1" : part()[field as keyof ReturnType<typeof part>] as string;
    const result = parsePlan(withText(field, original.slice(0, 1) + control + original.slice(1)));
    assert.ok(!result.ok);
    assert.ok(result.errors.some((error) => error.includes(`.${field}:`)));
    assert.ok(!parsePlan(withText(field, control)).ok);
  });
}

for (const key of ["\u200b\u200b", "a_b", "a/b", "a b", "café"]) test(`refuses non-identifier key ${JSON.stringify(key)}`, () => {
  const result = parsePlan(withText("key", key));
  assert.ok(!result.ok);
  assert.ok(result.errors.some((error) => error.includes(".key: must be a non-empty string") || error.includes("letters (A-Z, a-z), digits (0-9) and hyphens")));
});

test("accepts letters, digits and hyphens in a key", () => {
  assert.ok(parsePlan(withText("key", "API-v2")).ok);
});

for (const field of ["goal", "title", "key", "brief", "prefer.actor", "prefer.reason"]) test(`${field} length boundary`, () => {
  const limit = PLAN_LIMITS[field.replace("prefer.", "") as "goal" | "title" | "key" | "brief" | "actor" | "reason"];
  assert.ok(parsePlan(withText(field, "a".repeat(limit))).ok);
  const result = parsePlan(withText(field, "a".repeat(limit + 1)));
  assert.ok(!result.ok);
  assert.ok(result.errors.some((error) => error.endsWith(`.${field}: must contain at most ${limit} characters`)));
});
for (const field of listFields) {
  test(`${field} list length boundary`, () => {
    const limit = PLAN_LIMITS[field].count;
    assert.ok(parsePlan(withText(field, Array(limit).fill("a"))).ok);
    const result = parsePlan(withText(field, Array(limit + 1).fill("a")));
    assert.ok(!result.ok);
    assert.ok(result.errors.includes(`part api.${field}: must contain at most ${limit} ${field === "scope" ? "globs" : "entries"}`));
  });
  test(`${field} entry length boundary`, () => {
    const limit = PLAN_LIMITS[field].entry;
    assert.ok(parsePlan(withText(field, ["a".repeat(limit)])).ok);
    const result = parsePlan(withText(field, ["a".repeat(limit + 1)]));
    assert.ok(!result.ok);
    assert.ok(result.errors.includes(`part api.${field}[0]: must contain at most ${limit} characters`));
  });
}

test("refuses a plan with no parts", () => {
  assert.deepEqual(parsePlan({ ...document(), parts: [] }), { ok: false, errors: ["plan.parts: must contain at least one part"] });
});

test("normalizes every free text field before validation and hashing", async () => {
  for (const field of textFields) {
    const isList = listFields.includes(field as typeof listFields[number]);
    const nfc = withText(field, isList ? ["café"] : "café");
    const nfd = withText(field, isList ? ["cafe\u0301"] : "cafe\u0301");
    assert.deepEqual(parsePlan(nfd), parsePlan(nfc));
    assert.equal(await planHash(nfd as Plan), await planHash(nfc as Plan));
  }
  assert.ok(parsePlan(withText("title", "e\u0301".repeat(PLAN_LIMITS.title))).ok);
});

for (const field of [...listFields, "parts"] as const) test(`${field} stops at the cap on a large array`, () => {
  const cap = field === "parts" ? PLAN_LIMITS.parts : PLAN_LIMITS[field].count;
  const entries = Array(100_000).fill(null);
  Object.defineProperty(entries, cap, { get() { throw new Error("read past cap"); } });
  const input = field === "parts" ? { ...document(), parts: entries } : withText(field, entries);
  const start = performance.now();
  const result = parsePlan(input);
  assert.ok(performance.now() - start < 1000, "parsing must finish within one second");
  assert.ok(!result.ok);
  assert.equal(result.errors.length, cap + 1);
  assert.equal(result.errors.filter((error) => error.includes("must contain at most")).length, 1);
});

test("long part keys and unknown field names have short diagnostics", () => {
  const key = "k".repeat(20_000);
  const field = "f".repeat(20_000);
  const result = parsePlan({ ...document(), [field]: true, parts: [{
    ...part(), key, [field]: true, tests: Array(100_000).fill(null),
    prefer: { actor: "a", reason: "r", [field]: true },
  }] });
  assert.ok(!result.ok);
  assert.ok(result.errors.every((error) => error.length < 250));
  assert.ok(result.errors.some((error) => error.startsWith(`part ${"k".repeat(79)}….key:`)));
  assert.ok(result.errors.some((error) => error.startsWith(`plan.${"f".repeat(79)}…:`)));
  assert.ok(result.errors.length < PLAN_ERROR_LIMIT);
});

test("unknown fields preserve distinctions hidden by cleaning", () => {
  const fields = ["", " ", "\u200b", "\u202e", "a b", "a\u200bb", "\\u{200b}", "é", "e\u0301"];
  const result = parsePlan({ ...document(), ...Object.fromEntries(fields.map((field) => [field, true])) });
  assert.ok(!result.ok);
  assert.equal(new Set(result.errors).size, fields.length);
  assert.ok(result.errors.includes('plan["\\u{200b}"]: unknown field'));
  assert.ok(result.errors.includes('plan["\\u{202e}"]: unknown field'));
  assert.ok(result.errors.includes('plan[""]: unknown field'));
  assert.ok(result.errors.every((error) => !error.includes("plan.:")));
});

for (const count of [49, 50, 51, 100_000]) test(`caps ${count} unknown field errors including early returns`, () => {
  const extra = Object.fromEntries(Array.from({ length: count }, (_, i) => [`extra${i}`, true]));
  for (const parts of [[part()], null]) {
    const result = parsePlan({ ...document(), ...extra, parts });
    assert.ok(!result.ok);
    const total = count + (parts === null ? 1 : 0);
    assert.equal(result.errors.length, Math.min(total, PLAN_ERROR_LIMIT));
    assert.equal(result.errors[0], "plan.extra0: unknown field");
    if (total > PLAN_ERROR_LIMIT) assert.equal(result.errors.at(-1), `and ${total - 49} more errors`);
    else assert.ok(!result.errors.at(-1)!.startsWith("and "));
  }
});
