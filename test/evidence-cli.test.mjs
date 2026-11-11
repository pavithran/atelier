import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { relayedLine } from "../cli/commands/show.mjs";
import { CLAIM_MAX, OUTPUT_MAX } from "../src/text.ts";

// atelier evidence (t497) against a server stood in for by node:http. The
// route's own checks are tested through worker.fetch in
// relayed-evidence.spec.ts; here the command's: what it reads on the caller's
// machine, what it refuses before anything is sent, and what it sends and says.

const cli = resolve("cli/atelier.mjs");
const H1 = "1".repeat(40);
const ACTING = "claude-code/opus-5.5";

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "atelier-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  const requests = [];
  const seen = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method, path: req.url, actor: req.headers["x-atelier-actor"], acting: req.headers["x-atelier-acting"], body });
    const answer = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.method !== "POST" || req.url !== "/api/projects/proj/items/t1/evidence-note") return answer(404, { error: "not_found", detail: "no such route" });
    if (body.head !== H1) return answer(409, { error: "stale_head", detail: "evidence is for another head" });
    const key = JSON.stringify([body.head, body.note, body.quote, body.outputTail]);
    const already = seen.includes(key);
    if (!already) seen.push(key);
    answer(200, { item: { id: "t1" }, alreadyRecorded: already });
  });
  t.after(() => server.close());
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  writeFileSync(join(root, "config.json"), JSON.stringify({ projects: { proj: { path: checkout } } }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function run(argv, extra = {}) {
    const env = { ...process.env, ATELIER_CONFIG_DIR: root, ATELIER_CACHE: join(root, "cache"), ATELIER_TOKEN: "fake", ATELIER_SERVER: origin, ...extra };
    delete env.ATELIER_ACTOR; delete env.ATELIER_OWNER; if (!("ATELIER_ACTING" in extra)) delete env.ATELIER_ACTING;
    const child = spawn(process.execPath, [cli, ...argv], { cwd: checkout, env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (s) => stdout += s);
    child.stderr.on("data", (s) => stderr += s);
    const status = await new Promise((done) => child.on("close", done));
    return { status, stdout, stderr };
  }
  return { run, requests, root };
}

const base = ["evidence", "t1", "--head", H1, "--project", "proj"];

test("atelier evidence sends the note as the developer with the acting model, and says it is recorded", async (t) => {
  const f = await fixture(t);
  const r = await f.run([...base, "--note", "Journey suite on the Mac: 226 passed"], { ATELIER_ACTING: ACTING });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.requests, [{ method: "POST", path: "/api/projects/proj/items/t1/evidence-note", actor: "owner", acting: ACTING, body: { head: H1, note: "Journey suite on the Mac: 226 passed" } }]);
  assert.match(r.stdout, /^t1: recorded at 11111111 for review, apart from reports\./);
  assert.match(r.stdout, /no required check/);
});

test("--file sends the file's last OUTPUT_MAX characters with its whole length, and says when it was cut", async (t) => {
  const f = await fixture(t);
  const whole = `${"a".repeat(OUTPUT_MAX + 30)}END`;
  writeFileSync(join(f.root, "out.log"), whole);
  const r = await f.run([...base, "--note", "budget", "--file", join(f.root, "out.log")], { ATELIER_ACTING: ACTING });
  assert.equal(r.status, 0, r.stderr);
  const body = f.requests[0].body;
  assert.equal(body.outputTail.length, OUTPUT_MAX);
  assert.ok(body.outputTail.endsWith("END"));
  assert.equal(body.outputLength, whole.length);
  assert.match(r.stdout, new RegExp(`Its file was cut to the last ${OUTPUT_MAX} of ${whole.length} characters`));
  // A short file is sent whole and no cut is said.
  writeFileSync(join(f.root, "short.log"), "ok 3");
  const short = await f.run([...base, "--note", "short", "--file", join(f.root, "short.log")], { ATELIER_ACTING: ACTING });
  assert.deepEqual([f.requests[1].body.outputTail, f.requests[1].body.outputLength], ["ok 3", 4]);
  assert.doesNotMatch(short.stdout, /cut/);
});

test("a missing file, a note over CLAIM_MAX and a bare flag are refused before anything is sent", async (t) => {
  const f = await fixture(t);
  const missing = await f.run([...base, "--note", "x", "--file", join(f.root, "absent.log")], { ATELIER_ACTING: ACTING });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /cannot read --file .*absent\.log: ENOENT; nothing was sent/);
  const dir = await f.run([...base, "--note", "x", "--file", f.root], { ATELIER_ACTING: ACTING });
  assert.equal(dir.status, 1);
  assert.match(dir.stderr, /cannot read --file/);
  const long = await f.run([...base, "--note", "n".repeat(CLAIM_MAX + 1)], { ATELIER_ACTING: ACTING });
  assert.equal(long.status, 1);
  assert.match(long.stderr, new RegExp(`the note is ${CLAIM_MAX + 1} characters; the limit is ${CLAIM_MAX}`));
  assert.equal((await f.run([...base], { ATELIER_ACTING: ACTING })).status, 1);
  assert.equal(f.requests.length, 0);
  // Exactly CLAIM_MAX is sent.
  assert.equal((await f.run([...base, "--note", "n".repeat(CLAIM_MAX)], { ATELIER_ACTING: ACTING })).status, 0);
});

test("--quote sends the developer's words only when given, and needs the acting model", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run([...base, "--note", "look", "--quote", "that matches"], { ATELIER_ACTING: ACTING })).status, 0);
  assert.equal(f.requests[0].body.quote, "that matches");
  assert.equal((await f.run([...base, "--note", "no words"], { ATELIER_ACTING: ACTING })).status, 0);
  assert.ok(!("quote" in f.requests[1].body));
  const none = await f.run([...base, "--note", "unattributed", "--quote", "yes"]);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /names the model acting for the developer/);
  assert.equal((await f.run([...base, "--note", "blank", "--quote", "  "], { ATELIER_ACTING: ACTING })).status, 1);
  assert.equal(f.requests.length, 2);
});

test("the same evidence sent again says it is already recorded", async (t) => {
  const f = await fixture(t);
  const argv = [...base, "--note", "again"];
  assert.match((await f.run(argv, { ATELIER_ACTING: ACTING })).stdout, /recorded at 11111111/);
  const second = await f.run(argv, { ATELIER_ACTING: ACTING });
  assert.equal(second.status, 0);
  assert.match(second.stdout, /already recorded at 11111111; nothing new was recorded/);
});

test("a stale head is the server's refusal, and atelier show's line carries the words as a decision's are printed", async (t) => {
  const f = await fixture(t);
  const r = await f.run(["evidence", "t1", "--head", "2".repeat(40), "--note", "x", "--project", "proj"], { ATELIER_ACTING: ACTING });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /stale_head/);
  const line = relayedLine({ head: H1, at: "2026-11-11T12:00:00.000Z", by: "owner", acting: ACTING, quote: "that matches", claim: "Captures", outputTail: "ok", outputLength: 2 });
  assert.equal(line, `  2026-11-11 12:00 at 11111111 by owner, acting ${ACTING}, on the developer's words: “that matches”, relayed by ${ACTING}: Captures [file: 2 characters]`);
  assert.doesNotMatch(relayedLine({ head: H1, at: "2026-11-11T12:00:00.000Z", by: "owner", claim: "Plain" }), /words/);
});
