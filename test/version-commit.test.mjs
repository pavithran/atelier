// GET /api/version reports the commit the server's code is (Atelier 2.0,
// task 9): the COMMIT file a release holds, written by
// scripts/studio/install-server.sh, or a development checkout's HEAD.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { deployedMain, startServer } from "../src/runtime/server.mjs";

const root = mkdtempSync(join(tmpdir(), "atelier-server-version-"));
after(() => rmSync(root, { recursive: true, force: true }));
const dirUrl = (name) => { const d = join(root, name); mkdirSync(d, { recursive: true }); return { dir: d, url: pathToFileURL(`${d}/`) }; };
const SHA = "0123456789abcdef0123456789abcdef01234567";

test("a release's COMMIT file names the commit; one that holds anything else names none", () => {
  const r = dirUrl("release");
  writeFileSync(join(r.dir, "COMMIT"), `${SHA}\n`);
  assert.equal(deployedMain(r.url), SHA);
  const sha256 = "ab".repeat(32);
  writeFileSync(join(r.dir, "COMMIT"), sha256);
  assert.equal(deployedMain(r.url), sha256);
  for (const bad of ["", "main\n", SHA.toUpperCase(), `${SHA}\n${SHA}\n`, SHA.slice(1)]) {
    writeFileSync(join(r.dir, "COMMIT"), bad);
    assert.equal(deployedMain(r.url), undefined, JSON.stringify(bad));
  }
});

test("with no COMMIT file a development checkout gives its HEAD, and a directory that is neither gives none", () => {
  const c = dirUrl("checkout");
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: c.dir, env });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "first"], { cwd: c.dir, env });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: c.dir, encoding: "utf8" }).trim();
  assert.equal(deployedMain(c.url), head);
  // The COMMIT file wins over the checkout.
  writeFileSync(join(c.dir, "COMMIT"), `${SHA}\n`);
  assert.equal(deployedMain(c.url), SHA);
  const plain = dirUrl("plain");
  assert.equal(deployedMain(plain.url), undefined);
});

test("GET /api/version reports this checkout's commit, not null", async (t) => {
  const server = await startServer({ env: "test", dataDir: join(root, "data"), host: "127.0.0.1", vars: { ATELIER_TOKEN: "atl_00112233445566778899aabbccddeeff" } });
  t.after(() => server.close());
  const version = await (await fetch(`${server.url.replace("localhost", "127.0.0.1")}/api/version`)).json();
  assert.equal(version.commit, deployedMain());
  assert.match(version.commit, /^[0-9a-f]{40}$/);
});
