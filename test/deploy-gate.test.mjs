// t293: the deploy gate's warning. miqra's deploy ran npm run verify:visual
// while the required checks were npm test and the build alone, so eight tasks
// landed that all failed the deploy gate and the deploy waited. These tests
// hold the rule that names a command the gate runs when no required check
// runs it, and the lines `atelier status` and `atelier init` print: the init
// each suggests runs in the project's own checkout, which status names, for
// init reads the project from the checkout it runs in and from no flag.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SERVER_CAPABILITIES } from "../src/route-level.ts";
import { deployGateLines, packageScripts, uncheckedDeployCommands } from "../cli/deploy-gate.mjs";
import { formatStatus } from "../cli/status.mjs";

const cli = resolve("cli/atelier.mjs");

// The warning's own words, as both commands print them. `checks` is the
// whole set the suggested init records; `checkout` is what the caller knows
// of the project's checkout: a path (status, which runs from anywhere, names
// it to cd into first), null (this Mac holds no checkout of the project), or
// nothing (init, which runs in the checkout).
const initText = (checks) => `atelier init --check ${checks.map((c) => JSON.stringify(c)).join(" --check ")}`;
const gateLine = (command, checks, checkout) =>
  `Deploy gate: ${command} runs after a merge or at ship and no required check runs it, so a task can land without it passing; add it with ${checkout === undefined ? initText(checks) : checkout === null ? `${initText(checks)} in the project's checkout, which is not registered on this Mac` : `cd ${JSON.stringify(checkout)} && ${initText(checks)}`}.`;

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

test("a command the deploy gate runs that no required check runs is named, with the init that adds it in the project's checkout", () => {
  const miqra = policy(["npm test", "npm run build"], { postMerge: postMerge([step("deploy", "npm run deploy", { class: "deploy" })]) });
  assert.deepEqual(uncheckedDeployCommands(miqra, MIQRA_SCRIPTS), ["npm run verify:visual"]);
  // status, run from anywhere, names the checkout the local config holds,
  // because init takes the project from the checkout it runs in.
  assert.deepEqual(deployGateLines(miqra, MIQRA_SCRIPTS, "/checkouts/miqra"), [gateLine("npm run verify:visual", ["npm test", "npm run build", "npm run verify:visual"], "/checkouts/miqra")]);
  // With no checks at all the warning still names the command, and the init it
  // suggests is the one check.
  assert.deepEqual(deployGateLines(policy([], { postMerge: postMerge([step("deploy", "npm run deploy", { class: "deploy" })]) }), MIQRA_SCRIPTS, "/checkouts/miqra"), [gateLine("npm run verify:visual", ["npm run verify:visual"], "/checkouts/miqra")]);
  // A project this Mac holds no checkout for says so: the init cannot be run
  // from here, and the line does not suggest a folder it would misrecord.
  assert.deepEqual(deployGateLines(miqra, MIQRA_SCRIPTS, null), [gateLine("npm run verify:visual", ["npm test", "npm run build", "npm run verify:visual"], null)]);
  // init itself runs in the checkout and names no place.
  assert.deepEqual(deployGateLines(miqra, MIQRA_SCRIPTS), [gateLine("npm run verify:visual", ["npm test", "npm run build", "npm run verify:visual"])]);
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
  const view = (p, scripts, checkout = "/checkouts/miqra") => ({ name: "miqra", title: "Miqra", items: [], inbox: [], policy: p, scripts, checkout });
  const out = formatStatus([view(policy(["npm test"], { postMerge: postMerge([step("deploy", "npm run deploy", { class: "deploy" })]) }), MIQRA_SCRIPTS)]).split("\n");
  assert.equal(out[0], "Miqra (miqra)");
  const at = out.indexOf(`  ${gateLine("npm run verify:visual", ["npm test", "npm run verify:visual"], "/checkouts/miqra")}`);
  assert.ok(at > 0, out.join("\n"));
  assert.ok(at < out.indexOf("  Nothing waiting."), "the warning stands under the project's name");
  // A view that carries no checkout — a project this Mac holds none for —
  // says so rather than suggesting an init with no place to run it.
  const away = formatStatus([view(policy(["npm test"], { postMerge: postMerge([step("deploy", "npm run deploy", { class: "deploy" })]) }), MIQRA_SCRIPTS, null)]).split("\n");
  assert.ok(away.includes(`  ${gateLine("npm run verify:visual", ["npm test", "npm run verify:visual"], null)}`), away.join("\n"));
  // A project whose checks cover its gate, and one with no policy read, say nothing.
  assert.ok(!formatStatus([view(policy(["npm run verify:visual"], { postMerge: postMerge([step("deploy", "npm run deploy", { class: "deploy" })]) }), MIQRA_SCRIPTS)]).includes("Deploy gate"));
  assert.ok(!formatStatus([view(null, null)]).includes("Deploy gate"));
});

