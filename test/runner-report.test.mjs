import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./cli-sessions-shared.mjs";
import { formatRunners } from "../cli/status.mjs";
import { stuckReport, reportLimits } from "../src/stuck/report.ts";
import { OFFER_LIVE_MS } from "../src/dispatch/rules.ts";

const now = Date.now();
const offer = (runner, age) => ({ runner, kind: "home", agents: [{ agent: "codex", models: ["gpt-6"] }], at: new Date(now - age).toISOString(),
  readiness: { harnesses: [{ harness: "codex", state: "ready", probedAt: new Date(now).toISOString() }], tokens: [{ kind: "reviewer", name: "test-token", state: "unknown", expiresAt: null, daysLeft: null, recovery: null }] } });
const offers = [offer("home:live-a", 0), offer("home:live-b", 0), offer("home:one-shot", OFFER_LIVE_MS + 60000), offer("home:old", 2 * 86400000)];
const section = text => text.split("\n").filter(l => /^(Runners:|No live runners\.| {2,4}(home:|\d+ runner))/.test(l)).join("\n");

test("unwrap and project status collapse not-live runners and offer a full listing", t => {
  const f = fixture(t);
  const report = stuckReport("demo", "https://fake.invalid", new Date(now), reportLimits(), { items: [], events: [], lease: null, reviews: [] }, offers, [], []);
  assert.deepEqual(report.entries, []);
  const env = { ATELIER_RETRY_MS: "0", FAKE_RUNNERS: JSON.stringify(offers), FAKE_STUCK: JSON.stringify({ report, episodes: [] }) };
  const unwrap = f.runWith(env, "unwrap", "--project", "demo");
  assert.equal(unwrap.status, 0, unwrap.stderr);
  for (const name of ["live-a", "live-b"]) {
    assert.match(unwrap.stdout, new RegExp(`  home:${name}  live, asked .*offers codex/gpt-6`));
    assert.match(unwrap.stdout, new RegExp(`    home:${name}  codex  ready`));
    assert.ok(unwrap.stdout.includes(`    home:${name}  reviewer token test-token`));
  }
  assert.doesNotMatch(unwrap.stdout, /home:(one-shot|old)/);
  assert.match(unwrap.stdout, /2 runners not live; atelier status --all-runners/);
  const status = f.runWith(env, "status", "--project", "demo");
  assert.equal(status.status, 0, status.stderr);
  assert.equal(section(status.stdout).replace(/\d+s ago/g, "Xs ago"), section(unwrap.stdout).replace(/\d+s ago/g, "Xs ago"));
  for (const args of [["unwrap", "--project", "demo"], ["status", "--project", "demo"], ["status"]]) {
    const full = f.runWith(env, ...args, "--all-runners");
    assert.equal(full.status, 0, full.stderr);
    for (const o of offers) {
      assert.ok(full.stdout.includes(`  ${o.runner}  `), full.stdout);
      assert.ok(full.stdout.includes(`    ${o.runner}  codex  ready`), full.stdout);
      assert.ok(full.stdout.includes(`    ${o.runner}  reviewer token test-token`), full.stdout);
    }
    assert.doesNotMatch(full.stdout, /runners not live;/);
  }
  const empty = f.runWith({ ...env, FAKE_RUNNERS: "[]" }, "unwrap");
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /No live runners\./);
});

test("no live runners is explicit, including an empty registry", () => {
  for (const list of [[], offers.slice(2)]) {
    const text = formatRunners(list, now).join("\n");
    assert.match(text, /^No live runners\./);
    assert.doesNotMatch(text, /Runners:|home:/);
  }
});

test("list is an alias for ls", t => {
  const f = fixture(t);
  const ls = f.run("ls", "--all", "--json");
  const list = f.run("list", "--all", "--json");
  assert.equal(ls.status, 0, ls.stderr);
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stdout, ls.stdout);
});
