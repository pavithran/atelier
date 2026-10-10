import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { VERDICT_LIMITS } from "../src/review/verdict.ts";

// t407: `atelier review-unparsable` keeps a reviewer's reply that no verdict
// could be read from on the task, sending the server its last 100 KB with the
// reviewer and the head, as the request it held is released. The reply is
// read from the file the harness wrote, never passed as an argument, which
// the operating system caps far below a long reply.

const cli = resolve("cli/atelier.mjs");
const HEAD = "ab".repeat(20);
const REASON = "the reply states no verdict: it has no VERDICT line and no JSON verdict";

// A fake server taking the route, answering what the ledger answers: the
// first reply releases the request its reviewer held, a later one no claim
// stands for.
async function server(t) {
  const posts = [];
  const http = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      posts.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : null });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ kept: true, released: posts.length === 1 }));
    });
  });
  t.after(() => http.close());
  await new Promise((done, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", done); });
  return { posts, origin: `http://127.0.0.1:${http.address().port}` };
}

async function fixture(t) {
  const { posts, origin } = await server(t);
  const dir = mkdtempSync(join(tmpdir(), "atelier-unparsable-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (argv) => {
    const child = spawn(process.execPath, [cli, ...argv], { cwd: dir, env: { ...process.env, ATELIER_ACTOR: "codex/gpt-6-astra", ATELIER_CONFIG_DIR: dir, ATELIER_TOKEN: "fake", ATELIER_SERVER: origin } });
    let output = ""; child.stdout.on("data", (s) => { output += s; }); child.stderr.on("data", (s) => { output += s; });
    return new Promise((done) => child.on("close", (status) => done({ status, output })));
  };
  return { posts, run, dir };
}

test("review-unparsable posts the reply's last 100 KB with the head, the note and the reviewer", async (t) => {
  const { posts, run, dir } = await fixture(t);
  const whole = `${"a line of a reply with no verdict in it\n".repeat(3600)}the end of the reply`;
  assert.ok(whole.length > VERDICT_LIMITS.reply, `${whole.length} characters`);
  const file = join(dir, "verdict.txt");
  writeFileSync(file, whole);
  const r = await run(["review-unparsable", "t3", "--project", "atelier", "--head", HEAD, "--note", REASON, "--reply-file", file]);
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /Kept the unparsable review reply on t3, and released its review request\./);
  assert.deepEqual(posts, [{
    method: "POST", path: "/api/projects/atelier/items/t3/review-unparsable",
    body: { head: HEAD, note: REASON, reply: whole.slice(-VERDICT_LIMITS.reply) },
  }]);
  assert.equal(posts[0].body.reply.endsWith("the end of the reply"), true, "the reply's end is what is kept");

  // A reply inside the limit travels whole, and a request no longer held says so.
  writeFileSync(file, "Looks fine to me.");
  const late = await run(["review-unparsable", "t3", "--project", "atelier", "--head", HEAD, "--note", REASON, "--reply-file", file]);
  assert.equal(late.status, 0, late.output);
  assert.match(late.output, /^Kept the unparsable review reply on t3\.$/m);
  assert.equal(posts.at(-1).body.reply, "Looks fine to me.");
});

test("review-unparsable refuses a missing head, reply file or flag value", async (t) => {
  const { posts, run, dir } = await fixture(t);
  const file = join(dir, "verdict.txt");
  writeFileSync(file, "Looks fine.");
  const refusals = [
    [["review-unparsable", "t3", "--project", "atelier", "--note", REASON, "--reply-file", file], /--head needs the full revision the review read/],
    [["review-unparsable", "t3", "--project", "atelier", "--head", "short", "--reply-file", file], /--head needs the full revision the review read/],
    [["review-unparsable", "t3", "--project", "atelier", "--head", HEAD, "--note", REASON], /--reply-file needs the path of the file the harness wrote its reply to/],
    [["review-unparsable", "t3", "--project", "atelier", "--head", HEAD, "--note", REASON, "--reply-file", join(dir, "absent.txt")], /could not read the reply file/],
  ];
  for (const [argv, pattern] of refusals) {
    const r = await run(argv);
    assert.equal(r.status, 1, argv.join(" "));
    assert.match(r.output, pattern, argv.join(" "));
  }
  assert.deepEqual(posts, [], "nothing is posted");
});
