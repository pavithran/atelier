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
  else if (method === "POST" && path.endsWith("/items/t9/finding")) data = { id: "t9", head: ${JSON.stringify(HEAD)}, index: 2, verdict: "refuted" };
  else if (method === "POST" && path === "/api/runs") data = { actor: body.actor, role: body.role, outcome: body.outcome, project: body.project ?? null, item: body.item ?? null, detail: body.detail ?? "", runner: "owner", at: "2026-10-06T00:00:00.000Z" };
  else if (method === "POST" && path.endsWith("/served")) {
    const matched = [
      { seq: 12, itemId: "t2", kind: "item.claimed", at: "2026-10-04T16:05:00.000Z", actor: "zcode/glm-5.3", served: null },
      { seq: 15, itemId: "t2", kind: "push.observed", at: "2026-10-04T16:30:00.000Z", actor: "zcode/glm-5.3", served: "deepseek-flash" },
    ];
    data = { project: "atelier", served: body.served, recorded: body.recorded, from: "2026-10-04T16:00:00.000Z", to: "2026-10-05T20:17:00.000Z", items: body.items ?? null, matched, pending: 1, annotated: body.apply ? 1 : 0, applied: body.apply };
  }
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

// t95: the owner records which model served events recorded under another.
test("t95: served needs the model, --recorded, --from and --to, and asks nothing of the server without them", (t) => {
  const f = fixture(t);
  const full = ["deepseek-flash", "--recorded", "zcode/glm-5.3", "--from", "2026-10-04T16:00:00Z", "--to", "2026-10-05T20:17:00Z"];
  for (const args of [full.slice(1), full.slice(0, 5), full.slice(0, 3).concat(full.slice(5)), [...full.slice(0, 5), "--to"]]) {
    f.clear();
    const r = f.run(["served", ...args, "--project", "atelier"]);
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.stderr, /usage: atelier served MODEL --recorded HARNESS\/MODEL --from TIME --to TIME|--to needs a value/, args.join(" "));
    assert.deepEqual(f.requests().filter((q) => q.path !== "/api/config"), [], args.join(" "));
  }
});

test("t95: served lists the matches and records nothing without --apply; with it, it annotates and says under which actor they count", (t) => {
  const f = fixture(t);
  const args = ["served", "deepseek-flash", "--recorded", "zcode/glm-5.3", "--from", "2026-10-04T16:00:00Z", "--to", "2026-10-05T20:17:00Z", "--project", "atelier", "--item", "t2", "--item", "t11", "--note", "per model_usage"];
  const dry = f.run(args);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(dry.stdout, [
    "2 events on atelier recorded as zcode/glm-5.3 from 2026-10-04T16:00:00.000Z to 2026-10-05T20:17:00.000Z, in t2 t11:",
    "  t2  #12  item.claimed  2026-10-04T16:05:00.000Z",
    "  t2  #15  push.observed  2026-10-04T16:30:00.000Z  annotated as served by deepseek-flash",
    "Nothing was recorded. To annotate 1 as served by deepseek-flash, run this again with --apply.",
    "",
  ].join("\n"));
  assert.deepEqual(f.requests().find((q) => q.method === "POST"), {
    method: "POST", path: "/api/projects/atelier/served", actor: "owner",
    body: { served: "deepseek-flash", recorded: "zcode/glm-5.3", from: "2026-10-04T16:00:00Z", to: "2026-10-05T20:17:00Z", items: ["t2", "t11"], note: "per model_usage", apply: false },
  });
  f.clear();
  const applied = f.run([...args, "--apply"]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /\nAnnotated 1 as served by deepseek-flash; 1 already were\. The records count them under zcode\/deepseek-flash\.\n$/);
  assert.equal(f.requests().find((q) => q.method === "POST").body.apply, true);
});

// t186: comparative agent data, the owner's commands.
test("t186: finding refuses a bad verdict, head or index before any request, and records a verdict as the owner", (t) => {
  const f = fixture(t);
  for (const [argv, message] of [
    [["finding", "t9", "--project", "demo", "--head", HEAD, "--index", "1"], /--verdict must be confirmed, refuted or fixed/],
    [["finding", "t9", "--project", "demo", "--head", "abc", "--index", "1", "--verdict", "confirmed"], /--head needs the full revision/],
    [["finding", "t9", "--project", "demo", "--head", HEAD, "--index", "0", "--verdict", "confirmed"], /--index needs the finding's position/],
  ]) {
    f.clear();
    const r = f.run(argv);
    assert.equal(r.status, 1, argv.join(" "));
    assert.match(r.stderr, message, argv.join(" "));
    assert.deepEqual(f.requests().filter((q) => q.path !== "/api/config"), [], argv.join(" "));
  }
  const ok = f.run(["finding", "t9", "--project", "demo", "--head", HEAD, "--index", "2", "--verdict", "refuted", "--note", "the code already names it"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, "Recorded refuted on finding 2 of t9's review at aaaaaaaa. The Models page counts it under the reviewer.\n");
  assert.deepEqual(f.requests().find((q) => q.method === "POST"), { method: "POST", path: "/api/projects/demo/items/t9/finding", body: { head: HEAD, index: 2, verdict: "refuted", note: "the code already names it" }, actor: "owner" });
});

test("t186: run-report refuses a bad actor, role or outcome before any request, and records one as the owner", (t) => {
  const f = fixture(t);
  for (const [argv, message] of [
    [["run-report", "--role", "build", "--outcome", "early_stop"], /usage: atelier run-report --actor H\/M/],
    [["run-report", "--actor", "opencode/glm-5.3", "--role", "plan", "--outcome", "early_stop"], /--role must be build or review/],
    [["run-report", "--actor", "opencode/glm-5.3", "--outcome", "crashed"], /--outcome must be one of stalled, timed-out, refused, early_stop, permission_stop, duplicate_design, incomplete_merge/],
  ]) {
    f.clear();
    const r = f.run(argv);
    assert.equal(r.status, 1, argv.join(" "));
    assert.match(r.stderr, message, argv.join(" "));
    assert.deepEqual(f.requests().filter((q) => q.path !== "/api/config"), [], argv.join(" "));
  }
  const ok = f.run(["run-report", "--actor", "opencode/glm-5.3", "--role", "build", "--outcome", "early_stop", "--project", "atelier", "--item", "t114", "--detail", "stopped after a refused read"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, "Recorded a build run (early_stop) by opencode/glm-5.3 on atelier/t114.\n");
  assert.deepEqual(f.requests().find((q) => q.method === "POST"), { method: "POST", path: "/api/runs", body: { actor: "opencode/glm-5.3", role: "build", outcome: "early_stop", project: "atelier", item: "t114", detail: "stopped after a refused read" }, actor: "owner" });
});
