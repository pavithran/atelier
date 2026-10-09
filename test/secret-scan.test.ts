import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLines, splitLines, toHunks, type FileChange, type ItemDiff } from "../src/diff.ts";
import { scanDiff, scanLine } from "../src/secret-scan.ts";

// The secret scanner (t332), driven with obviously fake keys so no real value
// ever appears in a fixture. It reports file and line, never the value.

// A diff with one file, built through the real line diff so the line numbers
// the scanner reports are the ones a reader sees in the diff.
function diff(path: string, before: string, after: string): ItemDiff {
  const a = splitLines(before), b = splitLines(after);
  const ops = diffLines(a, b)!;
  const file: FileChange = {
    path,
    status: before === "" ? "added" : "modified",
    added: ops.filter((o) => o.op === "+").length,
    removed: ops.filter((o) => o.op === "-").length,
    hunks: toHunks(ops),
  };
  return { base: "b".repeat(40), head: "a".repeat(40), files: [file], truncated: false };
}

// Obvious fake keys, each long enough to match but fabricated.
const FAKE = {
  google: `AIza${"a".repeat(35)}`,
  aws: `AKIA${"ABCDEFGHIJKLMNOP"}`,          // 16 uppercase letters
  github: `ghp_${"a".repeat(36)}`,
  openai: `sk-proj-${"b".repeat(24)}`,
  anthropic: `sk-ant-${"c".repeat(24)}`,
  stripe: `sk_live_${"d".repeat(24)}`,
  slack: `xoxb-${"e".repeat(24)}`,
};

test("a known API key on an added line reports its file and line, never the value", () => {
  const d = diff("src/keys.ts", "const key = \"\";\n", `const key = "${FAKE.openai}";\n`);
  assert.deepEqual(scanDiff(d), [{ file: "src/keys.ts", line: 1 }]);
  // The value never appears in the result, even when it was the whole match.
  const serialized = JSON.stringify(scanDiff(d));
  assert.ok(!serialized.includes("sk-proj-"), serialized);
  assert.ok(!serialized.includes("bbbbbb"), serialized);
});

test("each key family is matched, and a line is reported once", () => {
  const cases: [string, string][] = [
    ["google", FAKE.google],
    ["aws", FAKE.aws],
    ["github", FAKE.github],
    ["openai", FAKE.openai],
    ["anthropic", FAKE.anthropic],
    ["stripe", FAKE.stripe],
    ["slack", FAKE.slack],
  ];
  for (const [, key] of cases) assert.ok(scanLine(`apiKey: "${key}"`), key.slice(0, 8));
});

test("a private key block and a bearer token are matched", () => {
  assert.ok(scanLine("-----BEGIN RSA PRIVATE KEY-----"));
  assert.ok(scanLine("-----BEGIN OPENSSH PRIVATE KEY-----"));
  assert.ok(scanLine("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9"));
  assert.ok(scanLine("bearer abcdefghijklmnopqrstuvwxyz0123456789"));
});

test("a .env-style assignment of a long secret is matched, and a short one is not", () => {
  assert.ok(scanLine(`OPENAI_API_KEY=${FAKE.openai}`));
  assert.ok(scanLine(`SECRET=${"x".repeat(32)}`));
  assert.ok(scanLine(`anything=${"y".repeat(40)}`));       // very long, any name
  assert.ok(!scanLine("API_KEY=your_key_here"));
  assert.ok(!scanLine("NODE_ENV=production"));
  assert.ok(!scanLine("URL=https://example.com/a/b"));
  assert.ok(!scanLine("COLOR=#ff8800"));
  assert.ok(!scanLine("PORT=8080"));
});

test("the line number is the new file's, after removed lines", () => {
  const before = "one\nold secret\nthree\n";
  const withSecret = diff("src/a.ts", before, `one\n${FAKE.aws}\nthree\n`);
  assert.deepEqual(scanDiff(withSecret), [{ file: "src/a.ts", line: 2 }]);
  const clean = diff("src/a.ts", before, "one\ntwo\nthree\n");
  assert.deepEqual(scanDiff(clean), []);
});

test("a push whose added lines hold none of the patterns records no flag", () => {
  const d = diff("src/app.ts", "let x = 1;\n", "let x = 2;\nconst name = \"atelier\";\nconst color = \"#123456\";\nconst url = \"https://example.com\";\n");
  assert.deepEqual(scanDiff(d), []);
});

test("only added lines are scanned, not context or removed lines", () => {
  const before = `keep\n${FAKE.google}\nlast\n`;
  const after = "keep\nlast\n";
  const d = diff("src/k.ts", before, after);
  assert.deepEqual(scanDiff(d), []); // the key was removed, not added
});
