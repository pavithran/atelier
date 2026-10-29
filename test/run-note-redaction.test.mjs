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
const PATHS = ["could not read /srv/keys=prod/app.log", "KEY_FILE=/etc/atelier/k.pem missing", "cp ~/build/TOKEN=x/out.txt ."];

test("the shared redactor removes assignments, any-case bearer and basic credentials and authorization headers, and keeps paths with = in them", () => {
  for (const [note, secret] of LEAKS) {
    const out = redactKeys(note);
    assert.ok(!out.includes(secret), `${note} -> ${out}`);
    assert.match(out, /\[key removed\]/);
  }
  assert.equal(redactKeys("API_TOKEN=abc123def456 rejected"), "API_TOKEN=[key removed] rejected");
  assert.equal(redactKeys("curl -H 'Authorization: Bearer abc.def-ghi9' failed"), "curl -H 'Authorization: [key removed]' failed");
  assert.equal(redactKeys("got bearer abcdefgh123 back"), "got bearer [key removed] back");
  for (const path of PATHS) assert.equal(redactKeys(path), path);
  // The words a harness writes around them stay.
  assert.equal(redactKeys("basic auth failed for user"), "basic auth failed for user");
});

test("the runner's copy: stderrSummary removes them before the note leaves the runner", () => {
  for (const [note, secret] of LEAKS) {
    const summary = stderrSummary(`starting\n${note}\n`);
    assert.ok(!summary.includes(secret), summary);
    assert.match(summary, /\[key removed\]/);
  }
  assert.equal(stderrSummary(`${PATHS[0]}\n`), PATHS[0]);
});

test("the server's copy: a run report sent with the secrets in it is stored without them, paths kept", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atelier-run-notes-"));
  dirs.push(root);
  const secrets = join(root, "secrets");
  mkdirSync(secrets, { mode: 0o700 });
  writeFileSync(join(secrets, "ATELIER_TOKEN"), OWNER, { mode: 0o600 });
  const server = await startServer({ env: "staging", dataDir: join(root, "data"), host: "127.0.0.1", secretsDir: secrets });
  t.after(() => server.close());
  const call = async (method, body) => {
    const res = await fetch(`${server.url}/api/runs`, { method, headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json", "x-atelier-actor": "owner", "x-atelier-acting": "claude-code/opus-5.5" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  // The note goes unredacted on purpose: the server does not trust the runner's copy.
  const detail = `${LEAKS.slice(0, 5).map(([n]) => n).join(" / ")} / ${PATHS[0]}`;
  const sent = await call("POST", { actor: "opencode/glm-5.3", role: "build", outcome: "harness_failed", project: "demo", item: "t1", detail });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  const listed = await call("GET");
  assert.equal(listed.status, 200);
  const stored = JSON.stringify(listed.body);
  for (const [, secret] of LEAKS.slice(0, 5)) assert.ok(!stored.includes(secret), `${secret} reached the stored note: ${stored}`);
  assert.ok(stored.includes("API_TOKEN=[key removed]"), stored);
  assert.ok(stored.includes("PASSWORD=[key removed]"), stored);
  assert.ok(stored.includes(PATHS[0]), stored);
});