// `atelier status` itself, against a stand-in server and a checkout on disk:
// the policy from the server, the scripts from the checkout.
async function runStatus(t, serverPolicy, scripts, projects = null) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-gate-status-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const checkout = join(dir, "checkout"), cache = join(dir, "cache");
  mkdirSync(checkout);
  mkdirSync(cache);
  if (scripts) writeFileSync(join(checkout, "package.json"), JSON.stringify({ scripts }));
  const registered = projects ?? { demo: { path: checkout, branch: "main" } };
  writeFileSync(join(dir, "config.json"), JSON.stringify({ server: "x", owner: "owner", projects: registered }));
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
  return { code, output, checkout };
}

test("atelier status names the deploy command under the project, with the init run in its checkout", async (t) => {
  const p = policy(["npm test"], { postMerge: postMerge([step("deploy", "npm run deploy", { class: "deploy" })]) });
  const r = await runStatus(t, p, MIQRA_SCRIPTS);
  assert.equal(r.code, 0, r.output);
  assert.ok(r.output.includes(`  ${gateLine("npm run verify:visual", ["npm test", "npm run verify:visual"], r.checkout)}`), r.output);
  assert.ok(r.output.includes("Demo (demo)"), r.output);
});

test("atelier status says a project with no checkout here cannot take the init it suggests", async (t) => {
  // A policy whose own commands name the gap (a post-merge check step), which
  // needs no package.json to read.
  const p = policy(["npm test"], { postMerge: postMerge([step("e2e", "npm run e2e", { class: "check" })]) });
  const r = await runStatus(t, p, null, {});
  assert.equal(r.code, 0, r.output);
  assert.ok(r.output.includes(`  ${gateLine("npm run e2e", ["npm test", "npm run e2e"], null)}`), r.output);
});

test("atelier status says nothing when the required checks cover the gate", async (t) => {
  const p = policy(["npm test", "npm run verify:visual"], { postMerge: postMerge([step("deploy", "npm run deploy", { class: "deploy" })]) });
  const r = await runStatus(t, p, MIQRA_SCRIPTS);
  assert.equal(r.code, 0, r.output);
  assert.ok(!r.output.includes("Deploy gate"), r.output);
});

