import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COMMAND_USAGE, commandUsage, helpText } from "../cli/help.mjs";
import { assertLength, CLAIM_MAX } from "../src/text.ts";

test("report help describes the server's claim limit and counting unit", () => {
  const description = commandUsage("report").split("\n").slice(1).join("\n");
  assert.ok(description.includes(`up to ${CLAIM_MAX} characters (UTF-16 code units)`), description);
});

test("the generated help fixtures match the shared report declaration", () => {
  const usage = JSON.parse(readFileSync(new URL("./fixtures/cli/usage.json", import.meta.url), "utf8"));
  assert.equal(usage.report, COMMAND_USAGE.report + "\n");
  assert.equal(readFileSync(new URL("./fixtures/cli/help.txt", import.meta.url), "utf8"), helpText() + "\n");
});

test("report's help and refusal usage line name the server's claim limit", async () => {
  const usage = COMMAND_USAGE.report;
  assert.ok(usage.split("\n")[0].includes(`${CLAIM_MAX} characters`), usage);
  assert.ok(helpText().includes(`${CLAIM_MAX} characters`));
  // Load the handler with local dependencies, without running a CLI command
  // or reading machine configuration. Missing text is refused before I/O.
  const source = readFileSync(new URL("../cli/commands/report.mjs", import.meta.url), "utf8")
    .replace(/^import .*;$/gm, "");
  const setup = `const COMMAND_USAGE = ${JSON.stringify({ report: usage })};
    const args = { _: ["report"] };
    const die = (message) => { throw new Error(message); };`;
  const { default: report } = await import(`data:text/javascript,${encodeURIComponent(setup + source)}`);
  await assert.rejects(report(), { message: usage });
});

test("the server's report length guard refuses excess text with actual length and limit", () => {
  assert.doesNotThrow(() => assertLength("x".repeat(CLAIM_MAX), CLAIM_MAX, "the report"));
  const claim = "x".repeat(CLAIM_MAX + 1);
  assert.throws(() => assertLength(claim, CLAIM_MAX, "the report"), (error) => {
    assert.equal(error.code, "too_long");
    assert.equal(error.status, 400);
    assert.equal(error.message, `400|too_long|the report is ${claim.length} characters; the limit is ${CLAIM_MAX}. Shorten it and send it again`);
    return true;
  });
});
