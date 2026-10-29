// The shared redactor (redactKeys in src/models/pool.ts), which the run notes
// (G15), the progress line's server copy (G21) and the runner's stderr
// summary all use. The cases are the gap batch's G15 tests
// (2.0/gaps-batch, test/run-note-redaction.test.mjs), round one included,
// with a short basic credential and paths holding "=". Every credential here is a dummy.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { redactKeys } from "../src/models/pool.ts";
import { stderrSummary } from "../cli/runner.mjs";

const LEAKS = [
  ["API_TOKEN=abc123def456 rejected", "abc123def456"],
  ["PASSWORD=hunter2 rejected", "hunter2"],
  ["curl -H 'Authorization: Bearer abc.def-ghi9' failed", "abc.def-ghi9"],
  ["authorization: basic dXNlcjpwYXNzd29yZA== failed", "dXNlcjpwYXNzd29yZA=="],
  ["AUTHORIZATION: token tok12345abc failed", "tok12345abc"],
  ["got bearer abcdefgh123 back", "abcdefgh123"],
  ["sent BASIC dXNlcjpwYXNz", "dXNlcjpwYXNz"],
  ["Bearer zyxwvut98765 refused", "zyxwvut98765"],
  ["basic dTpw", "dTpw"],
  ["BASIC dTpw sent", "dTpw"],
  // Round 6: any word after basic or bearer, and any credential-named value to the line's end.
  ["basic ajpw", "ajpw"],
  ["basic dTpw. failed", "dTpw"],
  ["Bearer abc,def;ghi", "abc"],
  ["PASSWORD=prefix\u00a0secretvalue", "secretvalue"],
  ["PASSWORD=prefix\\ secretvalue", "secretvalue"],
  ["PASSWORD=/hunter2", "hunter2"],
  ["KEY_FILE=/etc/atelier/k.pem missing", "k.pem"],
  ["db_pwd=x y z", "y z"],
  ["--client-credential=s3cr3t rest", "s3cr3t"],
  ["Auth_Header=xyz", "xyz"],
];
const ROUND_ONE = [
  ["Authorization: Custom abc123", "abc123"],
  ['Authorization: Digest username="u", realm="r", response="6629fae49393a05397450978507c4ef1"', "6629fae49393a05397450978507c4ef1"],
  ["curl -H 'Authorization: basic dTpw'", "dTpw"],
  ['{"authorization": "tok123abc", "ok": 1}', "tok123abc"],
];
// Paths with = in them whose name is not a credential's, or that stand mid-path.
const PATHS = ["could not read /srv/keys=prod/app.log", "cp ~/build/TOKEN=x/out.txt .", "/tmp/a=b/file", "--out=/x/y=z", "OUT_DIR=/tmp/a=b/c"];

test("credential-named assignments to the line's end, the word after bearer or basic in any case, and credential headers are removed", () => {
  for (const [note, secret] of [...LEAKS, ...ROUND_ONE]) {
    const out = redactKeys(note);
    assert.ok(!out.includes(secret), `${note} -> ${out}`);
    assert.match(out, /\[key removed\]/);
  }
  assert.equal(redactKeys("API_TOKEN=abc123def456 rejected"), "API_TOKEN=[key removed]", "to the end of the line");
  assert.equal(redactKeys("curl -H 'Authorization: Bearer abc.def-ghi9' failed"), "curl -H 'Authorization: [key removed]' failed");
  assert.equal(redactKeys("got bearer abcdefgh123 back"), "got bearer [key removed] back");
  assert.equal(redactKeys("basic dTpw"), "basic [key removed]");
});

test("paths with = in them are kept unless a credential names them; the word after basic always goes", () => {
  for (const path of PATHS) assert.equal(redactKeys(path), path);
  assert.equal(redactKeys("basic auth failed for user"), "basic [key removed] failed for user");
  assert.equal(redactKeys("PASSWORD=/hunter2 and more"), "PASSWORD=[key removed]");
  assert.equal(redactKeys("PASSWORD=prefix\u00a0secretvalue"), "PASSWORD=[key removed]");
  assert.equal(redactKeys("Bearer {env:GATEWAY_TOKEN}"), "Bearer {env:GATEWAY_TOKEN}", "a placeholder holds no secret");
});

