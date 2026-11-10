// t601: atelier design records how many tasks a design plans, and atelier
// status and atelier stuck show the designs that fewer tasks name than planned.
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

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "atelier-designs-"));
  dirs.push(root);
  const secrets = join(root, "secrets");
  mkdirSync(secrets, { mode: 0o700 });
  writeFileSync(join(secrets, "ATELIER_TOKEN"), OWNER, { mode: 0o600 });
  const server = await startServer({ env: "staging", dataDir: join(root, "data"), host: "127.0.0.1", secretsDir: secrets });
  t.after(() => server.close());
  const config = join(root, "config");
  mkdirSync(config);
  const cli = async (argv) => {
    const env = { ...process.env, ATELIER_CONFIG_DIR: config, ATELIER_CACHE: join(root, "cache"), ATELIER_TOKEN: OWNER, ATELIER_SERVER: server.url, ATELIER_SECRET_STORE: "file", NO_COLOR: "1", ATELIER_ACTING: "claude-code/opus-5.5" };
    for (const k of ["ATELIER_PROJECT", "ATELIER_ACTOR", "ATELIER_JSON"]) delete env[k];
    try { const { stdout, stderr } = await run(process.execPath, ["cli/atelier.mjs", ...argv, "--project", "demo"], { env, timeout: 60_000 }); return { code: 0, stdout, stderr }; }
    catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  };
  const api = (path) => fetch(`${server.url}/api/projects/demo${path}`, { headers: { authorization: `Bearer ${OWNER}`, "x-atelier-actor": "owner" } }).then((r) => r.json());
  const planned = async () => (await api("/events")).events.filter((e) => e.kind === "design.planned");
  const put = await fetch(`${server.url}/api/projects/demo`, { method: "PUT", headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json", "x-atelier-actor": "owner", "x-atelier-acting": "claude-code/opus-5.5" }, body: "{}" });
  assert.equal(put.status, 200);
  const file = async (title, design) => {
    const r = await cli(["new", title, "--accept", "it works", "--design", design]);
    assert.equal(r.code, 0, r.stderr);
    return /^(t\d+)/.exec(r.stdout)[1];
  };
  return { cli, planned, file };
}

test("criterion 1: atelier design records one design.planned and prints it", async (t) => {
  const { cli, planned } = await fixture(t);
  const r = await cli(["design", "model-slate", "--planned", "5", "--quote", "Yes, both"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Design model-slate: 5 tasks planned, recorded \d{4}-\d{2}-\d{2} for demo\. Words: Yes, both\n$/);
  const events = await planned();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].data, { name: "model-slate", planned: 5, quote: "Yes, both", by: "owner", acting: "claude-code/opus-5.5" });
});

test("criterion 2 through the CLI: no --quote or a bad count records nothing", async (t) => {
  const { cli, planned } = await fixture(t);
  assert.notEqual((await cli(["design", "model-slate", "--planned", "5"])).code, 0);
  assert.notEqual((await cli(["design", "model-slate", "--quote", "words"])).code, 0);
  for (const bad of ["0", "51", "2.5", "many"]) assert.notEqual((await cli(["design", "model-slate", "--planned", bad, "--quote", "words"])).code, 0, bad);
  assert.equal((await planned()).length, 0);
});

test("criterion 4: atelier status prints each design with fewer tasks than planned, counting every state, and none once K reaches N", async (t) => {
  const { cli, file } = await fixture(t);
  await cli(["design", "model-slate", "--planned", "3", "--quote", "file all three today"]);
  const a = await file("A", "model-slate");
  const quiet = await cli(["status", "--project", "demo"]);
  assert.equal(quiet.code, 0, quiet.stderr);
  assert.match(quiet.stdout, /^Design model-slate: 1 of 3 tasks filed$/m);
  const b = await file("B", "model-slate");
  const gone = await cli(["abandon", b, "--note", "not needed", "--quote", "drop it"]);
  assert.equal(gone.code, 0, gone.stderr);
  assert.match((await cli(["status", "--project", "demo"])).stdout, /^Design model-slate: 2 of 3 tasks filed$/m);
  await file("C", "model-slate");
  assert.doesNotMatch((await cli(["status", "--project", "demo"])).stdout, /Design model-slate/);
  assert.ok(a);
  // a plan raised again shows the line again, and lowering it with words clears it
  await cli(["design", "model-slate", "--planned", "5", "--quote", "two more"]);
  const shown = await cli(["status", "--project", "demo"]);
  assert.match(shown.stdout, /^Design model-slate: 3 of 5 tasks filed$/m);
  assert.match((await cli(["stuck", "--project", "demo"])).stdout, /unfiled-plan|Design model-slate: 3 of 5 tasks filed/);
  await cli(["design", "model-slate", "--planned", "3", "--quote", "back to three"]);
  assert.doesNotMatch((await cli(["status", "--project", "demo"])).stdout, /Design model-slate/);
});
