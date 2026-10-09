import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLines, SCAN_LIMITS, splitLines, toHunks, treeDiff, type Entry, type FileChange, type ItemDiff, type Reader } from "../src/diff.ts";
import { scanDiff, scanLine, scanPush, type SecretHit } from "../src/secret-scan.ts";

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

// A tiny content-addressed store for the tree-level scan tests, as the pure
// diff tests use: blobs and trees by hash, answered through a Reader.
function store() {
  const trees = new Map<string, Entry[]>();
  const blobs = new Map<string, Uint8Array>();
  let n = 0;
  const blob = (text: string) => {
    const h = `blob${n++}`;
    blobs.set(h, new TextEncoder().encode(text));
    return h;
  };
  const tree = (entries: Record<string, { blob?: string; tree?: string; mode?: string }>) => {
    const h = `tree${n++}`;
    trees.set(h, Object.entries(entries).map(([name, e]) => ({
      name, mode: e.mode ?? (e.tree ? "40000" : "100644"), hash: (e.tree ?? e.blob)!, type: e.tree ? "tree" : "blob",
    })));
    return h;
  };
  const reader: Reader = { tree: async (h) => trees.get(h) ?? null, blob: async (h) => blobs.get(h) ?? null };
  return { blob, tree, reader };
}

// The scan as the push routes run it: an uncapped tree diff read with
// SCAN_LIMITS, then scanPush. The display diff's cuts (60 files, 256 KiB)
// must not hide a key from the scan.
async function fullScan(s: ReturnType<typeof store>, base: string, head: string): Promise<{ hits: SecretHit[]; unscanned: string[] }> {
  const { files, truncated } = await treeDiff(s.reader, base, head, SCAN_LIMITS);
  return scanPush({ base: "b".repeat(40), head: "a".repeat(40), files, truncated });
}

test("a fake key in an added file over 256 KiB is found, though the display diff omits it", async () => {
  const s = store();
  const big = "x".repeat(300 * 1024) + `\nconst key = "${FAKE.openai}";\n`;
  const { hits } = await fullScan(s, s.tree({}), s.tree({ "big.ts": { blob: s.blob(big) } }));
  assert.deepEqual(hits, [{ file: "big.ts", line: 2 }]);
});

test("a fake key in the 61st added file is found, though the display diff truncates it", async () => {
  const s = store();
  const entries: Record<string, { blob: string }> = {};
  for (let i = 0; i < 60; i++) entries[`f${String(i).padStart(2, "0")}.ts`] = { blob: s.blob("export {}\n") };
  entries["f60.ts"] = { blob: s.blob(`const key = "${FAKE.openai}";\n`) };
  const { hits } = await fullScan(s, s.tree({}), s.tree(entries));
  assert.deepEqual(hits, [{ file: "f60.ts", line: 1 }]);
});

test("a modified file too large to diff is reported unscanned, never passed silently", async () => {
  const s = store();
  const left = Array.from({ length: 6_000 }, (_, i) => `l${i}`).join("\n") + "\n";
  const right = Array.from({ length: 6_000 }, (_, i) => `r${i}`).join("\n") + "\n";
  const { hits, unscanned } = await fullScan(s, s.tree({ "huge.ts": { blob: s.blob(left) } }), s.tree({ "huge.ts": { blob: s.blob(right) } }));
  assert.deepEqual(hits, []);
  assert.deepEqual(unscanned, ["huge.ts"]);
});
