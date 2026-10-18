// Part 2 of 2 of the tests that were in merge-manifest.test.mjs, split so no file runs for more than about a minute (t771).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mergeThrough, previewMerge } from "../cli/merge-pipeline.mjs";
import { commandFiles, handlerIndex, specIndex } from "../cli/regenerate.mjs";
import { root, SPECS, HANDLERS, git, fixture, sides, counting, addCommands, declaration, handler } from "./merge-manifest-shared.mjs";

test("a command deleted on one side and another added on the other merge: the regenerated indexes and fixtures drop the one and list the other", { timeout: 600_000 }, async (t) => {
  const dir = fixture(t);
  git(dir, "tag", "base");
  addCommands(dir, "main", [["hello", "hello"]]);
  git(dir, "checkout", "-q", "-B", "theirs", "base");
  git(dir, "rm", "-q", `${HANDLERS}/slots.mjs`, `${SPECS}/slots.ts`);
  writeFileSync(join(dir, SPECS, "index.ts"), specIndex(commandFiles(dir, SPECS, ".ts")));
  writeFileSync(join(dir, HANDLERS, "index.mjs"), handlerIndex(commandFiles(dir, HANDLERS, ".mjs")));
  git(dir, "commit", "-q", "-am", "remove slots");
  git(dir, "checkout", "-q", "main");
  const preview = previewMerge(dir, "HEAD", "theirs");
  assert.deepEqual(preview.source, []);
  assert.deepEqual(preview.generated, ["cli/commands/index.mjs", "src/usage/commands/index.ts"]);
  const { run, calls } = counting();
  const r = await mergeThrough(dir, "theirs", { message: "Merge theirs", run });
  assert.equal(r.state, "merged", JSON.stringify({ ...r, manifest: undefined }));
  assert.ok(calls.length >= 1);
  assert.equal(git(dir, "status", "--porcelain"), "");
  const read = (path) => readFileSync(join(dir, path), "utf8");
  assert.ok(!existsSync(join(dir, HANDLERS, "slots.mjs")) && !existsSync(join(dir, SPECS, "slots.ts")));
  assert.doesNotMatch(read("cli/commands/index.mjs"), /command_slots/);
  assert.doesNotMatch(read("src/usage/commands/index.ts"), /command_slots/);
  assert.match(read("cli/commands/index.mjs"), /command_hello/);
  const usage = JSON.parse(read("test/fixtures/cli/usage.json"));
  assert.equal(usage.slots, undefined);
  assert.ok(usage.hello.startsWith("usage: atelier hello"));
  assert.doesNotMatch(read("test/fixtures/cli/help.txt"), /\bslots (set|status)/);
});


test("two command modules claiming one name stop the merge on the registry key before the generator runs", async (t) => {
  const dir = fixture(t);
  sides(dir, [["greet", "hello"]], [["hello", "hello"]], { indexes: false });
  const { run, calls } = counting();
  const r = await mergeThrough(dir, "theirs", { message: "m", run });
  assert.equal(r.state, "conflicts");
  assert.deepEqual(r.problems, [
    "the command-handlers registry key hello is declared by both cli/commands/greet.mjs and cli/commands/hello.mjs",
    "the command-declarations registry key hello is declared by both src/usage/commands/greet.ts and src/usage/commands/hello.ts",
  ]);
  assert.equal(calls.length, 0);
  assert.equal(previewMerge(dir, "HEAD", "theirs").clean, false);
  assert.equal(git(dir, "rev-parse", "HEAD"), git(dir, "rev-parse", "main"));
});


test("one command added differently on both sides is a source conflict: nothing is generated and the indexes stay regenerable", async (t) => {
  const dir = fixture(t);
  sides(dir, [["hello", "hello", "hi"]], [["hello", "hello", "hello"]]);
  const { run, calls } = counting();
  const r = await mergeThrough(dir, "theirs", { message: "m", run, leave: true });
  assert.equal(r.state, "conflicts");
  assert.deepEqual(r.source, ["cli/commands/hello.mjs"]);
  assert.deepEqual(r.generated, []);
  assert.equal(calls.length, 0);
  // Left for a person: the source in conflict, no output written from it.
  assert.match(readFileSync(join(dir, "cli/commands/hello.mjs"), "utf8"), /^<<<<<<< /m);
  git(dir, "merge", "--abort");
});
