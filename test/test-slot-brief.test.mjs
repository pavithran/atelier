import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { HARNESSES } from "../cli/harness/adapter.mjs";
import { SLOT_WRAPPER } from "../cli/load.mjs";
import { quoteShell, requireNode, slotNote, testSlotNote } from "../cli/runner.mjs";
import { canInspectSlots } from "./fixtures/slot-inspection.mjs";

// t479: a brief names the slot wrapper as `node 'WRAPPER' -- COMMAND`, which
// the Claude adapter's existing Bash(node:*) permission already allows.

const commandOf = (note) => note.match(/wrapper: (node '.*') -- COMMAND ARGUMENTS\./)[1];

test("the brief invokes the wrapper with node from the PATH, not a package script or absolute node", () => {
  assert.equal(testSlotNote.includes(process.execPath), false);
  assert.ok(testSlotNote.includes(`wrapper: node ${quoteShell(SLOT_WRAPPER)} -- COMMAND ARGUMENTS.`));
  assert.doesNotMatch(testSlotNote, /npm|package/);
});

test("wrapper paths with spaces and apostrophes are quoted safely", () => {
  for (const path of ["/a b/load.mjs", "/it's/load.mjs", "/x'; echo pwned; '/l.mjs", "/$HOME/`id`/l.mjs"]) {
    const r = spawnSync("sh", ["-c", `printf %s ${quoteShell(path)}`], { encoding: "utf8" });
    assert.equal(r.stdout, path);
    assert.ok(commandOf(slotNote(path)).startsWith("node "));
    const echoed = spawnSync("sh", ["-c", `printf %s ${commandOf(slotNote(path)).replace(/^node /, "")}`], { encoding: "utf8" });
    assert.equal(echoed.stdout, path);
  }
});

test("the Claude build and review adapters allow the brief's command through Bash(node:*) and nothing broader", () => {
  const command = commandOf(testSlotNote);
  for (const kind of ["build", "review"]) {
    const { argv } = HARNESSES["claude-code"].command({ model: "opus-5.5" }, kind);
    const allowed = argv[argv.indexOf("--allowedTools") + 1].split(",");
    const bash = allowed.filter((t) => t === "Bash" || t.startsWith("Bash("));
    assert.ok(bash.includes("Bash(node:*)"), kind);
    const prefixes = bash.map((t) => t.match(/^Bash\((.*):\*\)$/)?.[1]);
    assert.ok(prefixes.every((p) => p), `${kind}: only prefix permissions`);
    assert.ok(prefixes.some((p) => command.startsWith(`${p} `)), "node permission covers the command");
    for (const broad of ["Bash", "Bash(*)", "Bash(sh:*)", "Bash(bash:*)", "Bash(env:*)"]) assert.ok(!allowed.includes(broad), `${kind}: ${broad}`);
    assert.ok(argv[argv.indexOf("--disallowedTools") + 1].includes("Bash(atelier:*)"));
  }
});

test("requireNode refuses a PATH without node and accepts one with it", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "atelier-node-path-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => requireNode({ PATH: dir }), /node is not on the harness PATH/);
  assert.throws(() => requireNode({}), /node is not on the harness PATH/);
  writeFileSync(join(dir, "node"), "#!/bin/sh\n");
  assert.throws(() => requireNode({ PATH: dir }), /node is not on the harness PATH/, "not executable");
  chmodSync(join(dir, "node"), 0o755);
  requireNode({ PATH: `/nonexistent:${dir}` });
  requireNode({ PATH: dirname(process.execPath) });
});

test("the generated command runs from another workspace: slot held, nested reuse, priority, cwd and exit status", { timeout: 60000 }, (t) => {
  if (!canInspectSlots(t)) return;
  const work = realpathSync(mkdtempSync(join(tmpdir(), "atelier-slot-brief-")));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const cwd = join(work, "other workspace");
  mkdirSync(cwd);
  const task = `t479-${randomUUID()}`;
  const inner = `
    const { spawnSync } = require("node:child_process");
    const wrapper = ${JSON.stringify(SLOT_WRAPPER)};
    const status = JSON.parse(spawnSync("node", [wrapper, "--status", "--json"], { encoding: "utf8" }).stdout);
    const mine = status.active.filter((e) => e.task === ${JSON.stringify(task)});
    const nested = spawnSync("node", [wrapper, "--", "node", "-e", "process.exit(7)"], { encoding: "utf8", env: process.env });
    const after = JSON.parse(spawnSync("node", [wrapper, "--status", "--json"], { encoding: "utf8" }).stdout);
    console.log(JSON.stringify({ cwd: process.cwd(), held: mine.length, cls: mine[0]?.class, nested: nested.status, still: after.active.filter((e) => e.task === ${JSON.stringify(task)}).length, args: process.argv.slice(1) }));
    process.exit(5);`;
  const line = `${commandOf(slotNote(SLOT_WRAPPER))} -- ${quoteShell(process.execPath)} -e ${quoteShell(inner)} 'a b' "it's"`;
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ATELIER_TEST_TASK: task, ATELIER_TEST_PROJECT: "atelier", ATELIER_TEST_ACTOR: "claude-code/test", ATELIER_TEST_PRIORITY: "review" };
  if (process.env.ATELIER_TEST_SLOTS) env.ATELIER_TEST_SLOTS = process.env.ATELIER_TEST_SLOTS;
  const r = spawnSync("sh", ["-c", line], { cwd, env, encoding: "utf8", timeout: 50000 });
  assert.equal(r.status, 5, r.stderr + r.stdout);
  const out = JSON.parse(r.stdout.trim().split("\n").at(-1));
  assert.equal(out.cwd, cwd);
  assert.equal(out.held, 1, "the command holds one slot");
  assert.equal(out.cls, "review", "priority is inherited");
  assert.equal(out.nested, 7, "a nested wrapper reuses the slot and passes the exit status through");
  assert.equal(out.still, 1);
  assert.deepEqual(out.args.slice(-2), ["a b", "it's"]);
});

test("the runner's harness start refuses a PATH without node and otherwise keeps cwd and exit status", async (t) => {
  const { startHarness } = await import("../cli/runner.mjs");
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "atelier-start-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(startHarness(["/bin/sh", "-c", "exit 0"], dir, { PATH: "/nonexistent" }), /node is not on the harness PATH/);
  const r = await startHarness(["/bin/sh", "-c", "pwd; exit 3"], dir, { PATH: `${dirname(process.execPath)}:/bin` }, { capture: true });
  assert.equal(r.code, 3);
  assert.equal(r.output, dir);
});
