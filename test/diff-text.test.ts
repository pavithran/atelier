import { test } from "node:test";
import assert from "node:assert/strict";
import { LIMITS, renderDiffText, type ItemDiff } from "../src/diff.ts";

// The diff text a review too large for its brief leaves in R2 (t284),
// rendered in git's shape: every changed file keeps its place, whatever
// Artifacts could do with it, so the record lists the whole change.

const H0 = "0".repeat(40), H2 = "b".repeat(40);

const diff: ItemDiff = {
  base: H0, head: H2, truncated: false,
  files: [
    {
      path: "src/review/needed.ts", status: "modified", added: 1, removed: 1,
      hunks: [{
        oldStart: 3, oldLines: 2, newStart: 3, newLines: 2,
        lines: [{ op: " ", text: "kept" }, { op: "-", text: "the old line" }, { op: "+", text: "the new line" }],
      }],
    },
    { path: "bin/new.sh", status: "added", added: 1, removed: 0, hunks: [] },
    { path: "old.ts", status: "deleted", added: 0, removed: 2, hunks: [] },
    { path: "logo.png", status: "binary", added: 0, removed: 0, hunks: [] },
    { path: "big.dat", status: "too-large", added: 0, removed: 0, hunks: [] },
    { path: "vendor/lib", status: "submodule", added: 0, removed: 0, hunks: [] },
    { path: "run.sh", status: "mode", added: 0, removed: 0, hunks: [] },
  ],
};

test("renderDiffText: git's shape, with a header naming the item, base and head", () => {
  const text = renderDiffText("t41", diff);
  assert.equal(text.split("\n")[0], `# diff of t41 from ${H0} (base) to ${H2} (head), as Atelier read it from Artifacts`);
  assert.deepEqual(text.split("\n").slice(1, 9), [
    "diff --git a/src/review/needed.ts b/src/review/needed.ts",
    "@@ -3,2 +3,2 @@",
    " kept",
    "-the old line",
    "+the new line",
    "diff --git a/bin/new.sh b/bin/new.sh",
    "new file",
    "diff --git a/old.ts b/old.ts",
  ]);
  assert.ok(text.includes("deleted file"));
  assert.ok(text.includes("Binary files differ"));
  assert.ok(text.includes(`File too large to diff here (over ${LIMITS.diffLines} lines or ${LIMITS.blobBytes} bytes)`));
  assert.ok(text.includes("Submodule"));
  assert.ok(text.includes("mode changed"));
  assert.ok(!text.includes("# only the first"));
});

test("renderDiffText: says when more changed files are not listed", () => {
  const text = renderDiffText("t41", { ...diff, truncated: true });
  assert.ok(text.endsWith(`# only the first ${LIMITS.files} changed files are listed; more are not`));
});

test("renderDiffText: a change with no files is the header alone", () => {
  const text = renderDiffText("t41", { base: H0, head: H2, files: [], truncated: false });
  assert.equal(text, `# diff of t41 from ${H0} (base) to ${H2} (head), as Atelier read it from Artifacts`);
});
