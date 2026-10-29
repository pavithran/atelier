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
];
const ROUND_ONE = [
  ["Authorization: Custom abc123", "abc123"],
  ['Authorization: Digest username="u", realm="r", response="6629fae49393a05397450978507c4ef1"', "6629fae49393a05397450978507c4ef1"],
  ["curl -H 'Authorization: basic dTpw'", "dTpw"],
  ['{"authorization": "tok123abc", "ok": 1}', "tok123abc"],
];
const PATHS = ["could not read /srv/keys=prod/app.log", "KEY_FILE=/etc/atelier/k.pem missing", "cp ~/build/TOKEN=x/out.txt .", "/tmp/a=b/file", "--out=/x/y=z"];

test("assignments, bearer and basic credentials in any case (a basic one of four or more characters), and credential headers are removed", () => {
  for (const [note, secret] of [...LEAKS, ...ROUND_ONE]) {
    const out = redactKeys(note);
    assert.ok(!out.includes(secret), `${note} -> ${out}`);
    assert.match(out, /\[key removed\]/);
  }
  assert.equal(redactKeys("API_TOKEN=abc123def456 rejected"), "API_TOKEN=[key removed] rejected");
  assert.equal(redactKeys("curl -H 'Authorization: Bearer abc.def-ghi9' failed"), "curl -H 'Authorization: [key removed]' failed");
  assert.equal(redactKeys("got bearer abcdefgh123 back"), "got bearer [key removed] back");
  assert.equal(redactKeys("basic dTpw"), "basic [key removed]");
});

test("paths with = in them are kept, and so are the words a harness writes around a credential", () => {
  for (const path of PATHS) assert.equal(redactKeys(path), path);
  assert.equal(redactKeys("basic auth failed for user"), "basic auth failed for user");
});

test("the runner's copy: stderrSummary removes them before a note leaves the runner, and keeps paths", () => {
  for (const [note, secret] of [...LEAKS, ...ROUND_ONE]) {
    const summary = stderrSummary(`starting\n${note}\n`);
    assert.ok(!summary.includes(secret), summary);
  }
  assert.equal(stderrSummary(`${PATHS[0]}\n`), PATHS[0]);
});
