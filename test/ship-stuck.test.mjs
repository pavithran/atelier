import { test } from "node:test";
import assert from "node:assert/strict";
import { stuckReport, reportLimits } from "../src/stuck/report.ts";
import { openStuck } from "../src/stuck/view.ts";
import shipSpec from "../src/usage/commands/ship.ts";
import { SERVER_CAPABILITIES } from "../src/route-level.ts";
import { actionsApi } from "../src/actions-api.ts";
import { stuckLines } from "../cli/status.mjs";

const start = { seq: 1, itemId: null, actor: "owner", at: "2026-11-02T22:41:00.000Z", kind: "action.started", data: { ship: "s-1", step: "deploy", command: "npm run release" } };
const report = (events, minutes) => stuckReport("demo", "http://localhost", new Date(Date.parse(start.at) + minutes * 60000), reportLimits(), { items: [], events, lease: null, reviews: [] }, [], [], []);
test("stuck and status name a ship command only after 60 minutes, including a crash before completion", () => {
  assert.deepEqual(report([start], 60).entries, []);
  const r = report([start], 61);
  assert.equal(r.entries.length, 1);
  assert.match(r.entries[0].reason, /deploy.*npm run release/);
  assert.equal(r.entries[0].since, start.at);
  const text = stuckLines(openStuck("demo", r, [], [])).join("\n");
  assert.match(text, /npm run release/);
  assert.match(text, /2026-11-02T22:41/);
  for (const kind of ["action.ran", "ship.recorded"]) {
    assert.deepEqual(report([start, { ...start, seq: 2, kind }], 61).entries, []);
  }
});

test("completion of another command or ship does not hide an overdue start", () => {
  for (const data of [{ ...start.data, ship: "s-2" }, { ...start.data, command: "other" }]) {
    assert.equal(report([start, { ...start, seq: 2, kind: "action.ran", data }], 61).entries.length, 1);
  }
});

test("a later command in the same ship replaces the previous start", () => {
  const next = { ...start, seq: 2, at: "2026-11-02T23:40:00.000Z", data: { ...start.data, command: "next command" } };
  assert.deepEqual(report([start, next], 61).entries, []);
  const r = report([start, next], 120);
  assert.equal(r.entries.length, 1);
  assert.match(r.entries[0].reason, /next command/);
});

test("start route checks the authenticated owner before writing", async () => {
  const writes = [];
  const ledger = { startActionRun: async (body, actor) => writes.push({ body, actor }) };
  for (const actor of ["agent/model", "stranger"]) {
    await assert.rejects(actionsApi(ledger, "POST", ["starts"], { level: "owner" }, actor, "owner", async () => true), e => e.code === "not_project_owner");
  }
  assert.deepEqual(writes, []);
  const body = { ship: "s-1", step: "deploy", command: "release", commit: "a".repeat(40) };
  assert.equal((await actionsApi(ledger, "POST", ["starts"], body, "owner", "owner", async () => true)).status, 201);
  assert.deepEqual(writes, [{ body, actor: "owner" }]);
});

test("ship requires the published step-start capability before running", () => {
  assert.ok(SERVER_CAPABILITIES.includes("ship.step-start.v1"));
  assert.ok(shipSpec.capabilities.includes("ship.step-start.v1"));
});
