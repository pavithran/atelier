import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(".cache/runner-owner-fallback-tests");
mkdirSync(root, { recursive: true });

function run(t, extra, argv = ["queue"]) {
  const dir = mkdtempSync(join(root, "test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = resolve("cli/atelier.mjs");
  const script = `
    process.argv = [process.execPath, ${JSON.stringify(cli)}, ...${JSON.stringify(argv)}];
    globalThis.fetch = async (_url, options) => {
      process.stderr.write("AUTH=" + options.headers.authorization + "\\n");
      return Response.json({ error: "unauthorised" }, { status: 401 });
    };
    await import(${JSON.stringify(cli)});
  `;
  const env = { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_SECRET_STORE: "file", ATELIER_SERVER: "https://one.test", ATELIER_OWNER: "owner", ...extra };
  for (const key of ["ATELIER_RUNNER_TOKEN", "ATELIER_TOKEN"]) if (!(key in extra)) delete env[key];
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env });
}

test("a named runner with no entry uses the owner login and says so once", (t) => {
  const result = run(t, { ATELIER_RUNNER_NAME: "home:nobody", ATELIER_TOKEN: "owner-secret" });
  assert.match(result.stderr, /AUTH=Bearer owner-secret/);
  assert.equal(result.stderr.match(/running with the owner's credential/g)?.length, 1);
});

test("a named runner with no entry and no owner login fails without a request", (t) => {
  const result = run(t, { ATELIER_RUNNER_NAME: "home:nobody" });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /AUTH=/);
  assert.match(result.stderr, /no API token/);
});

test("claim --runner with no entry follows the same rule", (t) => {
  const result = run(t, { ATELIER_TOKEN: "owner-secret" }, ["claim", "t1", "--project", "demo", "--runner", "home:nobody"]);
  assert.match(result.stderr, /running with the owner's credential/);
  assert.doesNotMatch(result.stderr, /no runner credential/);
});

test("an explicitly empty ATELIER_RUNNER_TOKEN still fails and never uses the owner", (t) => {
  const result = run(t, { ATELIER_RUNNER_NAME: "home:nobody", ATELIER_RUNNER_TOKEN: "", ATELIER_TOKEN: "owner-secret" });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /AUTH=/);
  assert.match(result.stderr, /empty/);
});
