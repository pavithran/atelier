// The staging ship order: docs/atelier/ship-staging.json, read with ship's
// own loader, and main's docs/atelier/ship.json, which deploys staging too,
// both through scripts/ship-studio.mjs to the Studio (Atelier 2.0, task 9).
// The script itself is tested in test/ship-studio.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { composeShip, ship } from "../cli/ship.mjs";

const STAGING_FILE = "docs/atelier/ship-staging.json";
const STAGING_URL = "https://next.atelier.zone/api/version";
const DEPLOY = ["node", "scripts/ship-studio.mjs", "deploy", "--env", "staging", "--host", "ai-studio"];
const VERIFY = ["node", "scripts/ship-studio.mjs", "verify", "--version-url", STAGING_URL];

test("the staging ship file composes with ship's loader: typecheck, the Studio deploy of staging with the terminal, verify at next.atelier.zone, and no scan or push", () => {
  const p = composeShip(resolve("."), STAGING_FILE);
  assert.deepEqual(p.problems, []);
  assert.equal(p.source, STAGING_FILE);
  assert.equal(p.class, "web");
  const steps = p.steps.map((s) => s.step);
  assert.deepEqual(steps, ["commit", "typecheck", "deploy", "verify-delivery", "wrap"]);
  for (const step of ["scan", "push", "baseline", "studio"]) assert.ok(!steps.includes(step), step);
  const by = Object.fromEntries(p.steps.map((s) => [s.step, s]));
  assert.deepEqual(by.deploy.runs.map((r) => r.argv), [DEPLOY]);
  assert.equal(by.deploy.runs[0].kind, "deploy");
  assert.equal(by.deploy.runs[0].terminal, true, "sudo asks for the password on the terminal");
  assert.equal(by.deploy.runs[0].retries, undefined, "a deploy under sudo is not retried");
  assert.equal(by.deploy.runs[0].ifChanged.since, STAGING_URL);
  assert.deepEqual(by["verify-delivery"].runs.map((r) => r.argv), [VERIFY]);
  // No run of the staging order reaches production.
  assert.doesNotMatch(JSON.stringify(p.steps), /https:\/\/atelier\.zone/);
});

// Main never deploys production: its ship file names staging on the Studio.
test("ship reads docs/atelier/ship.json unless told otherwise, and main's order deploys and verifies staging, with the push the staging file lacks and no baseline or studio step", () => {
  const main = composeShip(resolve("."));
  assert.equal(main.source, "docs/atelier/ship.json");
  assert.deepEqual(main.problems, []);
  assert.ok(main.steps.some((s) => s.step === "push"));
  for (const step of ["baseline", "studio"]) assert.ok(!main.steps.some((s) => s.step === step), step);
  const deploy = main.steps.find((s) => s.step === "deploy").runs[0];
  assert.deepEqual(deploy.argv, DEPLOY);
  assert.equal(deploy.terminal, true);
  assert.equal(deploy.ifChanged.since, STAGING_URL);
  for (const path of ["src/**", "hooks/**", "cli/serve.mjs", "package-lock.json", "scripts/studio/install-server.sh"]) assert.ok(deploy.ifChanged.paths.includes(path), path);
  assert.deepEqual(main.steps.find((s) => s.step === "verify-delivery").runs[0].argv, VERIFY);
  // No run of main's order reaches production.
  assert.doesNotMatch(JSON.stringify(main.steps), /https:\/\/atelier\.zone/);
});

test('"push": false leaves the push step out, and refuses the steps that run with it', (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-ship-nopush-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "docs/atelier"), { recursive: true });
  const write = (doc) => writeFileSync(join(dir, "docs/atelier/ship.json"), JSON.stringify({ schema_version: 1, kind: "atelier.ship", class: "other", ...doc }));
  write({ push: false });
  const p = composeShip(dir);
  assert.deepEqual(p.problems, []);
  assert.deepEqual(p.steps.map((s) => s.step), ["commit", "wrap"]);
  for (const step of ["scan", "baseline", "studio"]) {
    write({ push: false, [step]: { run: ["true"] } });
    assert.deepEqual(composeShip(dir).problems, [`docs/atelier/ship.json gives ${step}, which runs with the push, and "push" is false`]);
  }
  write({ push: true });
  assert.match(composeShip(dir).problems.join("\n"), /"push" must be .*false for no push step/);
});

test("ship --push refuses an order with no push step", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-ship-nopush-run-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "docs/atelier"), { recursive: true });
  writeFileSync(join(dir, "docs/atelier/ship.json"), JSON.stringify({ schema_version: 1, kind: "atelier.ship", class: "other", push: false }));
  const head = "a".repeat(40);
  const run = async (push) => {
    const lines = [];
    const git = (args) => args[0] === "branch" ? "main" : args[0] === "rev-parse" ? head : "";
    await ship({ name: "p", cwd: dir, branch: "main", git, request: async () => ({ approvals: [] }), print: (l) => lines.push(l), fail: (m) => { throw new Error(m); },
      inProgress: () => [], baselineHead: head, paired: () => head, dryRun: true, push });
    return lines.join("\n");
  };
  assert.match(await run(true), /Refused: --push was given and docs\/atelier\/ship\.json has no push step/);
  assert.doesNotMatch(await run(false), /Refused/);
});

test('"terminal" is true on a run, or refused', (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-ship-terminal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "docs/atelier"), { recursive: true });
  const write = (deploy) => writeFileSync(join(dir, "docs/atelier/ship.json"), JSON.stringify({ schema_version: 1, kind: "atelier.ship", class: "web", deploy, "verify-deploy": { run: ["true"] } }));
  write({ run: ["./deploy"], terminal: true });
  const p = composeShip(dir);
  assert.deepEqual(p.problems, []);
  assert.equal(p.steps.find((s) => s.step === "deploy").runs[0].terminal, true);
  for (const bad of [{ run: ["./deploy"], terminal: "yes" }, { run: ["./deploy"], terminal: false }, { request: "https://example.test", terminal: true }]) {
    write(bad);
    assert.match(composeShip(dir).problems.join("\n"), /"terminal" must be true, on a "run"/, JSON.stringify(bad));
  }
});
