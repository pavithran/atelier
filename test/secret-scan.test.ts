import { test } from "node:test";
import assert from "node:assert/strict";
import { treeDiff, type Entry, type Reader } from "../src/diff.ts";
import { fingerprint, scanLine, scanTrees, type PushScan, type SecretHit } from "../src/secret-scan.ts";

// The secret scanner (t332), driven with obviously fake keys so no real value
// ever appears in a fixture. It reports file and line, never the value.

// A tiny content-addressed store, as the pure diff tests use: blobs and trees
// by hash, answered through a Reader. The scan reads these trees itself
// (scanTrees), never a display diff of them.
function store() {
  const trees = new Map<string, Entry[]>();
  const blobs = new Map<string, Uint8Array>();
  let n = 0;
  const bytes = (content: Uint8Array) => {
    const h = `blob${n++}`;
    blobs.set(h, content);
    return h;
  };
  const blob = (text: string) => bytes(new TextEncoder().encode(text));
  const tree = (entries: Record<string, { blob?: string; tree?: string; mode?: string }>) => {
    const h = `tree${n++}`;
    trees.set(h, Object.entries(entries).map(([name, e]) => ({
      name, mode: e.mode ?? (e.tree ? "40000" : "100644"), hash: (e.tree ?? e.blob)!, type: e.tree ? "tree" : "blob",
    })));
    return h;
  };
  const reader: Reader = { tree: async (h) => trees.get(h) ?? null, blob: async (h) => blobs.get(h) ?? null };
  return { blob, bytes, tree, reader };
}

