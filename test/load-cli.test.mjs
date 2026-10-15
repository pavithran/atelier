import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { acquireSlot, slotStatus } from "../cli/load.mjs";

test("real slots CLI changes an isolated occupied pool and reports draining without credentials", async (t) => {
  const root = mkdtempSync(join(process.cwd(), ".slots-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "pool.sqlite"), preload = join(root, "isolate.mjs");
  const processes = [{ pid: 100, lease: "held-one", birth: "one" }, { pid: 101, lease: "held-two", birth: "two" }];
  const options = { path, env: { ATELIER_TEST_SLOTS: "2" }, processes: () => processes };
  for (const owner of processes) await acquireSlot(owner, options);
  const before = await slotStatus(options);
  // Test-only module loading redirects the fixed production pool and supplies
  // its process snapshot. CLI parsing, dispatch, handlers and SQLite are real.
  writeFileSync(preload, `import { registerHooks } from 'node:module';
    registerHooks({ load(url, context, next) {
      const loaded = next(url, context);
      if (url === ${JSON.stringify(new URL("../cli/load.mjs", import.meta.url).href)}) {
        const source = String(loaded.source);
        if (!source.includes(JSON.stringify('/tmp/atelier-test-slots-v1.sqlite'))) {
          throw new Error('cannot isolate the test pool; refusing to run the CLI');
        }
        loaded.source = source
          .replace(JSON.stringify('/tmp/atelier-test-slots-v1.sqlite'), ${JSON.stringify(JSON.stringify(path))})
          .replace('(options.processes ?? slotProcesses)()', ${JSON.stringify(JSON.stringify(processes))});
      }
      return loaded;
    } });`);
  const run = (...args) => spawnSync(process.execPath, ["--import", preload,
    fileURLToPath(new URL("../cli/atelier.mjs", import.meta.url)), "slots", ...args], {
    cwd: root, encoding: "utf8", env: { ...process.env, ATELIER_CONFIG_DIR: root, ATELIER_TOKEN: "",
      ATELIER_TEST_SLOTS: "bad", ATELIER_SERVER: "http://127.0.0.1:1" },
  });
  const changed = run("set", "1");
  assert.equal(changed.status, 0, changed.stderr);
  assert.match(changed.stdout, /Test slot capacity: 1/);
  assert.equal((changed.stderr.match(/test slots: warning:/g) ?? []).length, 1);
  const status = run("status", "--json");
  assert.equal(status.status, 0, status.stderr);
  const parsed = JSON.parse(status.stdout);
  assert.equal(parsed.capacity, 1);
  assert.equal(parsed.usage, 2);
  assert.equal(parsed.draining, 1);
  assert.deepEqual(parsed.active, before.active);
  const text = run("status");
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Test slots: 2\/1.*draining excess: 1/);
  for (const args of [["set"], ["set", "0"], ["set", "-1"], ["set", "1.5"], ["set", "9007199254740992"],
    ["set", "1e2"], ["set", "2", "extra"], ["set", "2", "--json"], ["status", "extra"], ["unknown"], []]) {
    const result = run(...args);
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert.match(result.stderr, /positive integer|usage:|does not take/);
  }
  assert.deepEqual(JSON.parse(run("status", "--json").stdout), parsed);
  assert.equal(run("set", "3").status, 0);
  assert.equal(JSON.parse(run("status", "--json").stdout).capacity, 3);
  const help = run("--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /slots set N/);
  assert.match(help.stdout, /slots status/);
});


test("a refused ps runs the command without accounting and preserves its exit status", (t) => {
  const root = mkdtempSync(join(process.cwd(), ".slots-denied-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "ps"), "#!/bin/sh\necho 'ps: Operation not permitted' >&2\nexit 1\n", { mode: 0o755 });
  for (const code of [0, 7]) {
    const result = spawnSync(process.execPath, ["cli/load.mjs", "--", process.execPath, "-e", `console.log('command executed'); process.exit(${code})`], {
      env: { ...process.env, PATH: root }, encoding: "utf8", timeout: 10000,
    });
    assert.equal(result.status, code, result.stderr);
    assert.match(result.stdout, /command executed/);
    assert.match(result.stderr, /running without process-tree accounting/);
  }
});
