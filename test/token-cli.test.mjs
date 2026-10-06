import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

const cli = resolve("cli/atelier.mjs");
function run(args, token = "owner-test-token", config = resolve(".cache/token-cli-config")) {
  const source = `
    process.argv = [process.execPath, ${JSON.stringify(cli)}, ...${JSON.stringify(args)}];
    globalThis.fetch = async (url, options = {}) => {
      const path = new URL(url).pathname;
      const body = options.body ? JSON.parse(options.body) : undefined;
      console.error(JSON.stringify({ path, actor: options.headers?.["x-atelier-actor"], method: options.method, body }));
      const data = path === "/api/config" ? { actor: "codex/gpt-6-astra" }
        : options.method === "DELETE" ? { revoked: true }
        : path === "/api/tokens" && options.method === "POST" ? { id: "public-id", actor: body.actor, token: "atl_test-issued", expiresAt: "later" }
        : path === "/api/tokens" ? [{ id: "public-id", actor: "codex/gpt-6-astra", token: "atl_test-issued", hash: "private-hash", expiresAt: "later" }]
        : [];
      return Response.json(data);
    };
    await import(${JSON.stringify(cli)});
  `;
  const childEnv = { ...process.env };
  delete childEnv.ATELIER_ACTOR;
  return spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8", env: { ...childEnv, ATELIER_TOKEN: token, ATELIER_SECRET_STORE: "file", ATELIER_SERVER: "https://atelier.test", ATELIER_CONFIG_DIR: config, ATELIER_OWNER: "owner" },
  });
}

test("token issue sends repeated scopes and prints the token exactly once", () => {
  const result = run(["token", "issue", "--as", "codex/gpt-6-astra", "--project", "p", "--project", "q", "--days", "12", "--label", "Test"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.split("atl_test-issued").length - 1, 1);
  assert.match(result.stdout, /not shown again/);
  assert.match(result.stdout, /ATELIER_TOKEN/);
  assert.deepEqual(JSON.parse(result.stderr.trim()), { path: "/api/tokens", actor: "owner", method: "POST", body: { actor: "codex/gpt-6-astra", projects: ["p", "q"], days: 12, label: "Test" } });
});

test("stored agent tokens resolve their actor and respect environment overrides", () => {
  mkdirSync(".cache", { recursive: true });
  const config = mkdtempSync(resolve(".cache/token-store-"));
  try {
    writeFileSync(resolve(config, "secrets.json"), JSON.stringify({ API_TOKEN: "atl_stored" }), { mode: 0o600 });
    // The server the stored token belongs to, as login records it when that
    // server accepts the token; the stored token is sent to that server alone.
    writeFileSync(resolve(config, "config.json"), JSON.stringify({ server: "https://atelier.test" }));
    const result = run(["queue"], "", config);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stderr.trim().split("\n")[1]).actor, "codex/gpt-6-astra");
    const refused = run(["queue", "--as", "owner"], "", config);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /must match/);
    assert.doesNotMatch(refused.stderr, /\/api\/queue/);
    const override = run(["queue"], "owner-test-token", config);
    assert.equal(override.status, 0, override.stderr);
    assert.doesNotMatch(override.stderr, /\/api\/config/);
    assert.equal(JSON.parse(override.stderr.trim()).actor, "owner");
    for (const args of [["guide"], ["init", "--title"]]) {
      assert.doesNotMatch(run(args, "", config).stderr, /\/api\//);
    }
  } finally { rmSync(config, { recursive: true, force: true }); }
});

test("token list and revoke use the owner actor", () => {
  for (const args of [["token", "ls"], ["token", "revoke", "public-id"]]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stderr.trim()).actor, "owner");
    assert.doesNotMatch(result.stdout, /atl_test-issued|private-hash/);
    if (args[1] === "ls") assert.match(result.stdout, /public-id/);
  }
});

test("invalid expiry is refused before sending a request", () => {
  for (const days of ["oops", "0", "366", "1.5"]) {
    const result = run(["token", "issue", "--as", "codex/gpt-6-astra", "--days", days]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /days needs an integer/);
    assert.doesNotMatch(result.stderr, /\/api\/tokens/);
  }
});

test("agent CLI discovers its actor and refuses a conflicting --as", () => {
  const result = run(["queue"], "atl_agent");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stderr.trim().split("\n")[1]).actor, "codex/gpt-6-astra");
  const refused = run(["queue", "--as", "owner"], "atl_agent");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /must match/);
  assert.doesNotMatch(refused.stderr, /\/api\/queue/);
});

test("agent local commands and invalid arguments do not request config", () => {
  for (const args of [["guide"], ["init", "--title"], ["models", "frobnicate"], ["projects", "frobnicate"]]) {
    const result = run(args, "atl_probe");
    assert.equal(result.status, args[0] === "guide" ? 0 : 1, result.stderr);
    assert.doesNotMatch(result.stderr, /\/api\//);
    assert.match(result.stdout + result.stderr, args[0] === "guide" ? /atelier/ : /usage|give the title/);
  }
});
