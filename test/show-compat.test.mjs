import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const cli = resolve("cli/atelier.mjs");
const brief = {
  title: "Ship the feature", decided: "Approve plan t1's split of: Ship the feature",
  summary: null, evidence: ["Phase: proposed."],
  recommendation: { verdict: "decide", reason: "Read the split with atelier plan show t1." },
};

// Exercise the CLI against the older server contract without opening sockets.
function fixture(t, status = 404, error = "not_found", detail = "no such route") {
  const root = mkdtempSync(join(process.cwd(), ".show-compat-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const preload = join(root, "server.mjs");
  writeFileSync(preload, `
    globalThis.fetch = async (url, options) => {
      if (options.method !== "GET") throw new Error("show must be read-only");
      const path = new URL(url).pathname;
      if (path === "/api/projects/proj/items/t1/brief") return Response.json(${JSON.stringify(brief)});
      if (path === "/api/projects/proj/items/t1") return Response.json(${JSON.stringify({ error, detail })}, { status: ${status} });
      throw new Error("unexpected route: " + path);
    };
  `);
  return (flags = []) => spawnSync(process.execPath, ["--import", preload, cli, "show", "t1", "--project", "proj", "--as", "owner", ...flags], {
    cwd: root, encoding: "utf8",
    env: { ...process.env, ATELIER_ACTOR: "owner", ATELIER_CONFIG_DIR: root, ATELIER_CACHE: root, ATELIER_TOKEN: "fake", ATELIER_SERVER: "https://fake.invalid" },
  });
}

test("show preserves the plan brief, JSON and review output without a detail route", (t) => {
  const run = fixture(t);
  for (const flags of [[], ["--json"], ["--reviews"]]) {
    const r = run(flags);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    if (flags.includes("--json")) assert.deepEqual(JSON.parse(r.stdout), { ...brief, reviews: [], unparsable: [] });
    else {
      assert.ok(r.stdout.startsWith(`proj/t1  ${brief.title}\n${brief.decided}\nPhase: proposed.\nRecommendation: decide. ${brief.recommendation.reason}\n`), r.stdout);
      if (flags.includes("--reviews")) assert.match(r.stdout, /No reviews are recorded/);
    }
  }
});

for (const [status, error, detail, exitCode] of [
  [403, "forbidden", "not allowed", 1],
  [404, "not_found", "no such item", 1],
  [503, "unavailable", "try later", 4],
  [503, "not_found", "no such route", 4],
]) test(`show does not hide detail failure ${status}: ${detail}`, (t) => {
  const run = fixture(t, status, error, detail);
  for (const flags of [[], ["--json"], ["--reviews"]]) {
    const r = run(flags);
    assert.equal(r.status, exitCode);
    assert.ok(r.stderr.includes(`${error}: ${detail}`), r.stderr);
    assert.equal(r.stdout, "");
  }
});
