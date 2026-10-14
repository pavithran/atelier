// Tests keep their scratch folders under the system temp folder (t640).
// Finding this guard catches: tests wrote scratch folders into the checkout
// (.cache/…, .scratch/…, hidden mkdtemp prefixes beside the sources); found
// 2026-10-13. They were left behind in the working tree and, while the
// checkout lived in iCloud, kept its sync busy. Every scratch path now comes
// from os.tmpdir(), and each test removes its own folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discover } from "./suites.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const self = relative(root, fileURLToPath(import.meta.url));

// Each pattern is a way a test made a folder in the working directory, which
// is the checkout when the suite runs.
const PATTERNS = [
  { name: "a temp folder made relative to the working directory",
    re: /mkdtemp(?:Sync)?\(\s*(?:resolve\(|join\(\s*process\.cwd\(\)|["'`](?!\/))/ },
  { name: "a hidden temp-folder prefix, the in-checkout scratch idiom",
    re: /mkdtemp(?:Sync)?\(\s*join\([^,()]+,\s*["'`]\./ },
  // A hidden folder only: generator scripts the tests write into their temp
  // repositories make plain relative folders (out/) there, which is fine.
  { name: "a hidden folder made relative to the working directory",
    re: /mkdirSync\(\s*(?:resolve\(\s*|join\(\s*process\.cwd\(\),\s*)?["'`]\./ },
  { name: "a .cache or .scratch path in the working directory",
    re: /(?:resolve\(|join\(\s*process\.cwd\(\),)\s*["'`]\.(?:cache|scratch|tmp)\b/ },
];

// Every test file discovery finds, and every other source under test/
// (helpers and fixture builders the tests share).
function sources() {
  const listed = spawnSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "test"], { encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  const helpers = listed.stdout.split("\0").filter((f) => /\.(mjs|js|ts)$/.test(f));
  return [...new Set([...discover(root), ...helpers])].filter((f) => f !== self).sort();
}

function offences(text) {
  const found = [];
  text.split("\n").forEach((line, i) => {
    for (const { name, re } of PATTERNS) if (re.test(line)) found.push({ line: i + 1, name, text: line.trim() });
  });
  return found;
}

test("no test makes a scratch folder inside the checkout; scratch comes from os.tmpdir()", () => {
  const files = sources();
  assert.ok(files.includes("test/land-fixture.mjs") && files.includes("cli/runner-token.test.mjs") && files.includes("bin/orchestrate/post-merge.test.mjs"), "the scan covers test helpers, cli/ tests and bin/ tests");
  const found = files.flatMap((file) => offences(readFileSync(resolve(root, file), "utf8")).map((o) => `${file}:${o.line}: ${o.name}: ${o.text}`));
  assert.deepEqual(found, [], `make these under os.tmpdir() and remove them after the test:\n${found.join("\n")}`);
});

test("the guard recognises each form the old tests used", () => {
  for (const line of [
    `const dir = mkdtempSync(resolve(".cache/init-test-"));`,
    `const root = mkdtempSync(join(process.cwd(), ".show-test-"));`,
    `const dir = mkdtempSync(resolve(".test-wait-"));`,
    `const dir = mkdtempSync(join(root, '.scratch-orchestrate-'));`,
    `mkdirSync(".cache", { recursive: true });`,
    `mkdirSync(resolve(".cache"), { recursive: true });`,
    `const root = resolve(".cache/runner-token-tests");`,
    `const scratch = resolve(".scratch"); mkdirSync(scratch, { recursive: true });`,
  ]) assert.notDeepEqual(offences(line), [], line);
  for (const line of [
    `const dir = mkdtempSync(join(tmpdir(), "atelier-init-test-"));`,
    `const dir = mkdtempSync(join(root, "case-"));`,
    `mkdirSync(join(dir, ".scratch"));`,
    `writeFileSync(join(dir, ".gitattributes"), readFileSync(resolve(".gitattributes")));`,
  ]) assert.deepEqual(offences(line), [], line);
});