// The hits of a push that changes one file from `before` to `after` (an
// addition when `before` is empty).
async function scanOne(path: string, before: string, after: string): Promise<SecretHit[]> {
  const s = store();
  const base = s.tree(before === "" ? {} : { [path]: { blob: s.blob(before) } });
  const { hits, unscanned } = await scanTrees(s.reader, base, s.tree({ [path]: { blob: s.blob(after) } }));
  assert.deepEqual(unscanned, []);
  return hits;
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

test("a known API key on an added line reports its file and line, never the value", async () => {
  const hits = await scanOne("src/keys.ts", "const key = \"\";\n", `const key = "${FAKE.openai}";\n`);
  assert.deepEqual(hits, [{ file: "src/keys.ts", line: 1, fingerprint: await fingerprint(`const key = "${FAKE.openai}";`) }]);
  // The value never appears in the result, even when it was the whole match:
  // the fingerprint is a hex digest of the line, not the line.
  const serialized = JSON.stringify(hits);
  assert.ok(!serialized.includes("sk-proj-"), serialized);
  assert.ok(!serialized.includes("bbbbbb"), serialized);
  assert.match(hits[0].fingerprint, /^[0-9a-f]{64}$/);
});

test("the fingerprint follows the line's content, not its position or its surrounding whitespace", async () => {
  const line = `const key = "${FAKE.openai}";`;
  const atTop = await scanOne("src/keys.ts", "", `${line}\nrest\n`);
  const moved = await scanOne("src/keys.ts", "", `one\ntwo\n  ${line}  \n`);
  assert.equal(atTop[0].line, 1);
  assert.equal(moved[0].line, 3);
  assert.equal(atTop[0].fingerprint, moved[0].fingerprint);
  // One character changed is another fingerprint.
  const changed = await scanOne("src/keys.ts", "", `const key = "${FAKE.openai}x";\n`);
  assert.notEqual(changed[0].fingerprint, atTop[0].fingerprint);
  // The fingerprint of a line is the same whichever file it is in; the
  // Ledger matches a clearance by file and fingerprint together.
  const elsewhere = await scanOne("src/other.ts", "", `${line}\n`);
  assert.equal(elsewhere[0].fingerprint, atTop[0].fingerprint);
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

test("a .env-style assignment whose value carries base64 padding is matched", () => {
  // Built at run time so this file holds no key-shaped literal.
  const padded = ["Zm9v", "YmFy".repeat(12), "=="].join("");
  assert.ok(scanLine(`SERVICE_SECRET=${padded}`));
  assert.ok(scanLine(`SERVICE_SECRET="${padded}"`));
  assert.ok(scanLine(`SERVICE_SECRET=${padded.slice(0, -1)}`));
  assert.ok(!scanLine("PORT==8080"));
});

test("every .env form that parses to a long secret is matched", async () => {
  // Each line is checked against Node's own .env parser first, so the test
  // proves a real assignment of the secret and not a near miss.
  const { parseEnv } = await import("node:util");
  const padded = ["Zm9v", "YmFy".repeat(12), "=="].join("");
  const forms = [
    `SERVICE_SECRET=${padded}`,
    `export SERVICE_SECRET=${padded}`,
    `export\tSERVICE_SECRET=${padded}`,
    `SERVICE_SECRET=${padded} # rotated monthly`,
    `SERVICE_SECRET=${padded}#nospace`,
    `SERVICE_SECRET = ${padded}`,
    `SERVICE_SECRET="${padded}" # quoted, then a comment`,
    `SERVICE_SECRET='${padded}'`,
    `SERVICE_SECRET=\`${padded}\``,
    `export SERVICE_SECRET="${padded}"   # both`,
    `  SERVICE_SECRET=${padded}  `,
  ];
  let checked = 0;
  for (const line of forms) {
    const parsed = parseEnv(line) as Record<string, string>;
    if (parsed.SERVICE_SECRET !== padded) continue; // not a form Node reads as this value
    checked++;
    assert.ok(scanLine(line), `missed: ${line.replace(padded, "<secret>")}`);
  }
  assert.ok(checked >= 10, `only ${checked} forms parsed as the secret`);
  assert.ok(!scanLine("export NODE_ENV=production # default"));
  assert.ok(!scanLine("API_KEY=your_key_here # fill in"));
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

test("the line number is the new file's, after removed lines", async () => {
  const before = "one\nold secret\nthree\n";
  const withSecret = await scanOne("src/a.ts", before, `one\n${FAKE.aws}\nthree\n`);
  assert.deepEqual(withSecret.map(({ file, line }) => ({ file, line })), [{ file: "src/a.ts", line: 2 }]);
  assert.deepEqual(await scanOne("src/a.ts", before, "one\ntwo\nthree\n"), []);
});

test("a push whose added lines hold none of the patterns records no flag", async () => {
  const hits = await scanOne("src/app.ts", "let x = 1;\n", "let x = 2;\nconst name = \"atelier\";\nconst color = \"#123456\";\nconst url = \"https://example.com\";\n");
  assert.deepEqual(hits, []);
});

test("only added lines are scanned, not context or removed lines", async () => {
  const before = `keep\n${FAKE.google}\nlast\n`;
  const after = "keep\nlast\n";
  assert.deepEqual(await scanOne("src/k.ts", before, after), []); // the key was removed, not added
});

const fullScan = (s: ReturnType<typeof store>, base: string, head: string): Promise<PushScan> => scanTrees(s.reader, base, head);
const where = (scan: PushScan) => scan.hits.map(({ file, line }) => ({ file, line }));

test("a fake key in an added file over 256 KiB is found, though the display diff omits it", async () => {
  const s = store();
  const big = "x".repeat(300 * 1024) + `\nconst key = "${FAKE.openai}";\n`;
  const scan = await fullScan(s, s.tree({}), s.tree({ "big.ts": { blob: s.blob(big) } }));
  assert.deepEqual(where(scan), [{ file: "big.ts", line: 2 }]);
});

test("a fake key in the 61st added file is found, though the display diff truncates it", async () => {
  const s = store();
  const entries: Record<string, { blob: string }> = {};
  for (let i = 0; i < 60; i++) entries[`f${String(i).padStart(2, "0")}.ts`] = { blob: s.blob("export {}\n") };
  entries["f60.ts"] = { blob: s.blob(`const key = "${FAKE.openai}";\n`) };
  const scan = await fullScan(s, s.tree({}), s.tree(entries));
  assert.deepEqual(where(scan), [{ file: "f60.ts", line: 1 }]);
});

test("a modified file too large to diff is reported unscanned, never passed silently", async () => {
  const s = store();
  const left = Array.from({ length: 6_000 }, (_, i) => `l${i}`).join("\n") + "\n";
  const right = Array.from({ length: 6_000 }, (_, i) => `r${i}`).join("\n") + "\n";
  const after = s.blob(right);
  const { hits, unscanned } = await fullScan(s, s.tree({ "huge.ts": { blob: s.blob(left) } }), s.tree({ "huge.ts": { blob: after } }));
  assert.deepEqual(hits, []);
  // The file is fingerprinted by its content's hash, so a clearance of it
  // holds while it is unchanged and no more.
  assert.deepEqual(unscanned, [{ file: "huge.ts", fingerprint: after, reason: "a text diff over the memory budget" }]);
});

// The scan reads through strictReader: an object the head or base names and
// neither repository holds throws, so the scan is retried later rather than
// made from a diff that reads the hole as empty content.
test("a missing blob fails the scan rather than reading as a file with no added lines", async () => {
  const s = store();
  const head = s.tree({ "keys.ts": { blob: "blob-missing" } });
  await assert.rejects(fullScan(s, s.tree({}), head), /secret scan: blob blob-mis is missing/);
});

test("a missing tree fails the scan rather than reading as a directory with no changes", async () => {
  const s = store();
  const head = s.tree({ src: { tree: "tree-missing" } });
  await assert.rejects(fullScan(s, s.tree({}), head), /secret scan: tree tree-mis is missing/);
  // The display diff keeps reading a missing object as nothing, so a page
  // still renders what can be shown; only the scan path is strict.
  const { files } = await treeDiff(s.reader, s.tree({}), head);
  assert.deepEqual(files, []);
});
