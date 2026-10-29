// G15 (lessons-to-2.0, CA3, row 47): run notes are redacted for assignments
// as well as key shapes, in both copies: the runner's stderrSummary before a
// note leaves it, and the server's cleanRun before a run report is stored.
// Each server test starts the real Node server. Every credential is a dummy.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { startServer } from "../src/runtime/server.mjs";
import { redactKeys } from "../src/models/pool.ts";
import { stderrSummary } from "../cli/runner.mjs";

const OWNER = "atl_00112233445566778899aabbccddeeff";
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// Each secret, the words around it that must survive, and the secret itself.
const LEAKS = [
  ["API_TOKEN=abc123def456 rejected", "abc123def456"],
  ["PASSWORD=hunter2 rejected", "hunter2"],
  ["curl -H 'Authorization: Bearer abc.def-ghi9' failed", "abc.def-ghi9"],
  ["authorization: basic dXNlcjpwYXNzd29yZA== failed", "dXNlcjpwYXNzd29yZA=="],
  ["AUTHORIZATION: token tok12345abc failed", "tok12345abc"],
  ["got bearer abcdefgh123 back", "abcdefgh123"],
  ["sent BASIC dXNlcjpwYXNz", "dXNlcjpwYXNz"],
  ["Bearer zyxwvut98765 refused", "zyxwvut98765"],
];
// A path with = in it, a directory so named mid-path, is no assignment.
const PATHS = ["could not read /srv/keys=prod/app.log", "cp ~/build/TOKEN=x/out.txt ."];

// The shared redactor is G3/G4's (src/models/pool.ts): a credential-named
// assignment loses everything to the end of the line, and basic or bearer
// the next word, whatever it is.
test("the shared redactor removes assignments, any-case bearer and basic credentials and authorization headers, and keeps paths with = in them", () => {
  for (const [note, secret] of LEAKS) {
    const out = redactKeys(note);
    assert.ok(!out.includes(secret), `${note} -> ${out}`);
    assert.match(out, /\[key removed\]/);
  }
  assert.equal(redactKeys("API_TOKEN=abc123def456 rejected"), "API_TOKEN=[key removed]");
  assert.equal(redactKeys("curl -H 'Authorization: Bearer abc.def-ghi9' failed"), "curl -H 'Authorization: [key removed]' failed");
  assert.equal(redactKeys("got bearer abcdefgh123 back"), "got bearer [key removed] back");
  for (const path of PATHS) assert.equal(redactKeys(path), path);
  // Blunt by design: a value that is a path goes, and so does the word after basic.
  assert.equal(redactKeys("KEY_FILE=/etc/atelier/k.pem missing"), "KEY_FILE=[key removed]");
  assert.equal(redactKeys("basic auth failed for user"), "basic [key removed] failed for user");
});

test("the runner's copy: stderrSummary removes them before the note leaves the runner", () => {
  for (const [note, secret] of LEAKS) {
    const summary = stderrSummary(`starting\n${note}\n`);
    assert.ok(!summary.includes(secret), summary);
    assert.match(summary, /\[key removed\]/);
  }
  assert.equal(stderrSummary(`${PATHS[0]}\n`), PATHS[0]);
});

test("the server's copy: a runner's report with text is refused, and one of facts keeps its facts alone; a report the developer records by hand is redacted", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atelier-run-notes-"));
  dirs.push(root);
  const secrets = join(root, "secrets");
  mkdirSync(secrets, { mode: 0o700 });
  writeFileSync(join(secrets, "ATELIER_TOKEN"), OWNER, { mode: 0o600 });
  const server = await startServer({ env: "staging", dataDir: join(root, "data"), host: "127.0.0.1", secretsDir: secrets });
  t.after(() => server.close());
  const call = async (method, body, extra = {}) => {
    const res = await fetch(`${server.url}/api/runs`, { method, headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json", "x-atelier-actor": "owner", "x-atelier-acting": "claude-code/opus-5.5", ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  // Sent unredacted on purpose: the server trusts neither copy.
  const detail = LEAKS.slice(0, 5).map(([n]) => n).join(" / ");
  const facts = { exitCode: 1, signal: null, program: "opencode", lines: 12, bytes: 480, log: "/var/log/atelier/run.log", host: "studio" };
  // A runner sending the run's text is refused, naming the next command; nothing is kept.
  const raw = await call("POST", { actor: "opencode/glm-5.3", role: "build", outcome: "harness_failed", project: "demo", item: "t1", detail, facts }, { "x-atelier-runner": "home:studio" });
  assert.equal(raw.status, 400, JSON.stringify(raw.body));
  assert.equal(raw.body.error, "not_facts");
  assert.ok(raw.body.next);
  const byRunner = await call("POST", { actor: "opencode/glm-5.3", role: "build", outcome: "harness_failed", project: "demo", item: "t1", facts }, { "x-atelier-runner": "home:studio" });
  assert.equal(byRunner.status, 201, JSON.stringify(byRunner.body));
  const byHand = await call("POST", { actor: "opencode/glm-5.3", role: "build", outcome: "harness_failed", project: "demo", item: "t2", detail });
  assert.equal(byHand.status, 201, JSON.stringify(byHand.body));
  const listed = (await call("GET")).body;
  const stored = JSON.stringify(listed);
  for (const [, secret] of LEAKS.slice(0, 5)) assert.ok(!stored.includes(secret), `${secret} reached a stored note: ${stored}`);
  const runner = listed.find((r) => r.item === "t1"), hand = listed.find((r) => r.item === "t2");
  assert.equal(runner.detail, "opencode; exit 1; 12 lines, 480 bytes of output; log studio:/var/log/atelier/run.log", "a runner's report keeps its facts alone");
  assert.match(hand.detail, /^API_TOKEN=\[key removed\]/);
});

// Round 1 of astra's review (finding 1): credentials the redactor here lets
// through. The fix is G3/G4's shared redactor (2.0/g34-read), which merges
// into the 2.0 branch first; these stay todo until that merge brings it, and
// must then pass on it. Each secret, and the text around it that must stay.
const ROUND_ONE = [
  ["Authorization: Custom abc123", "abc123"],
  ['Authorization: Digest username="u", realm="r", response="6629fae49393a05397450978507c4ef1"', "6629fae49393a05397450978507c4ef1"],
  ["curl -H 'Authorization: basic dTpw'", "dTpw"],
  ['{"authorization": "tok123abc", "ok": 1}', "tok123abc"],
];
test("round 1: a custom scheme, a Digest response, a short basic credential and a quoted JSON authorization are removed, in both copies", () => {
  for (const [note, secret] of ROUND_ONE) {
    assert.ok(!redactKeys(note).includes(secret), `${note} -> ${redactKeys(note)}`);
    assert.ok(!stderrSummary(`${note}\n`).includes(secret), `runner copy: ${stderrSummary(note)}`);
  }
});
