// The staging ship order (release split, PAVI 2026-10-26):
// docs/atelier/ship-staging.json, read with ship's own loader, and the
// wrangler env and version URL scripts/ship-worker.mjs takes from it.
// Main's order, docs/atelier/ship.json, keeps its own tests in
// test/ship.test.mjs and test/ship-worker.test.mjs; it deploys staging too,
// and production ships from release/1.0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { composeShip, ship } from "../cli/ship.mjs";
import { deployWorker, parseArgs, verifyWorker, VERSION_URL } from "../scripts/ship-worker.mjs";

const STAGING_FILE = "docs/atelier/ship-staging.json";
const STAGING_URL = "https://next.atelier.zone/api/version";
const script = resolve("scripts/ship-worker.mjs");

function repo(t) {
  const cwd = mkdtempSync(join(tmpdir(), "atelier-ship-staging-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test" } }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(cwd, "source.txt"), "source\n");
  git("add", "."); git("commit", "-qm", "fixture");
  return { cwd, head: git("rev-parse", "HEAD"), git };
}

test("the staging ship file composes with ship's loader: typecheck, deploy --env staging, verify at next.atelier.zone, and no scan, push, baseline or studio", () => {
  const p = composeShip(resolve("."), STAGING_FILE);
  assert.deepEqual(p.problems, []);
  assert.equal(p.source, STAGING_FILE);
  assert.equal(p.class, "web");
  const steps = p.steps.map((s) => s.step);
  assert.deepEqual(steps, ["commit", "typecheck", "deploy", "verify-delivery", "wrap"]);
  for (const step of ["scan", "push", "baseline", "studio"]) assert.ok(!steps.includes(step), step);
  const by = Object.fromEntries(p.steps.map((s) => [s.step, s]));
  assert.deepEqual(by.deploy.runs.map((r) => r.argv), [["node", "scripts/ship-worker.mjs", "deploy", "--env", "staging"]]);
  assert.equal(by.deploy.runs[0].kind, "deploy");
  assert.equal(by.deploy.runs[0].ifChanged.since, STAGING_URL);
  assert.deepEqual(by["verify-delivery"].runs.map((r) => r.argv), [["node", "scripts/ship-worker.mjs", "verify", "--version-url", STAGING_URL]]);
  // No run of the staging order reaches production.
  assert.doesNotMatch(JSON.stringify(p.steps), /https:\/\/atelier\.zone/);
});

