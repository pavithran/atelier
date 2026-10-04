import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readlinkSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { END_OF_ARCHIVE, entryBytes, safePath, type TarEntry } from "../src/sandbox/tar.ts";

const enc = new TextEncoder();

function archive(entries: TarEntry[]): Uint8Array {
  const parts = [...entries.flatMap(entryBytes), END_OF_ARCHIVE];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

test("the system tar unpacks files, modes, symlinks and long paths exactly", () => {
  const long = `${"d".repeat(60)}/${"e".repeat(60)}/${"f".repeat(70)}.ts`;   // > 100, fits ustar prefix
  const veryLong = `${"g".repeat(120)}/${"h".repeat(120)}/${"i".repeat(120)}.md`; // > 255, needs pax
  const entries: TarEntry[] = [
    { path: "README.md", mode: 0o644, kind: "file", data: enc.encode("hello\n") },
    { path: "bin/run.sh", mode: 0o755, kind: "file", data: enc.encode("#!/bin/sh\necho ok\n") },
    { path: "empty.txt", mode: 0o644, kind: "file", data: new Uint8Array() },
    { path: "blob.bin", mode: 0o644, kind: "file", data: new Uint8Array(1000).map((_, i) => i % 256) },
    { path: "link", mode: 0o777, kind: "symlink", target: "README.md" },
    { path: long, mode: 0o644, kind: "file", data: enc.encode("long\n") },
    { path: veryLong, mode: 0o644, kind: "file", data: enc.encode("very long\n") },
    { path: "ünïcode/файл.txt", mode: 0o644, kind: "file", data: enc.encode("utf-8\n") },
  ];
  const dir = mkdtempSync(join(tmpdir(), "tar-test-"));
  try {
    writeFileSync(join(dir, "a.tar"), archive(entries));
    execFileSync("tar", ["-xf", "a.tar"], { cwd: dir });
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "hello\n");
    assert.equal(statSync(join(dir, "bin/run.sh")).mode & 0o777, 0o755);
    assert.equal(statSync(join(dir, "README.md")).mode & 0o777, 0o644);
    assert.equal(readFileSync(join(dir, "empty.txt")).length, 0);
    assert.deepEqual([...readFileSync(join(dir, "blob.bin"))], [...entries[3].data!]);
    assert.equal(readlinkSync(join(dir, "link")), "README.md");
    assert.equal(readFileSync(join(dir, long), "utf8"), "long\n");
    assert.equal(readFileSync(join(dir, veryLong), "utf8"), "very long\n");
    assert.equal(readFileSync(join(dir, "ünïcode/файл.txt"), "utf8"), "utf-8\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("paths that could escape the workspace are refused", () => {
  for (const p of ["../x", "a/../../x", "/etc/passwd", "a//b", "./a", ""]) assert.equal(safePath(p), false, p);
  assert.equal(safePath("a/b.c"), true);
  assert.throws(() => entryBytes({ path: "../evil", mode: 0o644, kind: "file", data: new Uint8Array() }), /unsafe path/);
});
