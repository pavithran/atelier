import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The owner's commands that feed each model's reliability record, run
// against a fake server: a preload replaces fetch, answers from fixed state
// and logs each request.

const cli = resolve("cli/atelier.mjs");
const HEAD = "a".repeat(40);

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-reliability-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ server: "https://fake.invalid", owner: "owner", ownerName: "Pavi", projects: {} }));
  const log = join(dir, "requests.jsonl");
  const preload = join(dir, "server.mjs");
  writeFileSync(preload, `
import { appendFileSync } from "node:fs";
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname, method = options.method ?? "GET";
  const body = options.body ? JSON.parse(options.body) : undefined;
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method, path, body, actor: options.headers?.["x-atelier-actor"] }) + "\\n");
  let data = {}, status = 200;
  if (path === "/api/config") data = { ownerActor: "owner", ownerName: "Pavi" };
  else if (method === "POST" && path.endsWith("/items/t9/defect")) data = { id: "t9", state: "merged", acceptedHead: ${JSON.stringify(HEAD)} };
  else if (method === "POST" && path.endsWith("/items/t8/defect")) { status = 409; data = { error: "not_accepted", detail: "t8 is not accepted at any revision" }; }
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
};
`);
  const run = (args) => spawnSync(process.execPath, ["--import", preload, cli, ...args], {
    cwd: dir, encoding: "utf8",
    env: { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_CACHE: join(dir, "cache"), ATELIER_TOKEN: "fake-owner-token", ATELIER_SERVER: "https://fake.invalid", ATELIER_ACTOR: "owner" },
  });
  const requests = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []);
  const clear = () => rmSync(log, { force: true });
  return { run, requests, clear };
}

test("t109: defect needs a note, refused before any request without one", (t) => {
  const f = fixture(t);
  for (const flags of [[], ["--note"], ["--note", "   "]]) {
    f.clear();
    const r = f.run(["defect", "t9", "--project", "demo", ...flags]);
    assert.equal(r.status, 1, flags.join(" "));
    assert.match(r.stderr, /--note needs text: atelier defect ID --note "what is wrong"|a defect needs a note: atelier defect ID --note "what is wrong" \[--found-in ID\]/);
    assert.deepEqual(f.requests().filter((q) => q.path !== "/api/config"), [], flags.join(" "));
  }
});

test("t109: defect sends the note and the task it was found in to the defect route, as the owner", (t) => {
  const f = fixture(t);
  const r = f.run(["defect", "t9", "--project", "demo", "--note", "  drops the last page  ", "--found-in", "t12"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "Defect traced to t9 at aaaaaaaa. It counts against the model that built that revision and each model that approved it; the Models page shows the record.\n");
  const sent = f.requests().find((q) => q.method === "POST");
  assert.deepEqual(sent, { method: "POST", path: "/api/projects/demo/items/t9/defect", body: { note: "drops the last page", foundIn: "t12" }, actor: "owner" });
  f.clear();
  assert.equal(f.run(["defect", "t9", "--project", "demo", "--note", "x"]).status, 0);
  assert.deepEqual(f.requests().find((q) => q.method === "POST").body, { note: "x" });
  // The server's refusal is printed as it said it.
  const refused = f.run(["defect", "t8", "--project", "demo", "--note", "x"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /not_accepted: t8 is not accepted at any revision/);
});
