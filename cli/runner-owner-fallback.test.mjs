import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { ROUTE_LEVEL, SERVER_CAPABILITIES } from "../src/route-level.ts";

// Scratch lives under the system temp folder and goes with the run (t640).
const root = mkdtempSync(join(tmpdir(), "atelier-runner-owner-fallback-tests-"));
after(() => rmSync(root, { recursive: true, force: true }));

function run(t, extra, argv = ["queue"], stored = {}, jobs = ["build", "review", "plan"]) {
  const dir = mkdtempSync(join(root, "test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "secrets.json"), JSON.stringify(stored), { mode: 0o600 });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ server: "https://one.test" }));
  const config = join(dir, "runner.json");
  writeFileSync(config, JSON.stringify({ agents: [{ agent: "codex", models: ["gpt-6-astra"], command: ["unused", "{model}", "{brief_file}", "{workspace}", "{verdict_file}", "{plan_file}"] }], jobs }));
  if (argv[0] === "runner") argv = [...argv, "--config", config, "--once"];
  // claim/start require an actor before the request. Relying on the enclosing
  // workspace's git config made these credential tests fail before fetch.
  if (["claim", "start"].includes(argv[0])) argv = [...argv, "--as", "codex/test"];
  const cli = resolve("cli/atelier.mjs");
  const script = `
    process.argv = [process.execPath, ${JSON.stringify(cli)}, ...${JSON.stringify(argv)}];
    globalThis.fetch = async (_url, options = {}) => {
      if (_url.endsWith("/version")) return Response.json({ routeLevel: ${ROUTE_LEVEL}, capabilities: ${JSON.stringify(SERVER_CAPABILITIES)} });
      process.stderr.write("AUTH=" + options.headers.authorization + "\\n");
      return Response.json({ error: "unauthorised" }, { status: 401 });
    };
    await import(${JSON.stringify(cli)});
  `;
  const env = { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_SECRET_STORE: "file", ATELIER_SERVER: "https://one.test", ATELIER_OWNER: "owner", ...extra };
  for (const key of ["ATELIER_RUNNER_TOKEN", "ATELIER_TOKEN", "ATELIER_RUNNER_NAME"]) if (!(key in extra)) delete env[key];
  // Credentials must also work on a machine with no task workspace identity.
  delete env.ATELIER_ACTOR;
  env.GIT_CEILING_DIRECTORIES = root;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env, cwd: dir });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

test("a named runner with no entry uses the owner login and says so once", (t) => {
  const result = run(t, { ATELIER_RUNNER_NAME: "home:nobody", ATELIER_TOKEN: "owner-secret" });
  assert.match(result.stderr, /AUTH=Bearer owner-secret/, result.stderr);
  assert.equal(result.stderr.match(/running with the developer's credential/g)?.length, 1, result.stderr);
});

test("a named runner with no entry and no owner login fails without a request", (t) => {
  const result = run(t, { ATELIER_RUNNER_NAME: "home:nobody" });
  assert.notEqual(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /AUTH=/, result.stderr);
  assert.match(result.stderr, /no API token/, result.stderr);
});

test("claim --runner with no entry follows the same rule", (t) => {
  const result = run(t, { ATELIER_TOKEN: "owner-secret" }, ["claim", "t1", "--project", "demo", "--runner", "home:nobody"]);
  assert.match(result.stderr, /running with the developer's credential/, result.stderr);
  assert.match(result.stderr, /AUTH=Bearer owner-secret/, result.stderr);
  assert.doesNotMatch(result.stderr, /no runner credential/, result.stderr);
});

test("an explicitly empty ATELIER_RUNNER_TOKEN still fails and never uses the owner", (t) => {
  const result = run(t, { ATELIER_RUNNER_NAME: "home:nobody", ATELIER_RUNNER_TOKEN: "", ATELIER_TOKEN: "owner-secret" });
  assert.notEqual(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /AUTH=/, result.stderr);
  assert.match(result.stderr, /empty/, result.stderr);
});

for (const [argv, jobs] of [
  [["runner", "--name", "home:nobody"], ["build"]],
  [["runner", "--name", "home:nobody"], ["review"]],
  [["runner", "--name", "home:nobody"], ["plan"]],
  [["claim", "t1", "--project", "demo", "--runner", "home:nobody"]],
  [["start", "t1", "--project", "demo", "--runner", "home:nobody"]],
]) {
  const label = jobs ? `${argv[0]} (${jobs[0]})` : argv[0];
  for (const stored of [null, [], "invalid", 42, false]) {
    test(`${label}: malformed secrets file ${JSON.stringify(stored)} never selects owner`, (t) => {
      const result = run(t, { ATELIER_TOKEN: "owner-secret" }, argv, stored, jobs);
      assert.notEqual(result.status, 0, result.stderr);
      assert.match(result.stderr, /must contain a secret entry object/, result.stderr);
      assert.doesNotMatch(result.stderr, /AUTH=|running with the developer's credential/, result.stderr);
    });
  }
  test(`${label}: missing entry uses the stored owner login, or fails without one`, (t) => {
    const owner = run(t, {}, argv, { API_TOKEN: "owner-secret" }, jobs);
    assert.match(owner.stderr, /AUTH=Bearer owner-secret/, owner.stderr);
    assert.equal(owner.stderr.match(/running with the developer's credential/g)?.length, 1, owner.stderr);
    const missing = run(t, {}, argv, {}, jobs);
    assert.notEqual(missing.status, 0, missing.stderr);
    assert.match(missing.stderr, /no API token/, missing.stderr);
    assert.doesNotMatch(missing.stderr, /AUTH=/, missing.stderr);
  });

  for (const entry of ["", "   ", 42, false, null, {}, "not json", "null",
    ...["", "   ", "a\nb", null, 42].map((token) => JSON.stringify({ server: "https://one.test", token })),
    JSON.stringify({ server: "https://other.test", token: "runner-secret" })]) {
    test(`${label}: malformed or foreign stored entry ${JSON.stringify(entry)} never selects owner`, (t) => {
      const result = run(t, {}, argv, { API_TOKEN: "owner-secret", "runner.home:nobody": entry }, jobs);
      assert.notEqual(result.status, 0, result.stderr);
      assert.match(result.stderr, /one line of text|no server binding|not bound/, result.stderr);
      assert.doesNotMatch(result.stderr, /AUTH=|running with the developer's credential/, result.stderr);
    });
  }

  for (const token of ["", "invalid", "expired", "revoked"]) {
    test(`${label}: explicit ${token || "empty"} token never selects owner`, (t) => {
      const result = run(t, { ATELIER_RUNNER_TOKEN: token }, argv, { API_TOKEN: "owner-secret" }, jobs);
      assert.notEqual(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /owner-secret|running with the developer's credential/, result.stderr);
      if (token) assert.equal(result.stderr.match(new RegExp(`AUTH=Bearer ${token}`, "g"))?.length, 1, result.stderr);
      else assert.doesNotMatch(result.stderr, /AUTH=/, result.stderr);
    });
  }
}
