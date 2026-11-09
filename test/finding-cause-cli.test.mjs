import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// t536: atelier finding --cause corrects a finding's cause (--index) or sets
// a failed check's (--failure), refusing a malformed request before any
// request, against a fake server that logs each request.

const cli = resolve("cli/atelier.mjs");

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-finding-cause-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ server: "https://fake.invalid", owner: "owner", ownerName: "Pavi", projects: {} }));
  const log = join(dir, "requests.jsonl");
  const preload = join(dir, "server.mjs");
  writeFileSync(preload, `
import { appendFileSync } from "node:fs";
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname, method = options.method ?? "GET";
  const body = options.body ? JSON.parse(options.body) : undefined;
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method, path, body, acting: options.headers?.["x-atelier-acting"] ?? null }) + "\\n");
  let data = {};
  if (path === "/api/config") data = { ownerActor: "owner", ownerName: "Pavi" };
  else if (path.endsWith("/items/t9/finding-cause")) data = { id: "t9", review: 12, by: "codex/gpt-6-astra", from: "unknown", cause: body.cause, event: 40, acting: "zcode/glm-5.3" };
  else if (path.endsWith("/items/t9/check-cause")) data = body.failure === 7 ? { id: "t9", failure: 7, from: "wiring", cause: body.cause, event: null } : { id: "t9", failure: body.failure, from: "unknown", cause: body.cause, event: 41, acting: "zcode/glm-5.3" };
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
};
`);
  const run = (args) => spawnSync(process.execPath, ["--import", preload, cli, ...args], {
    cwd: dir, encoding: "utf8",
    env: { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_CACHE: join(dir, "cache"), ATELIER_TOKEN: "fake-owner-token", ATELIER_SERVER: "https://fake.invalid", ATELIER_ACTOR: "zcode/glm-5.3" },
  });
  const posts = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []).filter((q) => q.method === "POST");
  return { run, posts, clear: () => rmSync(log, { force: true }) };
}

const base = ["finding", "t9", "--project", "demo"];

test("t536: finding --cause refuses a malformed request before any request", (t) => {
  const f = fixture(t);
  for (const [flags, expected] of [
    [["--index", "1", "--cause"], /--cause/],
    [["--index", "1", "--cause", "typo"], /--cause must be one of/],
    [["--index", "1", "--cause", "unknown"], /--cause must be one of/],
    [["--cause", "spec"], /--index needs the finding's position/],
    [["--index", "0", "--cause", "spec"], /--index needs the finding's position/],
    [["--index", "1", "--cause", "spec", "--verdict", "refuted"], /two commands/],
    [["--failure", "0", "--cause", "spec"], /--failure needs the sequence/],
    [["--failure", "7", "--index", "1", "--cause", "spec"], /--failure names a failed check/],
    [["--index", "1", "--cause", "spec", "--head", "abc"], /--head needs the full revision/],
    [["--index", "1", "--cause", "spec", "--review-seq", "3", "--reviewer", "codex/gpt-6-astra"], /not both/],
  ]) {
    f.clear();
    const r = f.run([...base, ...flags]);
    assert.equal(r.status, 1, flags.join(" "));
    assert.match(r.stderr, expected, flags.join(" "));
    assert.deepEqual(f.posts(), [], flags.join(" "));
  }
});

test("t536: finding --cause posts the correction, and --failure the check's cause, each with the acting model", (t) => {
  const f = fixture(t);
  const one = f.run([...base, "--index", "2", "--cause", "spec", "--review-seq", "12"]);
  assert.equal(one.status, 0, one.stderr);
  assert.equal(one.stdout, "Recorded cause spec (was unknown) on finding 2 of t9's review 12 by codex/gpt-6-astra as event 40, changed by zcode/glm-5.3.\n");
  assert.match(f.posts()[0].path, /\/items\/t9\/finding-cause$/);
  assert.deepEqual(f.posts()[0].body, { index: 2, cause: "spec", reviewSeq: 12 });
  assert.equal(f.posts()[0].acting, "zcode/glm-5.3");
  f.clear();
  const check = f.run([...base, "--failure", "31", "--cause", "wiring"]);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(check.stdout, "Recorded cause wiring (was unknown) on t9's failed check 31 as event 41, set by zcode/glm-5.3.\n");
  assert.match(f.posts()[0].path, /\/items\/t9\/check-cause$/);
  assert.deepEqual(f.posts()[0].body, { failure: 31, cause: "wiring" });
  f.clear();
  const same = f.run([...base, "--failure", "7", "--cause", "wiring"]);
  assert.equal(same.stdout, "The cause of t9's failed check 7 is already wiring; nothing recorded.\n");
});
