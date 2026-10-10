import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { ROUTE_LEVEL } from "../src/route-level.ts";

const root = resolve(".cache/runner-owner-fallback-tests");
mkdirSync(root, { recursive: true });

function run(t, extra, argv = ["queue"], stored = {}) {
  const dir = mkdtempSync(join(root, "test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "secrets.json"), JSON.stringify(stored), { mode: 0o600 });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ server: "https://one.test" }));
  const config = join(dir, "runner.json");
  writeFileSync(config, JSON.stringify({ agents: [{ agent: "codex", models: ["gpt-6-astra"], command: ["unused", "{model}", "{brief_file}", "{workspace}", "{verdict_file}", "{plan_file}"] }], jobs: ["build", "review", "plan"] }));
  if (argv[0] === "runner") argv = [...argv, "--config", config, "--once"];
  const cli = resolve("cli/atelier.mjs");
  const script = `
    process.argv = [process.execPath, ${JSON.stringify(cli)}, ...${JSON.stringify(argv)}];
    globalThis.fetch = async (_url, options = {}) => {
      if (_url.endsWith("/version")) return Response.json({ routeLevel: ${ROUTE_LEVEL} });
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

for (const argv of [
  ["runner", "--name", "home:nobody"],
  ["claim", "t1", "--project", "demo", "--runner", "home:nobody"],
  ["start", "t1", "--project", "demo", "--runner", "home:nobody"],
]) {
  test(`${argv[0]}: missing entry uses the stored owner login, or fails without one`, (t) => {
    const owner = run(t, {}, argv, { API_TOKEN: "owner-secret" });
    assert.match(owner.stderr, /AUTH=Bearer owner-secret/);
    assert.equal(owner.stderr.match(/running with the owner's credential/g)?.length, 1);
    const missing = run(t, {}, argv);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /no API token/);
    assert.doesNotMatch(missing.stderr, /AUTH=/);
  });

  for (const entry of ["", "   ", 42, false, null, {}, "not json", "null",
    JSON.stringify({ server: "https://other.test", token: "runner-secret" })]) {
    test(`${argv[0]}: malformed or foreign stored entry ${JSON.stringify(entry)} never selects owner`, (t) => {
      const result = run(t, {}, argv, { API_TOKEN: "owner-secret", "runner.home:nobody": entry });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /one line of text|no server binding|not bound/);
      assert.doesNotMatch(result.stderr, /AUTH=|running with the owner's credential/);
    });
  }

  for (const token of ["", "invalid", "expired", "revoked"]) {
    test(`${argv[0]}: explicit ${token || "empty"} token never selects owner`, (t) => {
      const result = run(t, { ATELIER_RUNNER_TOKEN: token }, argv, { API_TOKEN: "owner-secret" });
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stderr, /owner-secret|running with the owner's credential/);
      if (token) assert.equal(result.stderr.match(new RegExp(`AUTH=Bearer ${token}`, "g"))?.length, 1);
      else assert.doesNotMatch(result.stderr, /AUTH=/);
    });
  }
}