// Main never deploys production: its ship file and npm run deploy both name
// the staging Worker.
test("ship reads docs/atelier/ship.json unless told otherwise, and main's order deploys and verifies staging, with the push the staging file lacks", () => {
  const main = composeShip(resolve("."));
  assert.equal(main.source, "docs/atelier/ship.json");
  assert.ok(main.steps.some((s) => s.step === "push"));
  const deploy = main.steps.find((s) => s.step === "deploy").runs[0];
  assert.deepEqual(deploy.argv, ["node", "scripts/ship-worker.mjs", "deploy", "--env", "staging"]);
  assert.equal(deploy.ifChanged.since, STAGING_URL);
  assert.deepEqual(main.steps.find((s) => s.step === "verify-delivery").runs[0].argv, ["node", "scripts/ship-worker.mjs", "verify", "--version-url", STAGING_URL]);
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  assert.match(pkg.scripts.deploy, /^wrangler deploy --env staging /);
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

test("ship-worker's arguments: deploy takes --env, verify takes --version-url, and neither is needed", () => {
  assert.deepEqual(parseArgs(["deploy"]), { action: "deploy", environment: "" });
  assert.deepEqual(parseArgs(["verify"]), { action: "verify", versionUrl: undefined });
  assert.deepEqual(parseArgs(["deploy", "--env", "staging"]), { action: "deploy", environment: "staging" });
  assert.deepEqual(parseArgs(["verify", "--version-url", STAGING_URL]), { action: "verify", versionUrl: STAGING_URL });
  for (const argv of [[], ["ship"], ["deploy", "--env"], ["deploy", "staging"], ["deploy", "--env", "Staging"], ["deploy", "--env", "--keep-vars"], ["deploy", "--version-url", STAGING_URL],
    ["verify", "--env", "staging"], ["verify", "--version-url"], ["verify", "--version-url", "http://next.atelier.zone/api/version"], ["verify", "--version-url", "not a url"], ["deploy", "--env", "staging", "extra"]]) {
    assert.throws(() => parseArgs(argv), /Usage/, argv.join(" "));
  }
});

test("deployWorker passes --env to wrangler when given, and an empty --env for production otherwise", (t) => {
  const f = repo(t);
  const env = { ATELIER_SHIP_HEAD: f.head };
  const seen = [];
  const run = (command, args) => { seen.push(args); return { status: 0 }; };
  assert.equal(deployWorker({ cwd: f.cwd, env, run, environment: "staging" }), f.head);
  assert.equal(deployWorker({ cwd: f.cwd, env, run }), f.head);
  assert.deepEqual(seen, [
    ["wrangler", "deploy", "--env", "staging", "--keep-vars", "--var", `DEPLOYED_MAIN:${f.head}`],
    ["wrangler", "deploy", "--env", "", "--keep-vars", "--var", `DEPLOYED_MAIN:${f.head}`],
  ]);
});

test("a production deploy passes an empty --env even with CLOUDFLARE_ENV=staging in the environment", (t) => {
  const f = repo(t);
  const seen = [];
  const run = (command, args, options) => { seen.push([args, options.env.CLOUDFLARE_ENV]); return { status: 0 }; };
  assert.equal(deployWorker({ cwd: f.cwd, env: { ATELIER_SHIP_HEAD: f.head, CLOUDFLARE_ENV: "staging" }, run }), f.head);
  assert.deepEqual(seen, [[["wrangler", "deploy", "--env", "", "--keep-vars", "--var", `DEPLOYED_MAIN:${f.head}`], "staging"]]);
});

test("verifyWorker reads the version URL it is given, and production's otherwise", async (t) => {
  const f = repo(t);
  const env = { ATELIER_SHIP_HEAD: f.head };
  const urls = [];
  const fetchImpl = async (url) => { urls.push(url); return Response.json({ commit: f.head }); };
  assert.equal(await verifyWorker({ cwd: f.cwd, env, fetchImpl, versionUrl: STAGING_URL }), f.head);
  assert.equal(await verifyWorker({ cwd: f.cwd, env, fetchImpl }), f.head);
  assert.deepEqual(urls, [STAGING_URL, VERSION_URL]);
  assert.equal(VERSION_URL, "https://atelier.zone/api/version");
});

test("the script run as the staging file names it deploys with --env staging and verifies at next.atelier.zone", (t) => {
  const f = repo(t);
  const bin = mkdtempSync(join(tmpdir(), "atelier-ship-staging-bin-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const argsFile = join(bin, "args.txt");
  writeFileSync(join(bin, "npx"), `#!/bin/sh\nprintf '%s\\n' "$@" > "$DEPLOY_ARGS"\n`);
  chmodSync(join(bin, "npx"), 0o755);
  const preload = join(bin, "version.mjs");
  writeFileSync(preload, `globalThis.fetch = async (url) => String(url) === ${JSON.stringify(STAGING_URL)} ? Response.json({ commit: process.env.ATELIER_SHIP_HEAD }) : new Response("wrong URL " + url, { status: 404 });`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DEPLOY_ARGS: argsFile, ATELIER_SHIP_HEAD: f.head };
  const deploy = spawnSync(process.execPath, [script, "deploy", "--env", "staging"], { cwd: f.cwd, env, encoding: "utf8" });
  assert.equal(deploy.status, 0, deploy.stderr);
  assert.deepEqual(execFileSync("cat", [argsFile], { encoding: "utf8" }).trim().split("\n"), ["wrangler", "deploy", "--env", "staging", "--keep-vars", "--var", `DEPLOYED_MAIN:${f.head}`]);
  const verify = spawnSync(process.execPath, ["--import", preload, script, "verify", "--version-url", STAGING_URL], { cwd: f.cwd, env, encoding: "utf8" });
  assert.equal(verify.status, 0, verify.stderr);
  // Without the URL it reads production's, which the stand-in does not answer.
  const production = spawnSync(process.execPath, ["--import", preload, script, "verify"], { cwd: f.cwd, env, encoding: "utf8" });
  assert.notEqual(production.status, 0);
  assert.match(production.stderr, /HTTP 404/);
  const bad = spawnSync(process.execPath, [script, "deploy", "--env"], { cwd: f.cwd, env, encoding: "utf8" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Usage/);
});
