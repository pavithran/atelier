// t620: a ship step's live output is cut of ship's secrets, as its saved log is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCommand } from "../cli/ship.mjs";
import { liveRedactor } from "../cli/ship-live.mjs";

const SECRET = "s3cr3t-value-0123456789";
const sink = () => { const s = { text: "", writes: [], write(x) { s.text += x; s.writes.push(x); } }; return s; };
const node = (code) => [process.execPath, "-e", code];

test("criterion 1: a secret a step prints shows the mark on live stdout and stderr, never the value", async () => {
  const out = sink(), err = sink();
  const r = await runCommand(node(`console.log("a ${SECRET} b"); console.error("c ${SECRET} d")`), { timeoutMs: 20_000, out, err, secrets: [SECRET] });
  assert.equal(out.text, "a [redacted] b\n");
  assert.equal(err.text, "c [redacted] d\n");
  assert.ok(!out.text.includes(SECRET) && !err.text.includes(SECRET));
  assert.ok(r.output.includes(SECRET), "criterion 4: the kept output is unchanged");
});

test("criterion 2: a secret written in two writes is still cut, and the hold-back is under the secret's length", async () => {
  const out = sink(), err = sink();
  const code = `process.stdout.write("x ${SECRET.slice(0, 9)}"); setTimeout(() => process.stdout.write("${SECRET.slice(9)} y\\n"), 300)`;
  await runCommand(node(code), { timeoutMs: 20_000, out, err, secrets: [SECRET] });
  assert.equal(out.text, "x [redacted] y\n");
  const unit = sink(), live = liveRedactor((s) => unit.write(s), [SECRET]);
  live.write("0123456789" + SECRET.slice(0, 5));
  assert.ok(("0123456789" + SECRET.slice(0, 5)).length - unit.text.length <= SECRET.length - 1);
  live.write(SECRET.slice(5)); live.end();
  assert.equal(unit.text, "0123456789[redacted]");
});

test("criterion 3: output with no secret arrives unchanged and in order, flushed at the end and at the time limit", async () => {
  const out = sink(), err = sink();
  await runCommand(node(`process.stdout.write("one\\n"); process.stdout.write("two"); process.stderr.write("err")`), { timeoutMs: 20_000, out, err, secrets: [SECRET] });
  assert.equal(out.text, "one\ntwo");
  assert.equal(err.text, "err");
  const late = sink(), lateErr = sink();
  const r = await runCommand(node(`process.stdout.write("tail ${SECRET.slice(0, 10)}"); setInterval(() => {}, 1000)`), { timeoutMs: 800, out: late, err: lateErr, secrets: [SECRET] });
  assert.equal(r.passed, false);
  assert.equal(late.text, `tail ${SECRET.slice(0, 10)}`, "held-back characters flush when the step is stopped");
  const none = sink();
  await runCommand(node(`console.log("plain")`), { timeoutMs: 20_000, out: none, err: none });
  assert.equal(none.text, "plain\n");
});

test("criterion 5: each step has its own buffer; a first step ending on a partial secret leaks nothing into the second", async () => {
  const first = sink(), second = sink();
  await runCommand(node(`process.stdout.write("end ${SECRET.slice(0, 12)}")`), { timeoutMs: 20_000, out: first, err: first, secrets: [SECRET] });
  assert.equal(first.text, `end ${SECRET.slice(0, 12)}`);
  await runCommand(node(`process.stdout.write("${SECRET.slice(12)} next")`), { timeoutMs: 20_000, out: second, err: second, secrets: [SECRET] });
  assert.equal(second.text, `${SECRET.slice(12)} next`);
  // a held-back tail is not written until more output or end() comes
  const dead = sink(), live = liveRedactor((s) => dead.write(s), [SECRET]);
  live.write("ok " + SECRET.slice(0, 8));
  assert.ok(!dead.text.includes(SECRET.slice(0, 8)), "the partial secret stays held, never printed raw");
});
