// t293: the deploy gate's warning. miqra's deploy ran npm run verify:visual
// while the required checks were npm test and the build alone, so eight tasks
// landed that all failed the deploy gate and the deploy waited. These tests
// hold the rule that names a command the gate runs when no required check
// runs it, and the lines `atelier status` and `atelier init` print.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deployGateLines, packageScripts, uncheckedDeployCommands } from "../cli/deploy-gate.mjs";
import { formatStatus } from "../cli/status.mjs";

const cli = resolve("cli/atelier.mjs");

// The warning's own words, as both commands print them.
const gateLine = (command, checks, project) =>
  `Deploy gate: ${command} runs after a merge or at ship and no required check runs it, so a task can land without it passing; add it with atelier init --check ${checks.map((c) => JSON.stringify(c)).join(" --check ")}${project ? ` --project ${project}` : ""}.`;

// miqra as the brief holds it: the post-merge deploy step runs the script
// package.json names deploy, which runs a visual check nothing else runs.
const MIQRA_SCRIPTS = {
  deploy: "npm run verify:visual && wrangler deploy",
  "verify:visual": "node scripts/verify-visual.mjs",
  test: "node --test",
  build: "vite build",
};
const step = (name, command, extra = {}) => ({ name, command, when: "always", protect: ["package.json"], timeoutMs: 1200000, ...extra });
const policy = (checks, over = {}) => ({ checks, protected: [], ...over });
const postMerge = (steps) => ({ version: 1, steps, approval: { by: "owner", at: "2026-10-25T10:00:00.000Z", reason: "recorded" } });

test("a command the deploy gate runs that no required check runs is named, with the init that adds it", () => {
  const miqra = policy(["npm test", "npm run build"], { postMerge: postMerge([step("deploy", "npm run deploy", { class: "deploy" })]) });
  assert.deepEqual(uncheckedDeployCommands(miqra, MIQRA_SCRIPTS), ["npm run verify:visual"]);
  assert.deepEqual(deployGateLines(miqra, MIQRA_SCRIPTS, "miqra"), [gateLine("npm run verify:visual", ["npm test", "npm run build", "npm run verify:visual"], "miqra")]);
  // With no checks at all the warning still names the command, and the init it
  // suggests is the one check.
  assert.deepEqual(deployGateLines(policy([], { postMerge: postMerge([step("deploy", "npm run deploy", { class: "deploy" })]) }), MIQRA_SCRIPTS, "miqra"), [gateLine("npm run verify:visual", ["npm run verify:visual"], "miqra")]);
});

test("a required check covers every form a script runs it in", () => {
  const deploy = postMerge([step("deploy", "npm run deploy", { class: "deploy" })]);
  // The check runs the command itself.
  assert.deepEqual(uncheckedDeployCommands(policy(["npm test", "npm run verify:visual"], { postMerge: deploy }), MIQRA_SCRIPTS), []);
  // Or runs it inside a script of its own: the test script runs the visual check.
  assert.deepEqual(uncheckedDeployCommands(policy(["npm test"], { postMerge: deploy }), { ...MIQRA_SCRIPTS, test: "node --test && npm run verify:visual" }), []);
  // npm test and npm run test are the one script.
  assert.deepEqual(uncheckedDeployCommands(policy(["npm test"], { postMerge: postMerge([step("e2e", "npm run test", { class: "check" })]) }), { test: "node --test" }), []);
});

test("the ship order's runs and the script named deploy are gates too", () => {
  const scripts = { typecheck: "tsc -p .", test: "node --test" };
  // A run of the ship order.
  assert.deepEqual(uncheckedDeployCommands(policy(["npm test"], { shipRuns: ["npm run typecheck", "node scripts/ship.mjs"] }), scripts), ["npm run typecheck"]);
  // The script package.json names deploy, with no post-merge policy and no ship order.
  assert.deepEqual(uncheckedDeployCommands(policy(["npm test"]), MIQRA_SCRIPTS), ["npm run verify:visual"]);
});

test("a script the gate runs in turn is a gate command, and one a check runs in turn is covered", () => {
  // The deploy script runs the build script, which no check runs.
  assert.deepEqual(uncheckedDeployCommands(policy(["npm test"]), { deploy: "npm run build && wrangler deploy", build: "vite build", test: "node --test" }), ["npm run build"]);
  // A check's script runs the same script: covered.
  assert.deepEqual(uncheckedDeployCommands(policy(["npm test"]), { deploy: "npm run build && wrangler deploy", build: "vite build", test: "node --test && npm run build" }), []);
});

test("commands that can never be a check are not named", () => {
  const steps = postMerge([
    step("deploy", "npm run deploy", { class: "deploy" }),
    step("e2e", "npm run e2e", { class: "check" }),
  ]);
  // npm run deploy itself deploys, and wrangler deploy inside the script is
  // not a script invocation; neither can be added as a check.
  assert.deepEqual(uncheckedDeployCommands(policy(["npm test"], { postMerge: steps }), { deploy: "wrangler deploy", e2e: "playwright test", test: "node --test" }), ["npm run e2e"]);
});

