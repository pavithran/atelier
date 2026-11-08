// t538: a task names its design note with --design, and atelier show prints it.
// The real Node server is driven by the real CLI; every credential is a dummy.
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { startServer } from "../src/runtime/server.mjs";

const run = promisify(execFile);
const OWNER = "atl_00112233445566778899aabbccddeeff";
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("criterion 1: new --design and edit --design record the name and show prints it; edit --design \"\" clears it", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atelier-design-"));
  dirs.push(root);
  const secrets = join(root, "secrets");
  mkdirSync(secrets, { mode: 0o700 });
  writeFileSync(join(secrets, "ATELIER_TOKEN"), OWNER, { mode: 0o600 });
  const server = await startServer({ env: "staging", dataDir: join(root, "data"), host: "127.0.0.1", secretsDir: secrets });
  t.after(() => server.close());
  const config = join(root, "config");
  mkdirSync(config);
  const cli = async (argv) => {
    const env = { ...process.env, ATELIER_CONFIG_DIR: config, ATELIER_TOKEN: OWNER, ATELIER_SERVER: server.url, ATELIER_SECRET_STORE: "file", NO_COLOR: "1", ATELIER_ACTING: "claude-code/opus-5.5" };
    for (const k of ["ATELIER_PROJECT", "ATELIER_ACTOR", "ATELIER_JSON"]) delete env[k];
    try { const { stdout, stderr } = await run(process.execPath, ["cli/atelier.mjs", ...argv, "--project", "demo"], { env, timeout: 60_000 }); return { code: 0, stdout, stderr }; }
    catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  };
  const put = await fetch(`${server.url}/api/projects/demo`, { method: "PUT", headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json", "x-atelier-actor": "owner", "x-atelier-acting": "claude-code/opus-5.5" }, body: "{}" });
  assert.equal(put.status, 200);

  const made = await cli(["new", "Build the mechanism", "--accept", "it works", "--design", "notify-delivery"]);
  assert.equal(made.code, 0, made.stderr);
  assert.match(made.stdout, /Design: notify-delivery/);
  const id = /^(t\d+)/.exec(made.stdout)[1];
  assert.match((await cli(["show", id])).stdout, /Design: notify-delivery/);

  const edited = await cli(["edit", id, "--design", "session-waking"]);
  assert.equal(edited.code, 0, edited.stderr);
  const shown = await cli(["show", id]);
  assert.match(shown.stdout, /Design: session-waking/);
  assert.doesNotMatch(shown.stdout, /notify-delivery/);

  const cleared = await cli(["edit", id, "--design", ""]);
  assert.equal(cleared.code, 0, cleared.stderr);
  assert.doesNotMatch((await cli(["show", id])).stdout, /Design:/);
});
