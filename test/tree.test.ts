import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Entry, Reader } from "../src/diff.ts";
import { END_OF_ARCHIVE } from "../src/sandbox/tar.ts";
import { writeTree } from "../src/sandbox/tree.ts";

test("an Artifacts-shaped tree streams into tar with modes, symlinks and nesting intact", async () => {
  const trees = new Map<string, Entry[]>();
  const blobs = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  const blob = (h: string, t: string) => (blobs.set(h, enc.encode(t)), h);
  trees.set("root", [
    { name: "package.json", mode: "100644", hash: blob("b1", '{"name":"x"}\n'), type: "blob" },
    { name: "run.sh", mode: "100755", hash: blob("b2", "#!/bin/sh\necho hi\n"), type: "exec" },
    { name: "latest", mode: "120000", hash: blob("b3", "src/index.ts"), type: "symlink" },
    { name: "vendor", mode: "160000", hash: "c0ffee", type: "gitlink" },
    { name: "src", mode: "40000", hash: "srctree", type: "tree" },
  ]);
  trees.set("srctree", [{ name: "index.ts", mode: "100644", hash: blob("b4", "export {};\n"), type: "blob" }]);
  const reader: Reader = { tree: async (h) => trees.get(h) ?? null, blob: async (h) => blobs.get(h) ?? null };
  const chunks: Uint8Array[] = [];
  const files = await writeTree(reader, "root", async (b) => { chunks.push(b); });
  chunks.push(END_OF_ARCHIVE);
  assert.equal(files, 4, "the submodule pointer is skipped");
  const dir = mkdtempSync(join(tmpdir(), "tree-test-"));
  try {
    writeFileSync(join(dir, "t.tar"), Buffer.concat(chunks));
    execFileSync("tar", ["-xf", "t.tar"], { cwd: dir });
    assert.equal(readFileSync(join(dir, "package.json"), "utf8"), '{"name":"x"}\n');
    assert.equal(statSync(join(dir, "run.sh")).mode & 0o777, 0o755);
    assert.equal(readlinkSync(join(dir, "latest")), "src/index.ts");
    assert.equal(readFileSync(join(dir, "src/index.ts"), "utf8"), "export {};\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing blob stops the stream instead of writing a partial tree", async () => {
  const reader: Reader = {
    tree: async () => [{ name: "a", mode: "100644", hash: "gone", type: "blob" }],
    blob: async () => null,
  };
  await assert.rejects(writeTree(reader, "root", async () => {}), /blob gone for a not found/);
});