test("without the checkout's package.json, the policy's own commands still name a gap", () => {
  // A post-merge check step is a command the policy holds.
  assert.deepEqual(uncheckedDeployCommands(policy(["npm test"], { postMerge: postMerge([step("e2e", "npm run e2e", { class: "check" })]) }), null), ["npm run e2e"]);
  // A deploy step alone says nothing: the script it runs cannot be read here.
  assert.deepEqual(uncheckedDeployCommands(policy(["npm test"], { postMerge: postMerge([step("deploy", "npm run deploy", { class: "deploy" })]) }), null), []);
});

test("packageScripts reads the scripts package.json holds, and says null without them", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-deploy-gate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(packageScripts(dir), null, "no package.json");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { deploy: "npm run build", broken: 7 } }));
  assert.deepEqual(packageScripts(dir), { deploy: "npm run build" }, "a script that is not text is left out");
  writeFileSync(join(dir, "package.json"), "{ not json");
  assert.equal(packageScripts(dir), null);
  writeFileSync(join(dir, "package.json"), JSON.stringify({}));
  assert.equal(packageScripts(dir), null, "no scripts field");
});

test("formatStatus prints the warning under the project's name, and nothing when every gate command is covered", () => {
  const view = (p, scripts) => ({ name: "miqra", title: "Miqra", items: [], inbox: [], policy: p, scripts });
  const out = formatStatus([view(policy(["npm test"], { postMerge: postMerge([step("deploy", "npm run deploy", { class: "deploy" })]) }), MIQRA_SCRIPTS)]).split("\n");
  assert.equal(out[0], "Miqra (miqra)");
  const at = out.indexOf(`  ${gateLine("npm run verify:visual", ["npm test", "npm run verify:visual"], "miqra")}`);
  assert.ok(at > 0, out.join("\n"));
  assert.ok(at < out.indexOf("  Nothing waiting."), "the warning stands under the project's name");
  // A project whose checks cover its gate, and one with no policy read, say nothing.
  assert.ok(!formatStatus([view(policy(["npm run verify:visual"], { postMerge: postMerge([step("deploy", "npm run deploy", { class: "deploy" })]) }), MIQRA_SCRIPTS)]).includes("Deploy gate"));
  assert.ok(!formatStatus([view(null, null)]).includes("Deploy gate"));
});

// `atelier status` itself, against a stand-in server and a checkout on disk:
// the policy from the server, the scripts from the checkout.
async function runStatus(t, serverPolicy, scripts) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-gate-status-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const checkout = join(dir, "checkout"), cache = join(dir, "cache");
  mkdirSync(checkout);
  mkdirSync(cache);
  if (scripts) writeFileSync(join(checkout, "package.json"), JSON.stringify({ scripts }));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ server: "x", owner: "owner", projects: { demo: { path: checkout, branch: "main" } } }));
  const server = createServer((req, res) => {
    let status = 200, body;
    if (req.url === "/api/projects") body = [{ name: "demo", title: "Demo", repo: "demo", policy: serverPolicy }];
    else if (req.url === "/api/inbox") body = [];
    else if (req.url === "/api/projects/demo") body = { project: { name: "demo", title: "Demo", repo: "demo", policy: serverPolicy }, items: [], events: [] };
    else { status = 404; body = { error: "not_found", detail: "no such route" }; }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const child = spawn(process.execPath, [cli, "status"], {
    cwd: dir,
    env: { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_CACHE: cache, ATELIER_TOKEN: "test-token", ATELIER_ACTOR: "owner", ATELIER_SERVER: `http://127.0.0.1:${server.address().port}` },
  });
  let output = "";
  child.stdout.on("data", (s) => output += s);
  child.stderr.on("data", (s) => output += s);
  const code = await new Promise((done) => child.on("close", done));
  return { code, output };
}

test("atelier status names the deploy command under the project, from the policy and the checkout", async (t) => {
  const p = policy(["npm test"], { postMerge: postMerge([step("deploy", "npm run deploy", { class: "deploy" })]) });
  const r = await runStatus(t, p, MIQRA_SCRIPTS);
  assert.equal(r.code, 0, r.output);
  assert.ok(r.output.includes(`  ${gateLine("npm run verify:visual", ["npm test", "npm run verify:visual"], "demo")}`), r.output);
  assert.ok(r.output.includes("Demo (demo)"), r.output);
});

test("atelier status says nothing when the required checks cover the gate", async (t) => {
  const p = policy(["npm test", "npm run verify:visual"], { postMerge: postMerge([step("deploy", "npm run deploy", { class: "deploy" })]) });
  const r = await runStatus(t, p, MIQRA_SCRIPTS);
  assert.equal(r.code, 0, r.output);
  assert.ok(!r.output.includes("Deploy gate"), r.output);
});
