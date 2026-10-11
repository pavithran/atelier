import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// t486: atelier finding names the review a verdict answers with --review-seq
// or --reviewer, refusing both together and malformed values before any
// request, against a fake server that logs each request.

const cli = resolve("cli/atelier.mjs");
const HEAD = "a".repeat(40);

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-finding-"));
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
  let data = {}, status = 200;
  if (path === "/api/config") data = { ownerActor: "owner", ownerName: "Pavi" };
  else if (method === "POST" && path.endsWith("/items/t9/finding")) {
    if (body.reviewer === "codex/gpt-6-astra") { status = 409; data = { error: "ambiguous_review", detail: "codex/gpt-6-astra reviewed t9 at aaaaaaaa more than once: 12 by codex/gpt-6-astra (1 finding); 15 by codex/gpt-6-astra (1 finding); name one with --review-seq" }; }
    else data = { id: "t9", head: body.head, index: body.index, verdict: body.verdict, review: body.reviewSeq ?? 15, by: "codex/gpt-6-astra" };
  }
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
};
`);
  const run = (args) => spawnSync(process.execPath, ["--import", preload, cli, ...args], {
    cwd: dir, encoding: "utf8",
    env: { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_CACHE: join(dir, "cache"), ATELIER_TOKEN: "fake-owner-token", ATELIER_SERVER: "https://fake.invalid", ATELIER_ACTOR: "owner" },
  });
  const posts = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []).filter((q) => q.method === "POST");
  const clear = () => rmSync(log, { force: true });
  return { run, posts, clear };
}

const base = ["finding", "t9", "--project", "demo", "--head", HEAD, "--index", "1", "--verdict", "refuted"];

test("t486: finding refuses both selectors, a malformed --review-seq or --reviewer, and an unknown selector flag before any request", (t) => {
  const f = fixture(t);
  for (const [flags, expected] of [
    [["--review-seq", "12", "--reviewer", "codex/gpt-6-astra"], /--review-seq or by --reviewer, not both/],
    [["--review-seq", "0"], /--review-seq needs the review's sequence, a positive integer/],
    [["--review-seq", "1.5"], /--review-seq needs the review's sequence/],
    [["--review-seq", "x"], /--review-seq needs the review's sequence/],
    [["--review-seq"], /--review-seq/],
    [["--reviewer", "gpt"], /--reviewer needs the reviewer as harness\/model/],
    [["--review", "12"], /finding does not take --review/],
    [["--index", "1x"], /--index needs the finding's position/],
  ]) {
    f.clear();
    const r = f.run([...base, ...flags]);
    assert.equal(r.status, 1, flags.join(" "));
    assert.match(r.stderr, expected, flags.join(" "));
    assert.deepEqual(f.posts(), [], flags.join(" "));
  }
});

test("t486: finding sends the selector and names the review recorded; the server's refusal lists the reviews", (t) => {
  const f = fixture(t);
  const bySeq = f.run([...base, "--review-seq", "12"]);
  assert.equal(bySeq.status, 0, bySeq.stderr);
  assert.equal(bySeq.stdout, "Recorded refuted on finding 1 of t9's review 12 by codex/gpt-6-astra at aaaaaaaa. The Models page counts it under the reviewer.\n");
  assert.deepEqual(f.posts()[0].body, { head: HEAD, index: 1, verdict: "refuted", note: "", reviewSeq: 12 });
  f.clear();
  const byDefault = f.run(base);
  assert.equal(byDefault.status, 0, byDefault.stderr);
  assert.deepEqual(f.posts()[0].body, { head: HEAD, index: 1, verdict: "refuted", note: "" });
  f.clear();
  const ambiguous = f.run([...base, "--reviewer", "codex/gpt-6-astra"]);
  assert.notEqual(ambiguous.status, 0);
  assert.match(ambiguous.stderr, /12 by codex\/gpt-6-astra \(1 finding\); 15 by codex\/gpt-6-astra/);
  assert.deepEqual(f.posts()[0].body, { head: HEAD, index: 1, verdict: "refuted", note: "", reviewer: "codex/gpt-6-astra" });
});
