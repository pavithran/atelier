// The real CLI and Node listeners exercise the transfer over HTTP, as at cut-over.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { startServer } from "../src/runtime/server.mjs";
import { collectIndex } from "../cli/index-transfer.mjs";

const OWNER = "atl_00112233445566778899aabbccddeeff00112233";
const root = mkdtempSync(join(tmpdir(), "atelier-index-http-")), servers = [];
after(async () => { for (const server of servers) await server.close(); rmSync(root, { recursive: true, force: true }); });
const env = { ...process.env, HOME: root, NO_COLOR: "1" };
for (const k of Object.keys(env)) if (k.startsWith("ATELIER_")) delete env[k];
const cli = (base, argv) => new Promise((ok) => execFile(process.execPath, [join(process.cwd(), "cli/atelier.mjs"), ...argv], {
  cwd: root, encoding: "utf8", timeout: 60_000,
  env: { ...env, ATELIER_CONFIG_DIR: join(root, "config"), ATELIER_TOKEN: OWNER, ATELIER_SERVER: base, ATELIER_SECRET_STORE: "file", ATELIER_ACTING: "codex/gpt-6-astra" },
}, (err, stdout, stderr) => ok({ code: err ? (err.code ?? 1) : 0, stdout, stderr })));

test("CLI export from one Node server imports into a fresh server, preserves reads, and never overwrites the private file", async () => {
  const source = await startServer({ env: "test", dataDir: join(root, "source"), host: "127.0.0.1", vars: { ATELIER_TOKEN: OWNER }, timers: false });
  servers.push(source);
  const target = await startServer({ env: "test", dataDir: join(root, "target"), host: "127.0.0.1", vars: { ATELIER_TOKEN: OWNER }, timers: false });
  servers.push(target);
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/index-v1.0-answers.json", import.meta.url), "utf8"));
  const dump = await collectIndex(async (path) => fixture[path] ?? (path.includes("astra") ? fixture["/models/gpt-6-astra/cards"] : { cards: [], withdrawals: [] }));
  const sourceIndex = source.namespace.get(source.namespace.idFromName("__index"));
  await sourceIndex.importIndex(dump);
  const sourceUrl = source.url.replace("localhost", "127.0.0.1"), targetUrl = target.url.replace("localhost", "127.0.0.1");
  const file = join(root, "index.json");
  const exported = await cli(sourceUrl, ["index", "export", "--file", file]);
  assert.equal(exported.code, 0, exported.stderr);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const bytes = readFileSync(file, "utf8");
  assert.ok(!bytes.includes(OWNER));
  const existing = await cli(sourceUrl, ["index", "export", "--file", file]);
  assert.equal(existing.code, 1);
  assert.match(existing.stderr, /^atelier: .*EEXIST/);
  assert.doesNotMatch(existing.stderr, /\n\s+at /);
  assert.equal(readFileSync(file, "utf8"), bytes);
  const imported = await cli(targetUrl, ["index", "import", "--file", file]);
  assert.equal(imported.code, 0, imported.stderr);
  assert.match((await cli(targetUrl, ["index", "import", "--file", file])).stdout, /unchanged.*nothing imported/);
  for (const argv of [["models"], ["models", "show", "gpt-6-astra", "--trend"], ["models", "show", "gpt-6-astra"], ["models", "roles"]]) {
    const r = await cli(targetUrl, argv);
    assert.equal(r.code, 0, `${argv.join(" ")}: ${r.stderr}`);
    if (argv.length === 1) assert.match(r.stdout, /Keep this dated note/);
    if (argv.length === 3 && argv[1] === "show") assert.match(r.stdout, /Vendor card c7.*withdrawn/);
    if (argv[1] === "roles") assert.match(r.stdout, /a3/);
  }
  const targetIndex = target.namespace.get(target.namespace.idFromName("__index"));
  assert.deepEqual((await targetIndex.exportIndex()).tables, (await sourceIndex.exportIndex()).tables);
});