// The command the warning suggests, run whole from another project's
// checkout: init records the checks of the project the warning named, not of
// the project whose folder the command ran from. init reads the project from
// the checkout it runs in (initName) and from no flag, so the suggestion must
// cd into the named project's checkout first; a bare `atelier init --check
// … --project NAME`, run from another registered checkout, would replace that
// other project's checks.
test("the init the warning suggests, run from another project's checkout, records the project it names", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-gate-init-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const GIT = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@x.test", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@x.test" };
  const repo = (path, files) => {
    mkdirSync(path, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", path], { env: GIT });
    for (const [name, text] of files) writeFileSync(join(path, name), text);
    execFileSync("git", ["add", "."], { cwd: path, env: GIT });
    execFileSync("git", ["commit", "-q", "-m", "first"], { cwd: path, env: GIT });
    return path;
  };
  const demo = repo(join(dir, "demo"), [["package.json", JSON.stringify({ scripts: MIQRA_SCRIPTS })], ["a.txt", "one\n"]]);
  const other = repo(join(dir, "other"), [["package.json", JSON.stringify({ scripts: { test: "node --test" } })]]);
  // The server's baseline of demo is a bare repository holding the same
  // commit, so the init the warning suggests records the policy and pushes
  // nothing.
  const baseline = join(dir, "baseline.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", baseline], { env: GIT });
  execFileSync("git", ["push", "-q", baseline, "main"], { cwd: demo, env: GIT });
  const cache = join(dir, "cache");
  mkdirSync(cache);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ server: "x", owner: "owner", projects: { demo: { path: demo, branch: "main" }, other: { path: other, branch: "main" } } }));
  // `atelier` on PATH, as the suggested command spells it.
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "atelier"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`, { mode: 0o755 });
  const demoPolicy = policy(["npm test"], { postMerge: postMerge([step("deploy", "npm run deploy", { class: "deploy" })]) });
  const otherPolicy = policy(["npm test"]);
  const puts = [];
  const server = createServer((req, res) => {
    const answer = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    let text = "";
    req.on("data", (chunk) => text += chunk);
    req.on("end", () => {
      const put = req.method === "PUT" ? /^\/api\/projects\/(\w+)$/.exec(req.url) : null;
      if (put) {
        const body = JSON.parse(text);
        puts.push({ name: put[1], body });
        return answer(200, { project: { name: put[1], repo: put[1], policy: { checks: Array.isArray(body.checks) ? body.checks : [], protected: [] } }, baseline: { remote: baseline, token: "test-token" } });
      }
      if (req.url === "/api/version") return answer(200, { capabilities: SERVER_CAPABILITIES });
      if (req.url === "/api/projects") return answer(200, [
        { name: "demo", title: "Demo", repo: "demo", policy: demoPolicy },
        { name: "other", title: "Other", repo: "other", policy: otherPolicy },
      ]);
      if (req.url === "/api/inbox") return answer(200, []);
      if (req.url === "/api/projects/demo") return answer(200, { project: { name: "demo", title: "Demo", repo: "demo", policy: demoPolicy }, items: [], events: [] });
      if (req.url === "/api/projects/other") return answer(200, { project: { name: "other", title: "Other", repo: "other", policy: otherPolicy }, items: [], events: [] });
      return answer(404, { error: "not_found", detail: "no such route" });
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const env = { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_CACHE: cache, ATELIER_TOKEN: "test-token", ATELIER_ACTOR: "owner", ATELIER_SERVER: `http://127.0.0.1:${server.address().port}` };
  // spawn, never spawnSync: the stand-in server lives in this process, and a
  // synchronous spawn would block the event loop that has to answer it.
  const run = (command, argv, opts) => new Promise((resolve) => {
    const child = spawn(command, argv, opts);
    let stdout = "", stderr = "";
    child.stdout.on("data", (s) => stdout += s);
    child.stderr.on("data", (s) => stderr += s);
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  const status = await run(process.execPath, [cli, "status"], { cwd: dir, env });
  assert.equal(status.code, 0, `${status.stdout}\n${status.stderr}`);
  // The warning names the command, and its init names demo's checkout: the
  // path the local config holds, and never a --project flag.
  const line = status.stdout.split("\n").find((l) => l.includes("Deploy gate:"));
  assert.ok(line, status.stdout);
  assert.equal(line, `  ${gateLine("npm run verify:visual", ["npm test", "npm run verify:visual"], demo)}`, status.stdout);
  const suggested = /add it with (.+)\.$/.exec(line)?.[1];
  assert.ok(suggested?.startsWith(`cd ${JSON.stringify(demo)} && atelier init --check `), suggested);
  // Run exactly what was printed, from the other project's checkout.
  const applied = await run("/bin/sh", ["-c", suggested], { cwd: other, env: { ...env, PATH: `${join(dir, "bin")}:${process.env.PATH}` } });
  assert.equal(applied.code, 0, `${applied.stdout}\n${applied.stderr}`);
  assert.equal(puts.length, 1, JSON.stringify(puts));
  assert.equal(puts[0].name, "demo", "the init recorded demo's checks, not other's");
  assert.deepEqual(puts[0].body.checks, ["npm test", "npm run verify:visual"]);
  assert.match(applied.stdout, /Checks:     npm test \| npm run verify:visual/);
});
