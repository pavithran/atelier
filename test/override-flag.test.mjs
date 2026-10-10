import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// PAVI's decision, 2026-10-06: when no reviewer qualifies, the owner may
// override the independent review while accepting, as a recorded act with a
// required reason. `--override-review` takes that reason: a bare flag, an
// empty value and a blank one are refused before any request, and a reason
// reaches the accept route as overrideReview. The commands run against a
// fake server: a preload replaces fetch, answers from fixed state and logs
// each request.

const cli = resolve("cli/atelier.mjs");
const HEAD = "a".repeat(40);

function fixture(t, { availableReviewer } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-override-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ server: "https://fake.invalid", owner: "owner", ownerName: "Pavi", projects: {} }));
  const log = join(dir, "requests.jsonl");
  const preload = join(dir, "server.mjs");
  writeFileSync(preload, `
import { appendFileSync } from "node:fs";
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname, method = options.method ?? "GET";
  const body = options.body ? JSON.parse(options.body) : undefined;
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method, path, body }) + "\\n");
  let data = {};
  if (path === "/api/config") data = { ownerActor: "owner", ownerName: "Pavi" };
  else if (method === "GET" && path.endsWith("/items/t9")) data = { item: { id: "t9", state: "submitted", head: ${JSON.stringify(HEAD)} } };
  else if (method === "POST" && path.endsWith("/items/t9/accept")) data = { id: "t9", state: "accepted", acceptedHead: ${JSON.stringify(HEAD)}${availableReviewer ? `, availableReviewer: ${JSON.stringify(availableReviewer)}` : ""} };
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
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

test("decision 2026-10-06: a bare, empty or blank --override-review is refused before any request", (t) => {
  const f = fixture(t);
  for (const flag of [["--override-review"], ["--override-review="], ["--override-review", "   "]]) {
    f.clear();
    const r = f.run(["accept", "t9", "--project", "demo", ...flag]);
    assert.equal(r.status, 1, flag.join(" "));
    assert.match(r.stderr, /--override-review needs a reason: atelier accept ID --override-review "why no independent review is possible"/);
    assert.deepEqual(f.requests().filter((q) => q.path !== "/api/config"), [], flag.join(" "));
  }
  // merge takes the flag too, and refuses a bare one with its own form.
  f.clear();
  const bare = f.run(["merge", "t9", "--project", "demo", "--head", HEAD, "--override-review"]);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /--override-review needs a reason: atelier merge ID --head FULL_REVISION --override-review "why no independent review is possible"/);
  assert.deepEqual(f.requests().filter((q) => q.path !== "/api/config"), []);
  // merge records an override only while accepting a revision, so it needs --head.
  f.clear();
  const merge = f.run(["merge", "t9", "--project", "demo", "--override-review", "No other family"]);
  assert.equal(merge.status, 1);
  assert.match(merge.stderr, /--override-review is recorded while accepting a submitted revision/);
  assert.deepEqual(f.requests().filter((q) => q.path !== "/api/config"), []);
});

test("decision 2026-10-06: accept --override-review sends its reason with the head to the accept route", (t) => {
  const f = fixture(t);
  const r = f.run(["accept", "t9", "--project", "demo", "--override-review", "  No model of another family is available  "]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "t9 accepted at aaaaaaaa, with the independent review overridden. Merge it with: atelier merge t9\n");
  const accept = f.requests().find((q) => q.method === "POST" && q.path === "/api/projects/demo/items/t9/accept");
  assert.deepEqual(accept.body, { head: HEAD, overrideReview: "No model of another family is available" });
  // Without the flag, no override is sent.
  f.clear();
  assert.equal(f.run(["accept", "t9", "--project", "demo"]).status, 0);
  assert.deepEqual(f.requests().find((q) => q.method === "POST").body, { head: HEAD });
});

test("decision 2026-10-09: accept --override-review names an available reviewer and the land command that replaces the override", (t) => {
  const f = fixture(t, { availableReviewer: "codex/gpt-6-astra" });
  const r = f.run(["accept", "t9", "--project", "demo", "--override-review", "No model of another family is available"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "t9 accepted at aaaaaaaa, with the independent review overridden; codex/gpt-6-astra was available to review it instead: atelier land t9 --reviewer codex/gpt-6-astra. Merge it with: atelier merge t9\n");
  // A plain accept never names a reviewer.
  f.clear();
  const plain = f.run(["accept", "t9", "--project", "demo"]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout, "t9 accepted at aaaaaaaa. Merge it with: atelier merge t9\n");
});