test("the runner's copy: stderrSummary removes them before a note leaves the runner, and keeps paths", () => {
  for (const [note, secret] of [...LEAKS, ...ROUND_ONE]) {
    const summary = stderrSummary(`starting\n${note}\n`);
    assert.ok(!summary.includes(secret), summary);
  }
  assert.equal(stderrSummary(`${PATHS[0]}\n`), PATHS[0]);
});

test("round 7: a placeholder is exempt only as a whole word, and quoted fields use the one credential-name list", () => {
  for (const [note, secret] of [["bearer ${TOKEN}hunter2", "hunter2"], ["bearer {env:TOKEN}hunter2", "hunter2"], ["basic [keyhunter2", "hunter2"], ["Bearer $TOKENhunter2x", "hunter2"],
    ['{"pwd":"hunter2"}', "hunter2"], ['{"passwd": "hunter2"}', "hunter2"], ["{'auth': 'hunter2'}", "hunter2"], ['{"db_password":"hunter2"}', "hunter2"], ['{"session_cookie": "hunter2"}', "hunter2"]]) {
    assert.ok(!redactKeys(note).includes(secret), `${note} -> ${redactKeys(note)}`);
    assert.ok(!stderrSummary(`${note}\n`).includes(secret), `runner copy: ${note}`);
  }
  for (const kept of ["Bearer ${TOKEN}", "Bearer {env:GATEWAY_TOKEN}", "bearer $TOKEN", "Bearer [key removed] sent"]) assert.equal(redactKeys(kept), kept);
});

test("round 8: an already-removed credential stays only as a whole word, and a credential field loses a value of any JSON type", () => {
  for (const [note, secret] of [["Bearer [key removed]hunter2", "hunter2"], ["basic [key removed]hunter2 more", "hunter2"],
    ['{"pwd":12345678}', "12345678"], ['{"token": true}', "true"], ['{"auth": {"user": "u", "pass": "hunter2"}}', "hunter2"], ['{"secret": [1, 2, "hunter2"]}', "hunter2"], ['{"api_key": null}', "null"]]) {
    assert.ok(!redactKeys(note).includes(secret), `${note} -> ${redactKeys(note)}`);
    assert.ok(!stderrSummary(`${note}\n`).includes(secret), `runner copy: ${note}`);
  }
  assert.equal(redactKeys("Bearer [key removed] next"), "Bearer [key removed] next");
});

test("round 9: dotenv and YAML credential lines, a URL's password and credential query parameters", () => {
  for (const [note, secret] of [["PASSWORD = hunter2", "hunter2"], ["password: hunter2", "hunter2"], ["  db.password:   hunter2 # prod", "hunter2"], ["API_TOKEN:hunter2", "hunter2"],
    ["\"PASSWORD\" = hunter2", "hunter2"], ["postgres://alice:hunter2@localhost/app", "hunter2"], ["redis://:hunter2@cache:6379", "hunter2"],
    ["GET https://x.test/a?token=hunter2&page=2", "hunter2"], ["https://x.test/a?page=2&password=hunter2 next", "hunter2"], ["password: [key removed]hunter2", "hunter2"]]) {
    assert.ok(!redactKeys(note).includes(secret), `${note} -> ${redactKeys(note)}`);
    assert.ok(!stderrSummary(`${note}\n`).includes(secret), `runner copy: ${note}`);
  }
  assert.equal(redactKeys("postgres://alice:hunter2@localhost/app"), "postgres://alice:[key removed]@localhost/app");
  assert.equal(redactKeys("GET https://x.test/a?token=hunter2&page=2 next"), "GET https://x.test/a?token=[key removed]&page=2 next");
  assert.equal(redactKeys("curl -H 'Authorization: Bearer abc' failed"), "curl -H 'Authorization: [key removed]' failed");
});
