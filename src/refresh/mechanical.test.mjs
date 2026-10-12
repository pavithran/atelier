// Mechanical conflict resolution (t462, src/refresh/mechanical.ts): each
// documented fixture is classified as its index says, a mechanical one is
// resolved to its resolution file, a resolver's file is verified against
// the transformations, and the report a conflict goes back to the builder
// with names the heads, paths and hunks, cut to its limits.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { classifyConflicts, classifyFile, conflictReport, parseReport, reportText, resolveFile, TRANSFORMATIONS, verifyResolution, REPORT_LIMITS } from "./mechanical.ts";

const dir = new URL("./fixtures/", import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), "utf8");
const fixtures = JSON.parse(read("index.json"));
const both = { stages: [1, 2, 3] };
const A = "a".repeat(40), B = "b".repeat(40), M = "c".repeat(40);

test("every transformation is documented by a fixture, and every fixture is listed in the README", () => {
  const readme = read("README.md");
  for (const t of TRANSFORMATIONS) assert.ok(fixtures.some((f) => f.transformation === t.id), `no fixture shows ${t.id}`);
  for (const f of fixtures) assert.match(readme, new RegExp(`\\| ${f.name} \\| ${f.kind} \\|`));
});

for (const f of fixtures) {
  test(`fixture ${f.name} is ${f.kind}${f.transformation ? ` by ${f.transformation}` : ""}`, () => {
    const text = read(`${f.name}.conflicted.txt`);
    const file = classifyFile({ path: `${f.name}.ts`, text, ...both });
    assert.equal(file.kind, f.kind, file.why);
    if (f.kind !== "mechanical") {
      assert.equal(resolveFile(text), null);
      assert.ok(verifyResolution(text, text.replace(/^[<|=>]{7}.*\n/gm, "")), "a non-mechanical conflict never verifies");
      return;
    }
    assert.ok(file.hunks.every((h) => h.transformation === f.transformation));
    const resolved = read(`${f.name}.resolved.txt`);
    assert.equal(resolveFile(text), resolved);
    assert.equal(verifyResolution(text, resolved), null);
  });
}

test("a resolution that changes a context line, keeps a marker, adds a line or picks the wrong side is refused", () => {
  const text = read("one-sided.conflicted.txt");
  const good = read("one-sided.resolved.txt");
  assert.match(verifyResolution(text, good.replace("LIMIT = 10", "LIMIT = 11")), /context line/);
  assert.match(verifyResolution(text, good.replace('const NAME = "Atelier";', 'const NAME = "atelier";')), /one-sided/);
  assert.match(verifyResolution(text, `${good}// extra\n`), /more than its resolution allows/);
  assert.match(verifyResolution(text, good.slice(0, -1)), /final newline/);
  assert.ok(verifyResolution(text, text));
});

test("an import union may order the added imports anywhere among the base lines, but keeps the base order and adds nothing", () => {
  const text = read("import-union.conflicted.txt");
  const reordered = 'import { main } from "./main.ts";\nimport { a } from "./a.ts";\nimport { b } from "./b.ts";\nimport { task } from "./task.ts";\n\nexport const all = [a, b];\n';
  assert.equal(verifyResolution(text, reordered), null);
  const swapped = 'import { b } from "./b.ts";\nimport { a } from "./a.ts";\nimport { task } from "./task.ts";\nimport { main } from "./main.ts";\n\nexport const all = [a, b];\n';
  assert.match(verifyResolution(text, swapped), /import-union/);
  const dropped = 'import { a } from "./a.ts";\nimport { b } from "./b.ts";\nimport { main } from "./main.ts";\n\n\nexport const all = [a, b];\n';
  assert.ok(verifyResolution(text, dropped));
});

test("a file one side deleted, or that is not text, is uncertain; a refresh is as bad as its worst file", () => {
  assert.equal(classifyFile({ path: "gone.ts", text: "x\n", stages: [1, 2] }).kind, "uncertain");
  assert.match(classifyFile({ path: "gone.ts", text: "x\n", stages: [1, 3] }).why, /task deleted/);
  assert.equal(classifyFile({ path: "bin.png", text: "a\0b", ...both }).kind, "uncertain");
  assert.equal(classifyFile({ path: "plain.ts", text: "no markers\n", ...both }).kind, "uncertain");
  const mixed = classifyConflicts([
    { path: "a.ts", text: read("one-sided.conflicted.txt"), ...both },
    { path: "b.ts", text: read("behavioural.conflicted.txt"), ...both },
  ]);
  assert.equal(mixed.kind, "behavioural");
  assert.equal(classifyConflicts([...mixed.files.map((f) => ({ path: f.path, text: read("one-sided.conflicted.txt"), ...both })), { path: "c.ts", text: read("no-base.conflicted.txt"), ...both }]).kind, "uncertain");
  assert.equal(classifyConflicts([]).kind, "uncertain");
});

test("the report back to the builder names the merge base, both heads, the paths and the hunks, and reads back", () => {
  const { files } = classifyConflicts([{ path: "src/limit.ts", text: read("behavioural.conflicted.txt"), ...both }]);
  const report = conflictReport({ base: A, head: B, main: M }, files);
  assert.deepEqual([report.base, report.head, report.main, report.kind], [A, B, M, "behavioural"]);
  assert.deepEqual(report.files[0].hunks[0], { line: 2, kind: "behavioural", why: report.files[0].hunks[0].why, ours: ["  return 20;"], base: ["  return 10;"], theirs: ["  return 30;"] });
  assert.deepEqual(parseReport(JSON.parse(JSON.stringify(report))), report);
  const text = reportText(report);
  for (const part of ["src/limit.ts", A.slice(0, 8), B.slice(0, 8), M.slice(0, 8), "return 20", "return 30", "||||||| base"]) assert.ok(text.includes(part), part);
  assert.match(parseReport({ ...report, head: "nope" }), /full hashes/);
  assert.match(parseReport({ ...report, files: [{ path: "x" }] }), /path, a kind/);
});

test("a report over its limits is cut, and says so", () => {
  const hunk = `<<<<<<< HEAD\n${"x\n".repeat(REPORT_LIMITS.lines + 5)}||||||| base\nb\n=======\ny\n>>>>>>> m\n`;
  const many = Array.from({ length: REPORT_LIMITS.files + 3 }, (_, i) => ({ path: `f${i}.ts`, text: hunk.repeat(3), ...both }));
  const report = conflictReport({ base: A, head: B, main: M }, classifyConflicts(many).files);
  assert.equal(report.cut, true);
  assert.ok(report.files.length <= REPORT_LIMITS.files);
  assert.ok(JSON.stringify(report).length <= REPORT_LIMITS.chars);
  assert.ok(report.files[0].hunks[0].ours.length <= REPORT_LIMITS.lines);
  assert.equal(typeof parseReport(report), "object");
});
